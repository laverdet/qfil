/**
 * Turns a parsed filter into a function, by walking its syntax with a runtime.
 *
 * The compiler itself knows only what binds names: variables, function definitions and their
 * parameters, `as`, `reduce`, `foreach`, labels. Every other construct is handed, as syntax, to the
 * runtime's handler for it, which asks back for whatever it needs of the node's children — as a
 * value, as a stream, as a path — and returns the filter. A library function is called the same way
 * with the syntax of its arguments. Nothing is rendered that nobody asked for.
 *
 * Bindings live in an environment threaded through every filter, a linked list innermost-first;
 * a reference is resolved here to a distance along it. A definition is a closure over the
 * environment it was evaluated in, so it may refer to itself and to what enclosed it.
 */
import type * as ast from './ast.js';
import type { Context, Env, Filter, Handled, Handler, Lib, LibFunction, PathFilter, Render, Resumed, Runtime, Single, Stream, Value } from './filter.js';
import { Bounce, Break, CompileError, Tail, abreast, allSingle, driven, each, feed, generator, isStream, isTask, lookup, over, pathCall, product, push, settle, task, unrolled } from './filter.js';

/** A definition: the filters of its body, called with its own frame and its parameters pushed on the environment it closed over. */
interface Definition {
	/** The body with no awaiting filter arguments; `variant` holds the others. */
	readonly value: Filter;
	/** The body for a set of awaiting filter arguments, a '0' or '1' per filter parameter; call sites render what they need at compile time. */
	readonly variant: (params: string) => Filter;
	readonly path: PathFilter;
	readonly pathVariant: (params: string) => PathFilter;
}

/** What a definition is at runtime: the environment it was evaluated in, to be extended per call. */
interface Bound {
	readonly definition: Definition;
	readonly env: Env;
}

/** A filter argument: the argument's forms, closed over the caller's environment. */
interface Closure {
	readonly generator: Stream;
	readonly path: PathFilter;
}

interface BoundClosure {
	readonly closure: Closure;
	readonly env: Env;
}

/** The environments of a call's body, one per combination of value arguments. */
interface Callee {
	(bound: Bound, env: Env, input: Value): Iterable<Env>;
	readonly streams: boolean;
	/** Whether a value argument awaits, making the environments a task's yields. */
	readonly task: boolean;
	/** The awaiting filter arguments, a '0' or '1' per filter parameter: which body variant the call needs. */
	readonly params: string;
}

/** One rendering of a definition's body, for one set of awaiting filter arguments. */
interface Variant {
	/** Undefined while the body is rendered; a self-call then assumes a single value and says so. */
	shape: 'single' | 'stream' | 'task' | undefined;
	assumed: boolean;
	/** Whether a call may come to a `Bounce` or a `Tail`: a tail call was compiled in this body. */
	bouncy: boolean;
	value: Filter | undefined;
}

/** As {@link Variant}, for the path form: all that varies there is whether it awaits. */
interface PathVariant {
	/** Undefined while rendered; a self-call in path mode then assumes it does not await. */
	awaits: boolean | undefined;
	assumed: boolean;
	path: PathFilter | undefined;
}

/** A definition as the compiler sees it: where its frame sits, and its body's renderings. */
interface DefBinding {
	readonly kind: 'def';
	readonly slot: number;
	readonly def: ast.Def;
	/** The body per set of awaiting filter arguments, a '0' or '1' per filter parameter. */
	readonly variants: Map<string, Variant>;
	readonly pathVariants: Map<string, PathVariant>;
	/** Renders the body for a set of awaiting arguments; set by `def` once the body's scope exists. */
	render?: (params: string) => Filter;
	renderPath?: (params: string) => PathFilter;
	/** A prelude definition's one Bound, closed over the root; a call site holds it directly. */
	bound?: Bound;
}

/** A filter parameter: its frame holds a closure. */
interface ParamBinding {
	readonly kind: 'param';
	readonly slot: number;
	/** Whether the argument awaits, in the body variant being rendered. */
	task: boolean;
}

/** A value parameter called as a function: `def f($x): x` reads the variable. */
interface ValueBinding {
	readonly kind: 'value';
	readonly slot: number;
}

type FuncBinding = DefBinding | ParamBinding | ValueBinding;

/**
 * What names mean at a point of the program, and how deep the environment is there. Each binding
 * occupies one frame; a name resolves to the frame's slot, counted from the bottom.
 */
class Scope {
	readonly parent: Scope | null;
	readonly depth: number;
	readonly vars = new Map<string, number>();
	readonly funcs = new Map<string, FuncBinding>();
	readonly labels = new Map<string, number>();

	constructor(parent: Scope | null, depth: number) {
		this.parent = parent;
		this.depth = depth;
	}

	/** A scope one frame deeper. */
	child(): Scope {
		return new Scope(this, this.depth + 1);
	}

	/** A scope one frame deeper, the frame holding a variable. */
	withVariable(name: string): Scope {
		const inner = this.child();
		inner.vars.set(name, this.depth);
		return inner;
	}

	/** The distance from the innermost frame to a frame's slot, as seen from here. */
	distance(slot: number): number {
		return this.depth - 1 - slot;
	}

	variable(name: string): number | undefined {
		return this.vars.get(name) ?? this.parent?.variable(name);
	}

	func(key: string): FuncBinding | undefined {
		return this.funcs.get(key) ?? this.parent?.func(key);
	}

	label(name: string): number | undefined {
		return this.labels.get(name) ?? this.parent?.label(name);
	}
}

const identity: ast.Identity = { type: 'identity' };

function variable(name: string): ast.Variable {
	return { type: 'variable', name, at: 0 };
}

function index(target: ast.Node, key: ast.Node): ast.Index {
	return { type: 'index', target, key };
}

function bind(source: ast.Node, name: string, body: ast.Node): ast.Bind {
	return { type: 'bind', source, patterns: [ { type: 'variable', name } ], body };
}

/** The one plain variable a binding's patterns amount to, when they do; any other pattern is desugared first. */
function simplePattern(patterns: readonly ast.Pattern[]): ast.VariablePattern | undefined {
	const pattern = patterns[0]!;
	return patterns.length === 1 && pattern.type === 'variable' ? pattern : undefined;
}

/** The shape of a rendered filter: what a self-call must be compiled to match. */
function shapeOf(filter: Filter): 'single' | 'stream' | 'task' {
	if (isTask(filter)) {
		return 'task';
	} else if (isStream(filter)) {
		return 'stream';
	}
	return 'single';
}

/** A definition's body over one environment of a call: its value, or each of its stream. */
function *invoke(body: Filter, input: Value, frames: Env): Generator<Value, void, Resumed> {
	if (isStream(body)) {
		yield* body(input, frames);
	} else {
		yield body(input, frames);
	}
}

/** As {@link invoke}, for a bouncy definition: its tail calls followed here, on this one frame. */
function *settling(body: Filter, input: Value, frames: Env): Generator<Value, void, Resumed> {
	if (isStream(body)) {
		yield* unrolled(() => body(input, frames));
	} else {
		yield settle(body(input, frames));
	}
}

/**
 * `reduce`, over whatever its state is — a value, or a path and the value at it. `items` runs
 * afresh for each initial state; each item is pushed on the environment the update runs in, and
 * the update's last output is the next state, `none` when it has none.
 */
function *reduce<State>(inits: Iterable<State>, items: () => Iterable<Value>, env: Env, update: (state: State, bound: Env) => Iterable<State>, none: () => State): Generator<State, void, Resumed> {
	for (const init of inits) {
		let state = init;
		for (const item of items()) {
			const bound = push(env, item);
			let empty = true;
			for (const output of update(state, bound)) {
				state = output;
				empty = false;
			}
			if (empty) {
				state = none();
			}
		}
		yield state;
	}
}

/** As {@link reduce}, over streams that may await: their instructions passed along. */
function *taskReduce<State>(inits: Iterable<State>, items: () => Iterable<Value>, env: Env, update: (state: State, bound: Env) => Iterable<State>, none: () => State): Generator<State, void, Resumed> {
	yield* each(inits, function*(init) {
		let state = init;
		yield* each(items(), function*(item) {
			const bound = push(env, item);
			const outputs = yield* feed(update(state, bound), output => {
				state = output;
			});
			if (outputs === 0) {
				state = none();
			}
		});
		yield state;
	});
}

/** `foreach`, as {@link reduce}: every output of the update is a state, and is yielded, through the extract when there is one. */
function *foreach<State>(inits: Iterable<State>, items: () => Iterable<Value>, env: Env, update: (state: State, bound: Env) => Iterable<State>, extract: ((state: State, bound: Env) => Iterable<State>) | null): Generator<State, void, Resumed> {
	for (const init of inits) {
		let state = init;
		for (const item of items()) {
			const bound = push(env, item);
			for (const output of update(state, bound)) {
				state = output;
				if (extract === null) {
					yield output;
				} else {
					yield* extract(output, bound);
				}
			}
		}
	}
}

/** As {@link foreach}, over streams that may await: their instructions passed along. */
function *taskForeach<State>(inits: Iterable<State>, items: () => Iterable<Value>, env: Env, update: (state: State, bound: Env) => Iterable<State>, extract: ((state: State, bound: Env) => Iterable<State>) | null): Generator<State, void, Resumed> {
	yield* each(inits, function*(init) {
		let state = init;
		yield* each(items(), function*(item) {
			const bound = push(env, item);
			yield* each(update(state, bound), function*(output) {
				state = output;
				if (extract === null) {
					yield output;
				} else {
					yield* extract(output, bound);
				}
			});
		});
	});
}

/** Every variable a pattern binds. */
function patternVariables(pattern: ast.Pattern, into: string[] = []): string[] {
	switch (pattern.type) {
		case 'variable':
			into.push(pattern.name);
			break;
		case 'array':
			for (const element of pattern.elements) {
				patternVariables(element, into);
			}
			break;
		case 'object':
			for (const entry of pattern.entries) {
				if (entry.bind !== null) {
					into.push(entry.bind);
				}
				if (entry.pattern !== null) {
					patternVariables(entry.pattern, into);
				}
			}
			break;
	}
	return into;
}

/** A compiled program: a function of its input, and its shape. */
export interface Program {
	/** The outputs: one value, an iteration, or an async iteration, as `stream` and `awaits` say. */
	readonly filter: (input: Value) => Value;
	readonly stream: boolean;
	/** Whether the program awaits: its filter is then an async iteration, each output settled as it comes. */
	readonly awaits: boolean;
}

export function instantiate(source: string, program: ast.Node, runtime: Runtime, lib: Lib, ctx: Context): Program {
	return new Compiler(source, runtime, lib, ctx).program(program);
}

class Compiler {
	private readonly source: string;
	private readonly rt: Runtime;
	private readonly lib: Lib;
	private readonly ctx: Context;
	private synthetics = 0;
	/** The body variant being rendered: whom a compiled tail call makes bouncy. */
	private rendering: Variant | null = null;
	private readonly preludeBindings = new Map<ast.Def, DefBinding>();

	constructor(source: string, runtime: Runtime, lib: Lib, ctx: Context) {
		this.source = source;
		this.rt = runtime;
		this.lib = lib;
		this.ctx = ctx;
	}

	program(node: ast.Node): Program {
		const filter = this.value(node, new Scope(null, 0));
		if (isStream(filter)) {
			if (isTask(filter)) {
				return {
					async *filter(input) {
						yield* driven(filter(input, null));
					},
					awaits: true,
					stream: true,
				};
			} else {
				return {
					*filter(input) {
						yield* filter(input, null);
					},
					awaits: false,
					stream: true,
				};
			}
		} else {
			return { filter: input => filter(input, null), stream: false, awaits: false };
		}
	}

	// -- Rendering --

	/** A node's value form: what the runtime says it is, or a binding form of the compiler's own; `tail` says its outputs are a definition's own last. */
	value(node: ast.Node, scope: Scope, tail = false): Filter {
		switch (node.type) {
			case 'variable':
				return this.variable(node, scope);
			case 'call':
				return this.call(node, scope, tail);
			case 'def':
				return this.def(node, scope, inner => this.value(node.rest, inner, tail), this.rest);
			case 'bind':
				return this.bind(node, scope, tail);
			case 'reduce':
				return this.reduce(node, scope);
			case 'foreach':
				return this.foreach(node, scope);
			case 'label':
				return this.label(node, scope);
			case 'break':
				return this.breakOut(node, scope);
			case 'identity': case 'recurse': case 'literal': case 'string': case 'format': case 'index': case 'slice': case 'iterate': case 'try':
			case 'pipe': case 'comma': case 'binary': case 'and': case 'or': case 'alternative': case 'negate': case 'assign': case 'if': case 'loc': case 'array': case 'object':
				return this.handler(node).value(node, this.renderer(scope, tail));
		}
	}

	generator(node: ast.Node, scope: Scope): Stream {
		return generator(this.value(node, scope));
	}

	/** A node's path form; a construct with none is invalid there, and its values name the error. */
	path(node: ast.Node, scope: Scope): PathFilter {
		switch (node.type) {
			case 'call':
				return this.pathCall(node, scope);
			case 'def':
				return this.def(node, scope, inner => this.path(node.rest, inner), this.restPath);
			case 'bind':
				return this.pathBind(node, scope);
			case 'label':
				return this.pathLabel(node, scope);
			case 'reduce':
				return this.pathReduce(node, scope);
			case 'foreach':
				return this.pathForeach(node, scope);
			case 'variable': case 'break':
				return this.invalid(this.value(node, scope));
			case 'identity': case 'recurse': case 'literal': case 'string': case 'format': case 'index': case 'slice': case 'iterate': case 'try':
			case 'pipe': case 'comma': case 'binary': case 'and': case 'or': case 'alternative': case 'negate': case 'assign': case 'if': case 'loc': case 'array': case 'object': {
				const handler = this.handler(node);
				return handler.path === undefined
					? this.invalid(handler.value(node, this.renderer(scope)))
					: handler.path(node, this.renderer(scope));
			}
		}
	}

	// -- The runtime --

	private handler(node: Handled): Handler<Handled> {
		// Each handler takes its own node type; the switch that reaches here has matched them up
		return this.rt[node.type] as Handler<Handled>;
	}

	private renderer(scope: Scope, tail = false): Render {
		return {
			value: node => this.strict(this.value(node, scope), node.at),
			generator: node => this.strict(this.generator(node, scope), node.at),
			path: node => this.path(node, scope),
			invalid: filter => this.invalid(filter),
			filter: node => this.value(node, scope),
			last: node => this.value(node, scope, tail),
		};
	}

	/** Guards a place compiled to run a stream as plain values: a task there would leak its awaits. */
	private strict<Fn extends Filter>(filter: Fn, at?: number): Fn {
		if (isTask(filter)) {
			throw this.error('a filter that awaits is not supported here', at);
		}
		return filter;
	}

	/** A filter that is not a path expression, as a path filter: each value it yields is the runtime's invalid path. */
	private invalid(filter: Filter): PathFilter {
		const { invalidPath } = this.rt;
		const stream = generator(filter);
		if (isTask(stream)) {
			return task(function*(_path, value, env) {
				yield* each(stream(value, env), function*(output) {
					yield invalidPath(output);
				});
			});
		}
		return function*(_path, value, env) {
			for (const output of stream(value, env)) {
				yield invalidPath(output);
			}
		};
	}

	// -- Names --

	private error(message: string, at: number | undefined): CompileError {
		if (at === undefined) {
			return new CompileError(message);
		}
		const line = this.source.slice(0, at).split('\n').length;
		const column = at - this.source.lastIndexOf('\n', at - 1);
		return new CompileError(`${message} at line ${line}, column ${column}`, at);
	}

	/** A fresh variable name no program can spell, for desugaring. */
	private synthetic(): string {
		return `*${++this.synthetics}`;
	}

	private variable(node: ast.Variable, scope: Scope): Filter {
		const slot = scope.variable(node.name);
		if (slot !== undefined) {
			const distance = scope.distance(slot);
			return (_input, env) => lookup(env, distance);
		} else if (node.name === 'ENV') {
			const env = this.ctx.env;
			return () => env;
		} else if (!Object.hasOwn(this.ctx.args, node.name)) {
			throw this.error(`$${node.name} is not defined`, node.at);
		}
		const value = this.ctx.args[node.name]!;
		return () => value;
	}

	/** A call's binding: a definition in scope, the prelude definition the parse resolved, else a library function whose parameters fit the call. */
	private lookupFunction(node: ast.Call, scope: Scope): FuncBinding | LibFunction {
		const key = `${node.name}/${node.args.length}`;
		const local = scope.func(key);
		if (local !== undefined) {
			return local;
		}
		const target = node.target;
		if (target !== undefined && 'type' in target) {
			// Resolved at parse to a definition no frame of the program holds: the prelude's
			return this.preludeBinding(target);
		}
		const fn = this.lib[node.name];
		if (fn === undefined || (fn.length !== 0 && fn.length !== node.args.length + 1)) {
			throw this.error(`${key} is not defined`, node.at);
		}
		return fn;
	}

	/**
	 * A definition of the prelude, reached through a call's parse-time resolution. The prelude's
	 * definitions enclose every program — the program's own shadow them, being closer — but they
	 * occupy no environment frames and cost nothing until referenced: a binding is made lazily per
	 * definition, closed over the root, so a call site holds its one Bound directly. Sequential
	 * visibility is the parse's own: a body's calls were resolved against the definitions above
	 * it, and itself, when the prelude's source was parsed.
	 */
	private preludeBinding(def: ast.Def): DefBinding {
		const existing = this.preludeBindings.get(def);
		if (existing !== undefined) {
			return existing;
		}
		const { binding, definition } = this.definition(def, new Scope(null, 0));
		binding.bound = { definition, env: null };
		this.preludeBindings.set(def, binding);
		return binding;
	}

	/** A library function applied to a call's syntax; a compile error it raises is placed at the call. */
	private libCall<Result>(node: ast.Call, apply: () => Result): Result {
		try {
			return apply();
		} catch (error) {
			if (error instanceof CompileError && error.at === undefined) {
				throw this.error(`${node.name}/${node.args.length}: ${error.message}`, node.at);
			}
			throw error;
		}
	}

	// -- Calls --

	private call(node: ast.Call, scope: Scope, tail = false): Filter {
		const binding = this.lookupFunction(node, scope);
		if (typeof binding === 'function') {
			return this.libCall(node, () => binding.call(this.ctx, this.renderer(scope), ...node.args));
		}
		const distance = scope.distance(binding.slot);
		switch (binding.kind) {
			case 'value':
				return (_input, env) => lookup(env, distance);
			case 'param': {
				const site: Stream = function*(input, env) {
					const bound = lookup(env, distance) as BoundClosure;
					yield* bound.closure.generator(input, bound.env);
				};
				return binding.task ? task(site) : site;
			}
			case 'def':
				return this.callDef(binding, node, scope, tail);
		}
	}

	private pathCall(node: ast.Call, scope: Scope): PathFilter {
		const binding = this.lookupFunction(node, scope);
		if (typeof binding === 'function') {
			return this.libCall(node, () => pathCall(binding, this.ctx, this.renderer(scope), node.args));
		}
		const distance = scope.distance(binding.slot);
		switch (binding.kind) {
			case 'value':
				return this.invalid(this.call(node, scope));
			case 'param': {
				const site: PathFilter = function*(path, value, env) {
					const bound = lookup(env, distance) as BoundClosure;
					yield* bound.closure.path(path, value, bound.env);
				};
				return binding.task ? task(site) : site;
			}
			case 'def': {
				const at = this.boundOf(binding, scope);
				const callee = this.callee(binding, node, scope);
				const variant = this.pathVariant(binding, callee.params);
				if (variant.awaits === undefined) {
					// The variant's own path form is being rendered: assume it does not await
					variant.assumed = true;
				}
				const paths = callee.params.includes('1')
					? (bound: Bound) => bound.definition.pathVariant(callee.params)
					: (bound: Bound) => bound.definition.path;
				const called: PathFilter = callee.task
					? function*(path, value, env) {
						const bound = at(env);
						yield* each(callee(bound, env, value), function*(frames) {
							yield* paths(bound)(path, value, frames);
						});
					}
					: function*(path, value, env) {
						const bound = at(env);
						for (const frames of callee(bound, env, value)) {
							yield* paths(bound)(path, value, frames);
						}
					};
				return callee.task || variant.awaits === true ? task(called) : called;
			}
		}
	}

	/** The body variant a call's awaiting filter arguments select, rendered on first need. */
	private variant(binding: DefBinding, params: string): Variant {
		const existing = binding.variants.get(params);
		if (existing !== undefined) {
			return existing;
		}
		if (binding.render === undefined) {
			throw new Error('Impossible: a call before its definition was reached');
		}
		binding.render(params);
		return binding.variants.get(params)!;
	}

	/** As {@link variant}, for the path form. */
	private pathVariant(binding: DefBinding, params: string): PathVariant {
		const existing = binding.pathVariants.get(params);
		if (existing !== undefined) {
			return existing;
		}
		if (binding.renderPath === undefined) {
			throw new Error('Impossible: a call before its definition was reached');
		}
		binding.renderPath(params);
		return binding.pathVariants.get(params)!;
	}

	/** How a call site reaches a definition's Bound: held directly for a prelude definition, looked up the environment otherwise. */
	private boundOf(binding: DefBinding, scope: Scope): (env: Env) => Bound {
		const constant = binding.bound;
		if (constant !== undefined) {
			return () => constant;
		}
		const distance = scope.distance(binding.slot);
		return env => lookup(env, distance) as Bound;
	}

	/** A call to a definition: its frame, then each argument, pushed on the environment it closed over. */
	private callDef(binding: DefBinding, node: ast.Call, scope: Scope, tail: boolean): Filter {
		const at = this.boundOf(binding, scope);
		const callee = this.callee(binding, node, scope);
		const variant = this.variant(binding, callee.params);
		const body = callee.params.includes('1')
			? (bound: Bound) => bound.definition.variant(callee.params)
			: (bound: Bound) => bound.definition.value;
		if (variant.shape === undefined) {
			// The variant's own body is being rendered: assume a single value, and be told if not
			variant.assumed = true;
		}
		if (tail && !callee.streams && (variant.shape === undefined || variant.bouncy)) {
			// A tail call into a recursion: hand the consumer the next step instead of taking a
			// stack frame for it. The variant being rendered is bouncy now — its non-tail call
			// sites follow the chain, each on its one frame.
			const rendering = this.rendering ?? function(): never {
				throw new Error('Impossible: a tail call outside a definition');
			}();
			rendering.bouncy = true;
			if (variant.shape === undefined || variant.shape === 'single') {
				return (input, env) => {
					const bound = at(env);
					const [ frames ] = callee(bound, env, input);
					// Single-valued, as the shape says
					return Bounce.of(body(bound) as Single, input, frames!);
				};
			}
			return function*(input, env) {
				const bound = at(env);
				const [ frames ] = callee(bound, env, input);
				yield Tail.of(() => (body(bound) as Stream)(input, frames!));
			};
		}
		if (variant.shape === 'stream' || variant.shape === 'task' || callee.streams) {
			const apply = variant.bouncy ? settling : invoke;
			const called = callee.task
				? function*(input: Value, env: Env): Generator<Value, void, Resumed> {
					const bound = at(env);
					yield* each(callee(bound, env, input), function*(frames) {
						yield* apply(body(bound), input, frames);
					});
				}
				: function*(input: Value, env: Env): Generator<Value, void, Resumed> {
					const bound = at(env);
					for (const frames of callee(bound, env, input)) {
						yield* apply(body(bound), input, frames);
					}
				};
			return variant.shape === 'task' || callee.task ? task(called) : called;
		}
		if (variant.bouncy) {
			return (input, env) => {
				const bound = at(env);
				const [ frames ] = callee(bound, env, input);
				return settle((body(bound) as Single)(input, frames!));
			};
		}
		return (input, env) => {
			const bound = at(env);
			const [ frames ] = callee(bound, env, input);
			// Settled as single-valued above, once the body was rendered
			return (body(bound) as Single)(input, frames!);
		};
	}

	/**
	 * The environments a definition's body runs in for a call: the definition's frame (so that it
	 * may recurse), then a frame per parameter — a closure over the caller's environment for a
	 * filter parameter, a value for a `$` parameter. There is one environment per combination of
	 * the value arguments' outputs, the first varying slowest, which is jq's cartesian call;
	 * `streams` says whether there can be more than one.
	 */
	private callee(binding: DefBinding, node: ast.Call, scope: Scope): Callee {
		const filters: Filter[] = [];
		let params = '';
		const frames = binding.def.params.map((param, ii): (env: Env, values: Value[]) => unknown => {
			const arg = node.args[ii]!;
			if (!param.value) {
				const passed = this.passedParam(arg, scope);
				if (passed !== undefined) {
					// `f(g)` where `g` is itself a parameter: the caller's closure passes through
					// unwrapped, so a recursion hands the same closure all the way down
					params += passed.task ? '1' : '0';
					const distance = scope.distance(passed.slot);
					return env => lookup(env, distance);
				}
				const closure = this.closure(arg, scope);
				params += isTask(closure.generator) ? '1' : '0';
				return env => ({ closure, env } satisfies BoundClosure);
			}
			const position = filters.push(this.value(arg, scope)) - 1;
			return (_env, values) => values[position];
		});
		const build = (bound: Bound, env: Env, values: Value[]): Env => {
			let callee: Env = push(bound.env, bound);
			for (const frame of frames) {
				callee = push(callee, frame(env, values));
			}
			return callee;
		};
		// Aliased past the `if`: the predicate's negation narrows to never, a single's `unknown` return subsuming a stream's
		const mixed: readonly Filter[] = filters;
		if (allSingle(filters)) {
			const singles: readonly Single[] = filters;
			const callee = (bound: Bound, env: Env, input: Value): Env[] => [ build(bound, env, singles.map(filter => filter(input, env))) ];
			return Object.assign(callee, { streams: false, task: false, params });
		}
		const streams = mixed.map(generator);
		const awaits = mixed.some(isTask);
		const callee = awaits
			? function*(bound: Bound, env: Env, input: Value): Generator<Env, void, Resumed> {
				yield* each(product(streams, input, env, 'first'), function*(values) {
					yield build(bound, env, values);
				});
			}
			: function*(bound: Bound, env: Env, input: Value): Generator<Env, void, Resumed> {
				for (const values of product(streams, input, env, 'first')) {
					yield build(bound, env, values);
				}
			};
		return Object.assign(callee, { streams: true, task: awaits, params });
	}

	/** The filter parameter a zero-argument call names, when the argument is exactly that. */
	private passedParam(arg: ast.Node, scope: Scope): ParamBinding | undefined {
		if (arg.type !== 'call' || arg.args.length > 0) {
			return undefined;
		}
		const found = scope.func(`${arg.name}/0`);
		return found?.kind === 'param' ? found : undefined;
	}

	/** A filter argument's forms. The path form is rendered when first asked for, which is usually never. */
	private closure(arg: ast.Node, scope: Scope): Closure {
		const render = this.renderer(scope);
		let path: PathFilter | undefined;
		return {
			generator: generator(render.filter(arg)),
			get path() {
				path ??= render.path(arg);
				return path;
			},
		};
	}

	// -- Definitions --

	/**
	 * `def name(params): body; rest`. The body is rendered once, in a scope where its own frame
	 * comes first and its parameters follow; evaluating the definition pushes a closure over the
	 * current environment and runs the rest. `body` renders the rest in the extended scope, and
	 * `assemble` puts the two together.
	 */
	private def<Result>(node: ast.Def, scope: Scope, rest: (inner: Scope, definition: Definition) => Result, assemble: (rest: Result, definition: Definition) => Result): Result {
		const { inner, definition } = this.definition(node, scope);
		return assemble(rest(inner, definition), definition);
	}

	/**
	 * A definition's machinery, apart from where it sits — its binding, the scope its body renders
	 * in, the lazy renderings — so `def` may nest it over a rest and the prelude may table it at
	 * the root.
	 */
	private definition(node: ast.Def, scope: Scope): { inner: Scope; binding: DefBinding; definition: Definition } {
		const key = `${node.name}/${node.params.length}`;
		const binding: DefBinding = { kind: 'def', slot: scope.depth, def: node, variants: new Map(), pathVariants: new Map() };
		const inner = scope.child();
		inner.funcs.set(key, binding);
		const filterParams: ParamBinding[] = [];
		let bodyScope = inner;
		for (const param of node.params) {
			const slot = bodyScope.depth;
			bodyScope = bodyScope.child();
			if (param.value) {
				bodyScope.vars.set(param.name, slot);
				bodyScope.funcs.set(`${param.name}/0`, { kind: 'value', slot });
			} else {
				const paramBinding: ParamBinding = { kind: 'param', slot, task: false };
				filterParams.push(paramBinding);
				bodyScope.funcs.set(`${param.name}/0`, paramBinding);
			}
		}
		// A variant renders with each filter parameter told whether its argument awaits; renders
		// nest — a self-call may need another variant mid-render — so the flags are restored after
		const withParams = <Type>(params: string, render: () => Type): Type => {
			const saved = filterParams.map(param => param.task);
			filterParams.forEach((param, ii) => {
				param.task = params[ii] === '1';
			});
			try {
				return render();
			} finally {
				filterParams.forEach((param, ii) => {
					param.task = saved[ii]!;
				});
			}
		};
		const renderBody = (params: string): Filter => {
			const variant: Variant = { shape: undefined, assumed: false, bouncy: false, value: undefined };
			binding.variants.set(params, variant);
			return withParams(params, () => {
				const outer = this.rendering;
				this.rendering = variant;
				// The body itself is the definition's last act: a recursive call there is a tail call
				let value = this.value(node.body, bodyScope, true);
				if (variant.assumed && (shapeOf(value) !== 'single' || variant.bouncy)) {
					// A self-call assumed a single, non-bouncy body and it is not that: settle and render again
					variant.shape = shapeOf(value);
					value = this.value(node.body, bodyScope, true);
				}
				variant.shape = shapeOf(value);
				variant.value = value;
				this.rendering = outer;
				return value;
			});
		};
		const renderPath = (params: string): PathFilter => {
			const variant: PathVariant = { awaits: undefined, assumed: false, path: undefined };
			binding.pathVariants.set(params, variant);
			return withParams(params, () => {
				let path = this.path(node.body, bodyScope);
				if (variant.assumed && isTask(path)) {
					// A self-call in path mode assumed no awaiting and there is some: render again
					variant.awaits = true;
					path = this.path(node.body, bodyScope);
				}
				variant.awaits = isTask(path);
				variant.path = path;
				return path;
			});
		};
		binding.render = renderBody;
		binding.renderPath = renderPath;
		const base = '0'.repeat(filterParams.length);
		const valueOf = (params: string): Filter => this.variant(binding, params).value ?? function(): never {
			throw new Error('Impossible: an unrendered variant');
		}();
		const pathOf = (params: string): PathFilter => this.pathVariant(binding, params).path ?? function(): never {
			throw new Error('Impossible: an unrendered path variant');
		}();
		let value: Filter | undefined;
		const definition: Definition = {
			// The body is rendered when a call first asks for it, which for an unused definition is never
			get value() {
				value ??= valueOf(base);
				return value;
			},
			variant: valueOf,
			// The path form of the body is rendered when a call in path mode first asks for it
			get path() {
				return pathOf(base);
			},
			pathVariant: pathOf,
		};
		return { inner, binding, definition };
	}

	private readonly rest = (rest: Filter, definition: Definition): Filter => {
		if (isStream(rest)) {
			const defined: Stream = function*(input, env) {
				yield* rest(input, push(env, { definition, env } satisfies Bound));
			};
			return isTask(rest) ? task(defined) : defined;
		}
		return (input, env) => rest(input, push(env, { definition, env } satisfies Bound));
	};

	private readonly restPath = (rest: PathFilter, definition: Definition): PathFilter => {
		const defined: PathFilter = function*(path, value, env) {
			yield* rest(path, value, push(env, { definition, env } satisfies Bound));
		};
		return isTask(rest) ? task(defined) : defined;
	};

	// -- Binding forms --

	/**
	 * `source as $x | body`, once destructuring has been desugared to plain variables: each output
	 * of the source is pushed on the environment the body runs in.
	 */
	private bind(node: ast.Bind, scope: Scope, tail: boolean): Filter {
		const desugared = this.desugar(node);
		if (desugared !== node) {
			return this.value(desugared, scope, tail);
		}
		const source = this.value(node.source, scope);
		const inner = scope.withVariable(simplePattern(node.patterns)!.name);
		const body = this.value(node.body, inner, tail && !isStream(source));
		if (!isStream(source) && !isStream(body)) {
			return (input, env) => body(input, push(env, source(input, env)));
		}
		const bodies = generator(body);
		const bound = function*(value: Value, input: Value, env: Env): Generator<Value, void, Resumed> {
			yield* bodies(input, push(env, value));
		};
		const sources = generator(source);
		return isTask(body) ? abreast(sources, bound) : over(sources, bound);
	}

	private pathBind(node: ast.Bind, scope: Scope): PathFilter {
		const desugared = this.desugar(node);
		if (desugared !== node) {
			return this.path(desugared, scope);
		}
		const sources = this.generator(node.source, scope);
		const inner = scope.withVariable(simplePattern(node.patterns)!.name);
		const body = this.path(node.body, inner);
		const bound: PathFilter = isTask(sources)
			? task(function*(path, value, env) {
				yield* each(sources(value, env), function*(item) {
					yield* body(path, value, push(env, item));
				});
			})
			: function*(path, value, env) {
				for (const item of sources(value, env)) {
					yield* body(path, value, push(env, item));
				}
			};
		return isTask(body) ? task(bound) : bound;
	}

	/**
	 * Destructuring is indexing: `. as [$a, {b: $c}] | body` is `. as $t | $t[0] as $a | $t[1].b as
	 * $c | body`. Alternatives, `?//`, try each pattern in turn, every variable of every pattern in
	 * scope and null unless the matching pattern bound it; an error while matching or in the body
	 * moves on to the next pattern, which is `try` with the original input restored.
	 */
	private desugar(node: ast.Bind): ast.Node {
		if (simplePattern(node.patterns) !== undefined) {
			return node;
		}
		const source = this.synthetic();
		const names = [ ...new Set(node.patterns.flatMap(pattern => patternVariables(pattern))) ];
		const chain = (pattern: ast.Pattern): ast.Node => {
			const steps: [ string, ast.Node ][] = [];
			const collect = (part: ast.Pattern, from: ast.Node): void => {
				switch (part.type) {
					case 'variable':
						steps.push([ part.name, from ]);
						break;
					case 'array':
						part.elements.forEach((element, ii) => collect(element, index(from, { type: 'literal', value: ii })));
						break;
					case 'object':
						for (const entry of part.entries) {
							const member = index(from, entry.key);
							if (entry.bind !== null) {
								steps.push([ entry.bind, member ]);
							}
							if (entry.pattern !== null) {
								collect(entry.pattern, member);
							}
						}
						break;
				}
			};
			collect(pattern, variable(source));
			const bound = new Set(steps.map(([ name ]) => name));
			const all: [ string, ast.Node ][] = [ ...names.filter(name => !bound.has(name)).map((name): [ string, ast.Node ] => [ name, { type: 'literal', value: null } ]), ...steps ];
			return all.reduceRight<ast.Node>((body, [ name, from ]) => bind(from, name, body), node.body);
		};
		if (node.patterns.length === 1) {
			return bind(node.source, source, chain(node.patterns[0]!));
		}
		const input = this.synthetic();
		const attempts = node.patterns.map(chain).reduceRight((next, attempt) => ({
			type: 'try',
			body: attempt,
			handler: { type: 'pipe', left: variable(input), right: next },
		} satisfies ast.Try));
		return bind(identity, input, bind(node.source, source, attempts));
	}

	/** `reduce source as $x (init; update)`: the state, pushed through the update for each output of the source. */
	private reduce(node: ast.Reduce, scope: Scope): Filter {
		const inner = this.itemScope(node, scope);
		if (inner === undefined) {
			return this.value(this.desugarFold(node), scope);
		}
		const inits = this.generator(node.init, scope);
		const sources = this.generator(node.source, scope);
		const updates = this.generator(node.update, inner);
		const awaits = isTask(inits) || isTask(sources) || isTask(updates);
		const fold = awaits ? taskReduce : reduce;
		const folded: Stream = function*(input, env) {
			yield* fold(inits(input, env), () => sources(input, env), env, updates, () => null);
		};
		return awaits ? task(folded) : folded;
	}

	/**
	 * `reduce` as a path expression: the state is a path and the value at it, and the init and the
	 * update are path expressions of it. An update with no output leaves no path, which is invalid.
	 */
	private pathReduce(node: ast.Reduce, scope: Scope): PathFilter {
		const inner = this.itemScope(node, scope);
		if (inner === undefined) {
			return this.path(this.desugarFold(node), scope);
		}
		const inits = this.path(node.init, scope);
		const sources = this.generator(node.source, scope);
		const updates = this.path(node.update, inner);
		const { invalidPath } = this.rt;
		const awaits = isTask(inits) || isTask(sources) || isTask(updates);
		const fold = awaits ? taskReduce : reduce;
		const folded: PathFilter = function*(path, value, env) {
			yield* fold(inits(path, value, env), () => sources(value, env), env, ([ at, state ], bound) => updates(at, state, bound), () => invalidPath(null));
		};
		return awaits ? task(folded) : folded;
	}

	/** `foreach source as $x (init; update; extract)`: every intermediate state, through the extract when there is one. */
	private foreach(node: ast.Foreach, scope: Scope): Filter {
		const inner = this.itemScope(node, scope);
		if (inner === undefined) {
			return this.value(this.desugarFold(node), scope);
		}
		const inits = this.generator(node.init, scope);
		const sources = this.generator(node.source, scope);
		const updates = this.generator(node.update, inner);
		const extracts = node.extract === null ? null : this.generator(node.extract, inner);
		const awaits = isTask(inits) || isTask(sources) || isTask(updates) || (extracts !== null && isTask(extracts));
		const fold = awaits ? taskForeach : foreach;
		const folded: Stream = function*(input, env) {
			yield* fold(inits(input, env), () => sources(input, env), env, updates, extracts);
		};
		return awaits ? task(folded) : folded;
	}

	/** `foreach` as a path expression, as {@link pathReduce}. */
	private pathForeach(node: ast.Foreach, scope: Scope): PathFilter {
		const inner = this.itemScope(node, scope);
		if (inner === undefined) {
			return this.path(this.desugarFold(node), scope);
		}
		const inits = this.path(node.init, scope);
		const sources = this.generator(node.source, scope);
		const updates = this.path(node.update, inner);
		const extracts = node.extract === null ? null : this.path(node.extract, inner);
		const awaits = isTask(inits) || isTask(sources) || isTask(updates) || (extracts !== null && isTask(extracts));
		const fold = awaits ? taskForeach : foreach;
		const folded: PathFilter = function*(path, value, env) {
			yield* fold(
				inits(path, value, env),
				() => sources(value, env),
				env,
				([ at, state ], bound) => updates(at, state, bound),
				extracts === null ? null : ([ at, state ], bound) => extracts(at, state, bound),
			);
		};
		return awaits ? task(folded) : folded;
	}

	/** The scope a fold's update and extract run in, the item bound; undefined when the pattern is one to desugar first. */
	private itemScope(node: ast.Reduce | ast.Foreach, scope: Scope): Scope | undefined {
		const pattern = simplePattern(node.patterns);
		return pattern === undefined ? undefined : scope.withVariable(pattern.name);
	}

	/** A fold over a destructuring pattern binds the item to a variable and destructures that inside. */
	private desugarFold(node: ast.Reduce | ast.Foreach): ast.Node {
		const item = this.synthetic();
		const destructure = (body: ast.Node): ast.Node => ({ type: 'bind', source: variable(item), patterns: node.patterns, body });
		const patterns: ast.VariablePattern[] = [ { type: 'variable', name: item } ];
		if (node.type === 'reduce') {
			return { ...node, patterns, update: destructure(node.update) };
		}
		return { ...node, patterns, update: destructure(node.update), extract: node.extract === null ? null : destructure(node.extract) };
	}

	/** `label $name | body`: a token pushed on the environment, which `break $name` throws and this catches. */
	private label(node: ast.Label, scope: Scope): Filter {
		const inner = scope.child();
		inner.labels.set(node.name, scope.depth);
		const body = this.generator(node.body, inner);
		const labeled: Stream = function*(input, env) {
			const token = {};
			try {
				yield* body(input, push(env, token));
			} catch (error) {
				if (!(error instanceof Break) || error.label !== token) {
					throw error;
				}
			}
		};
		return isTask(body) ? task(labeled) : labeled;
	}

	private pathLabel(node: ast.Label, scope: Scope): PathFilter {
		const inner = scope.child();
		inner.labels.set(node.name, scope.depth);
		const body = this.path(node.body, inner);
		const labeled: PathFilter = function*(path, value, env) {
			const token = {};
			try {
				yield* body(path, value, push(env, token));
			} catch (error) {
				if (!(error instanceof Break) || error.label !== token) {
					throw error;
				}
			}
		};
		return isTask(body) ? task(labeled) : labeled;
	}

	private breakOut(node: ast.Break, scope: Scope): Filter {
		const slot = scope.label(node.name) ?? (() => {
			throw this.error(`$*label-${node.name} is not defined`, node.at);
		})();
		const distance = scope.distance(slot);
		return (_input, env) => {
			throw new Break(lookup(env, distance) as object);
		};
	}
}
