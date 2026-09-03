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
import { Bounce, Break, CompileError, Tail, allSingle, each, feed, generator, isStream, isTask, lookup, over, pathCall, product, push, settle, task, unrolled } from './filter.js';

/** A definition: the filters of its body, called with its own frame and its parameters pushed on the environment it closed over. */
interface Definition {
	readonly value: Filter;
	readonly path: PathFilter;
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
}

/** A definition as the compiler sees it: where its frame sits, and the shape of a call to it. */
interface DefBinding {
	readonly kind: 'def';
	readonly slot: number;
	readonly def: ast.Def;
	/** Undefined while the body is rendered; a self-call then assumes a single value and says so. */
	shape: 'single' | 'stream' | 'task' | undefined;
	assumed: boolean;
	/** Whether a call may come to a `Bounce` or a `Tail`: a tail call was compiled in its body. */
	bouncy: boolean;
}

/** A filter parameter: its frame holds a closure. */
interface ParamBinding {
	readonly kind: 'param';
	readonly slot: number;
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

/** A compiled program: a function of its input, and whether it is a stream. */
export interface Program {
	readonly filter: (input: Value) => Value | Iterable<Value>;
	readonly stream: boolean;
	/** Whether the stream may yield `Await`s: one to run through `drive`, not a plain loop. */
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
	/** The definition whose body is being rendered: whom a compiled tail call makes bouncy. */
	private rendering: DefBinding | null = null;

	constructor(source: string, runtime: Runtime, lib: Lib, ctx: Context) {
		this.source = source;
		this.rt = runtime;
		this.lib = lib;
		this.ctx = ctx;
	}

	program(node: ast.Node): Program {
		const filter = this.value(node, new Scope(null, 0));
		if (isStream(filter)) {
			return { *filter(input) {
				yield* filter(input, null);
			}, stream: true, awaits: isTask(filter) };
		}
		return { filter: input => filter(input, null), stream: false, awaits: false };
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
				return handler.path === undefined ? this.invalid(handler.value(node, this.renderer(scope))) : handler.path(node, this.renderer(scope));
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
			value: node => this.strict(this.value(node, scope)),
			generator: node => this.strict(this.generator(node, scope)),
			path: node => this.path(node, scope),
			invalid: filter => this.invalid(filter),
			filter: node => this.value(node, scope),
			last: node => this.value(node, scope, tail),
		};
	}

	/** Guards a place compiled to run a stream as plain values: a task there would leak its awaits. */
	private strict<Fn extends Filter>(filter: Fn): Fn {
		if (isTask(filter)) {
			throw new CompileError('a filter that awaits is not supported here');
		}
		return filter;
	}

	/** A filter that is not a path expression, as a path filter: each value it yields is the runtime's invalid path. */
	private invalid(filter: Filter): PathFilter {
		const { invalidPath } = this.rt;
		const stream = generator(this.strict(filter));
		return function*(_path, value, env) {
			for (const output of stream(value, env)) {
				yield invalidPath(output);
			}
		};
	}

	// -- Names --

	private error(message: string, at: number): CompileError {
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
			return (_input, env) => lookup(env, distance) as Value;
		} else if (node.name === 'ENV') {
			const env = this.ctx.env;
			return () => env;
		} else if (!Object.hasOwn(this.ctx.args, node.name)) {
			throw this.error(`$${node.name} is not defined`, node.at);
		}
		const value = this.ctx.args[node.name]!;
		return () => value;
	}

	/** A call's binding: a definition in scope, else a library function whose parameters fit the call. */
	private lookupFunction(node: ast.Call, scope: Scope): FuncBinding | LibFunction {
		const key = `${node.name}/${node.args.length}`;
		const local = scope.func(key);
		if (local !== undefined) {
			return local;
		}
		const fn = this.lib[node.name];
		if (fn === undefined || (fn.length !== 0 && fn.length !== node.args.length + 1)) {
			throw this.error(`${key} is not defined`, node.at);
		}
		return fn;
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
				return (_input, env) => lookup(env, distance) as Value;
			case 'param':
				return function*(input, env) {
					const bound = lookup(env, distance) as BoundClosure;
					yield* bound.closure.generator(input, bound.env);
				};
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
			case 'param':
				return function*(path, value, env) {
					const bound = lookup(env, distance) as BoundClosure;
					yield* bound.closure.path(path, value, bound.env);
				};
			case 'def': {
				const callee = this.callee(binding, node, scope);
				if (callee.task) {
					throw this.error('a filter that awaits is not supported here', node.at);
				}
				return function*(path, value, env) {
					const bound = lookup(env, distance) as Bound;
					for (const frames of callee(bound, env, value)) {
						yield* bound.definition.path(path, value, frames);
					}
				};
			}
		}
	}

	/** A call to a definition: its frame, then each argument, pushed on the environment it closed over. */
	private callDef(binding: DefBinding, node: ast.Call, scope: Scope, tail: boolean): Filter {
		const distance = scope.distance(binding.slot);
		const callee = this.callee(binding, node, scope);
		if (binding.shape === undefined) {
			// The definition's own body is being rendered: assume a single value, and be told if not
			binding.assumed = true;
		}
		if (tail && !callee.streams && (binding.shape === undefined || binding.bouncy)) {
			// A tail call into a recursion: hand the consumer the next step instead of taking a
			// stack frame for it. The definition being rendered is bouncy now — its non-tail call
			// sites follow the chain, each on its one frame.
			const rendering = this.rendering ?? function(): never {
				throw new Error('Impossible: a tail call outside a definition');
			}();
			rendering.bouncy = true;
			if (binding.shape === undefined || binding.shape === 'single') {
				return (input, env) => {
					const bound = lookup(env, distance) as Bound;
					const [ frames ] = callee(bound, env, input);
					// Single-valued, as the shape says; a `Bounce` travels as a `Value`
					return new Bounce(bound.definition.value as Single, input, frames!) as unknown as Value;
				};
			}
			return function*(input, env) {
				const bound = lookup(env, distance) as Bound;
				const [ frames ] = callee(bound, env, input);
				yield new Tail(() => (bound.definition.value as Stream)(input, frames!)) as unknown as Value;
			};
		}
		if (binding.shape === 'stream' || binding.shape === 'task' || callee.streams) {
			const apply = binding.bouncy ? settling : invoke;
			const called = callee.task
				? function*(input: Value, env: Env): Generator<Value, void, Resumed> {
					const bound = lookup(env, distance) as Bound;
					const body = bound.definition.value;
					yield* each(callee(bound, env, input), function*(frames) {
						yield* apply(body, input, frames);
					});
				}
				: function*(input: Value, env: Env): Generator<Value, void, Resumed> {
					const bound = lookup(env, distance) as Bound;
					const body = bound.definition.value;
					for (const frames of callee(bound, env, input)) {
						yield* apply(body, input, frames);
					}
				};
			return binding.shape === 'task' || callee.task ? task(called) : called;
		}
		if (binding.bouncy) {
			return (input, env) => {
				const bound = lookup(env, distance) as Bound;
				const [ frames ] = callee(bound, env, input);
				return settle((bound.definition.value as Single)(input, frames!));
			};
		}
		return (input, env) => {
			const bound = lookup(env, distance) as Bound;
			const [ frames ] = callee(bound, env, input);
			// Settled as single-valued above, once the body was rendered
			return (bound.definition.value as Single)(input, frames!);
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
		const frames = binding.def.params.map((param, ii): (env: Env, values: Value[]) => unknown => {
			const arg = node.args[ii]!;
			if (!param.value) {
				const closure = this.closure(arg, scope);
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
		if (allSingle(filters)) {
			const singles: readonly Single[] = filters;
			const callee = (bound: Bound, env: Env, input: Value): Env[] => [ build(bound, env, singles.map(filter => filter(input, env))) ];
			return Object.assign(callee, { streams: false, task: false });
		}
		const streams = filters.map(generator);
		const awaits = filters.some(isTask);
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
		return Object.assign(callee, { streams: true, task: awaits });
	}

	/** A filter argument's forms. The path form is rendered when first asked for, which is usually never. */
	private closure(arg: ast.Node, scope: Scope): Closure {
		const render = this.renderer(scope);
		let path: PathFilter | undefined;
		return {
			generator: render.generator(arg),
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
		const key = `${node.name}/${node.params.length}`;
		const binding: DefBinding = { kind: 'def', slot: scope.depth, def: node, shape: undefined, assumed: false, bouncy: false };
		const inner = scope.child();
		inner.funcs.set(key, binding);
		let bodyScope = inner;
		for (const param of node.params) {
			const slot = bodyScope.depth;
			bodyScope = bodyScope.child();
			if (param.value) {
				bodyScope.vars.set(param.name, slot);
				bodyScope.funcs.set(`${param.name}/0`, { kind: 'value', slot });
			} else {
				bodyScope.funcs.set(`${param.name}/0`, { kind: 'param', slot });
			}
		}
		const outer = this.rendering;
		this.rendering = binding;
		// The body itself is the definition's last act: a recursive call there is a tail call
		let value = this.value(node.body, bodyScope, true);
		if (binding.assumed && (shapeOf(value) !== 'single' || binding.bouncy)) {
			// A self-call assumed a single, non-bouncy body and it is not that: settle and render again
			binding.shape = shapeOf(value);
			value = this.value(node.body, bodyScope, true);
		}
		binding.shape = shapeOf(value);
		this.rendering = outer;
		let path: PathFilter | undefined;
		const render = this.renderer(bodyScope);
		const definition: Definition = {
			value,
			// The path form of the body is rendered when a call in path mode first asks for it
			get path() {
				path ??= render.path(node.body);
				return path;
			},
		};
		return assemble(rest(inner, definition), definition);
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

	private readonly restPath = (rest: PathFilter, definition: Definition): PathFilter =>
		function*(path, value, env) {
			yield* rest(path, value, push(env, { definition, env } satisfies Bound));
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
		const bound = over(generator(source), function*(value, input, env) {
			yield* bodies(input, push(env, value));
		});
		return isTask(body) ? task(bound) : bound;
	}

	private pathBind(node: ast.Bind, scope: Scope): PathFilter {
		const desugared = this.desugar(node);
		if (desugared !== node) {
			return this.path(desugared, scope);
		}
		const sources = this.strict(this.generator(node.source, scope));
		const inner = scope.withVariable(simplePattern(node.patterns)!.name);
		const body = this.path(node.body, inner);
		return function*(path, value, env) {
			for (const bound of sources(value, env)) {
				yield* body(path, value, push(env, bound));
			}
		};
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
		const folded: Stream = function*(input, env) {
			yield* reduce(inits(input, env), () => sources(input, env), env, updates, () => null);
		};
		return [ inits, sources, updates ].some(isTask) ? task(folded) : folded;
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
		const sources = this.strict(this.generator(node.source, scope));
		const updates = this.path(node.update, inner);
		const { invalidPath } = this.rt;
		return function*(path, value, env) {
			yield* reduce(inits(path, value, env), () => sources(value, env), env, ([ at, state ], bound) => updates(at, state, bound), () => invalidPath(null));
		};
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
		const folded: Stream = function*(input, env) {
			yield* foreach(inits(input, env), () => sources(input, env), env, updates, extracts);
		};
		return [ inits, sources, updates, ...extracts === null ? [] : [ extracts ] ].some(isTask) ? task(folded) : folded;
	}

	/** `foreach` as a path expression, as {@link pathReduce}. */
	private pathForeach(node: ast.Foreach, scope: Scope): PathFilter {
		const inner = this.itemScope(node, scope);
		if (inner === undefined) {
			return this.path(this.desugarFold(node), scope);
		}
		const inits = this.path(node.init, scope);
		const sources = this.strict(this.generator(node.source, scope));
		const updates = this.path(node.update, inner);
		const extracts = node.extract === null ? null : this.path(node.extract, inner);
		return function*(path, value, env) {
			yield* foreach(
				inits(path, value, env),
				() => sources(value, env),
				env,
				([ at, state ], bound) => updates(at, state, bound),
				extracts === null ? null : ([ at, state ], bound) => extracts(at, state, bound),
			);
		};
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
		return function*(path, value, env) {
			const token = {};
			try {
				yield* body(path, value, push(env, token));
			} catch (error) {
				if (!(error instanceof Break) || error.label !== token) {
					throw error;
				}
			}
		};
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
