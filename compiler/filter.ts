/**
 * What a compiled program is made of.
 *
 * A filter is a JavaScript function of an input and an environment. Written as a generator
 * function it yields a stream; otherwise it returns exactly one value — that is its whole
 * declaration, and `isStream` reads it off the function. A path filter is the same thing in path
 * mode: given a path and the value at it, it yields `[path, value]` pairs.
 *
 * Nothing is rendered ahead of need. A runtime handler or a library function receives the syntax of
 * its arguments and a `Render`, and asks for each argument in the form it wants — a value, a stream,
 * a path — or reads the syntax itself, as `test("^a")` does to compile its pattern once.
 */
import type * as ast from './ast.js';

/**
 * The values a filter reads and writes: plain JSON as JavaScript already holds it — `null`,
 * booleans, numbers, strings, arrays and objects.
 */
export type Value = null | boolean | number | string | Value[] | ValueObject;

export interface ValueObject {
	[key: string]: Value;
}

/** A path into a value: the keys and indices from the root, as `path(f)` yields them. */
export type Path = Value[];

/** Variables, labels and functions bound so far, innermost first; `null` is nothing bound. */
export type Env = Frame | null;

export interface Frame {
	readonly value: unknown;
	readonly parent: Env;
}

export function push(env: Env, value: unknown): Frame {
	return { value, parent: env };
}

export function lookup(env: Env, distance: number): unknown {
	let frame = env!;
	for (let ii = 0; ii < distance; ++ii) {
		frame = frame.parent!;
	}
	return frame.value;
}

/** A filter of exactly one value. */
export type Single = (input: Value, env: Env) => Value;
/** A filter of any number of values: a generator function. */
export type Stream = (input: Value, env: Env) => Iterable<Value>;
export type Filter = Single | Stream;
export type PathFilter = (path: Path, value: Value, env: Env) => Iterable<[ Path, Value ]>;

/** Renders syntax, in the scope of whoever holds this, into the three forms a filter can take. */
export interface Render {
	/** The node's value form: one value, or a stream when `isStream` says so. */
	readonly value: (node: ast.Node) => Filter;
	/** The node's value form as a stream, whatever its shape. */
	readonly generator: (node: ast.Node) => Stream;
	/** The node as a path expression. */
	readonly path: (node: ast.Node) => PathFilter;
	/** The node's filter whatever its shape — a task when it awaits, which `value` and `generator` refuse. */
	readonly filter: (node: ast.Node) => Filter;
	/**
	 * As `filter`, for the one child whose outputs are the caller's own last: everything before it
	 * exhausted, nothing of the caller's after it. A recursive call there becomes a tail call.
	 */
	readonly last: (node: ast.Node) => Filter;
	/** A filter that is not a path expression, as a path filter: each of its values is the runtime's invalid path. */
	readonly invalid: (filter: Filter) => PathFilter;
}

/** The node types a runtime handles: everything but what binds a name, which is the compiler's own. */
export type Handled = Exclude<ast.Node, ast.Variable | ast.Call | ast.Def | ast.Bind | ast.Reduce | ast.Foreach | ast.Label | ast.Break>;

/** A node's semantics: its value form, and its path form when it is a path expression. */
export interface Handler<Node extends ast.Node> {
	readonly value: (node: Node, render: Render) => Filter;
	readonly path?: (node: Node, render: Render) => PathFilter;
}

type Handlers = { readonly [Type in Handled['type']]: Handler<Extract<ast.Node, { type: Type }>> };

/** The semantics of the language: a handler per kind of node, and what becomes of a value where a path was needed. */
export interface Runtime extends Handlers {
	/** Raised where a path expression was needed and a value came out instead: `path(1)`, `del(. + 1)`. */
	readonly invalidPath: (value: Value) => never;
}

/** What a program reaches at runtime besides its input. */
export interface Context {
	readonly args: Readonly<Record<string, Value>>;
	readonly env: Readonly<Record<string, string>>;
	/** The next input, for `input`; throws when there are none left. */
	readonly input: () => Value;
	/** Every remaining input, for `inputs`. */
	readonly inputs: () => Iterable<Value>;
	readonly debug: (value: Value) => void;
	readonly stderr: (value: Value) => void;
}

/** A program that cannot be instantiated: a name that is not defined, a format that does not exist. */
export class CompileError extends Error {
	override name = 'CompileError';
	/** Where in the source, when known; the compiler adds it to an error a library function raised. */
	readonly at: number | undefined;

	constructor(message: string, at?: number) {
		super(message);
		this.at = at;
	}
}

/** Thrown by `break $label`, and caught by the `label` that bound it. Not an error of the program; a runtime's `try` lets it pass. */
export class Break extends Error {
	override name = 'Break';
	readonly label: object;

	constructor(label: object) {
		super('break');
		this.label = label;
	}
}

/**
 * Yielded by a filter that awaits, among its values: an instruction to the driver at the very top
 * to settle the promise and resume the generator with its value — or to throw its rejection back
 * in, where the program's own `try` may catch it. The generator never touches the promise itself;
 * every frame in between just passes this along, so nothing below the driver becomes async.
 */
export class Await {
	readonly promise: Promise<Value>;

	constructor(promise: Promise<Value>) {
		this.promise = promise;
	}
}

/** What resumes a task's yield: an `Await`'s settlement, and nothing after a plain value. */
export type Resumed = Value | undefined;

const taskShape: unique symbol = Symbol('jssq.task');

/** Marks a stream — of values, of paths — as a task: one that may yield an `Await` among its items. */
export function task<Fn extends (...args: never) => Iterable<unknown>>(fn: Fn): Fn {
	return Object.assign(fn, { [taskShape]: true });
}

/** Whether a filter may yield `Await`s, read off the function itself as `isStream` is. A task is always a stream. */
export function isTask(fn: (...args: never) => unknown): boolean {
	return (fn as { readonly [taskShape]?: boolean })[taskShape] === true;
}

/**
 * Forwards one `Await` to the driver, resuming `iterator` with its settlement — or throwing its
 * rejection into it, where the stream's own `try` may catch it. Only a settlement arrives at the
 * forwarding yield, so an error coming out of this frame is the stream's own.
 */
export function *forward<Item, Out>(waiting: Await, iterator: Iterator<Item, unknown, Resumed>): Generator<Out, IteratorResult<Item, unknown>, Resumed> {
	try {
		// A forwarded instruction is invisible to the types, as it is to every frame it passes
		return iterator.next(yield waiting as unknown as Out);
	} catch (error) {
		if (iterator.throw === undefined) {
			throw error;
		} else {
			return iterator.throw(error);
		}
	}
}

/**
 * A stream's values inside a task: each one through `body`, whose own yields pass through, and
 * each `Await` passed along to the driver — its resolution fed back into the stream, a rejection
 * thrown into it. Returns how many values it saw, which is how a caller learns the stream was
 * empty. This is the task-aware `for..of`; a loop that cannot meet an `Await` should stay a plain
 * loop.
 */
export function *each<Item, Out>(iterable: Iterable<Item>, body: (item: Item) => Generator<Out, void, Resumed>): Generator<Out, number, Resumed> {
	const iterator = iterable[Symbol.iterator]() as Iterator<Item, unknown, Resumed>;
	let seen = 0;
	try {
		let next = iterator.next();
		while (next.done !== true) {
			const item = next.value;
			if (item instanceof Await) {
				next = yield* forward(item, iterator);
			} else {
				seen += 1;
				yield* body(item);
				next = iterator.next();
			}
		}
		return seen;
	} finally {
		iterator.return?.();
	}
}

/** As `each`, for a body with nothing of its own to yield. */
export function feed<Item>(iterable: Iterable<Item>, body: (item: Item) => void): Generator<never, number, Resumed> {
	// eslint-disable-next-line require-yield -- forwarding `Await`s is all it yields
	const wrap = function*(item: Item): Generator<never, void, Resumed> {
		body(item);
	};
	return each(iterable, wrap);
}

/**
 * The first item of a stream that may await, its `Await`s forwarded along the way; `undefined`
 * when there is none. The stream is closed either way, as taking the first output must.
 */
export function *firstOf<Item>(outputs: Iterable<Item>): Generator<never, Item | undefined, Resumed> {
	const iterator = outputs[Symbol.iterator]() as Iterator<Item, unknown, Resumed>;
	try {
		let next = iterator.next();
		while (next.done !== true) {
			const item = next.value;
			if (item instanceof Await) {
				next = yield* forward(item, iterator);
			} else {
				return item;
			}
		}
		return undefined;
	} finally {
		iterator.return?.();
	}
}

/**
 * `body` over each item `source` yields — a value stream, a path stream: a plain loop when the
 * source cannot await, `each` when it may. The result carries the source's brand; a caller whose
 * body awaits marks the result itself.
 */
export function over<Args extends readonly unknown[], Item, Out>(source: (...args: Args) => Iterable<Item>, body: (item: Item, ...args: Args) => Generator<Out, void, Resumed>): (...args: Args) => Generator<Out, void, Resumed> {
	if (isTask(source)) {
		return task(function*(...args: Args) {
			yield* each(source(...args), item => body(item, ...args));
		});
	}
	return function*(...args: Args) {
		for (const item of source(...args)) {
			yield* body(item, ...args);
		}
	};
}

/**
 * What a tail call to a recursive definition returns in place of a value: the next call, for
 * whoever settles it — the recursion runs where `settle` loops, not on the JavaScript stack. Like
 * an `Await`, it travels as a `Value` the types cannot spell, and only along the pass-through
 * chain a tail position guarantees.
 */
export class Bounce {
	readonly body: Single;
	readonly input: Value;
	readonly env: Env;

	constructor(body: Single, input: Value, env: Env) {
		this.body = body;
		this.input = input;
		this.env = env;
	}

	/** One call: the value, or the next bounce. */
	step(): Value {
		return this.body(this.input, this.env);
	}
}

/** A value with its bounces followed: what a single tail call finally comes to. */
export function settle(value: Value): Value {
	let result = value;
	while (result instanceof Bounce) {
		result = result.step();
	}
	return result;
}

/** As `Bounce`, for a stream: yielded as a stream's last item, it replaces the stream being read in `unrolled`. */
export class Tail {
	readonly stream: () => Iterable<Value>;

	constructor(stream: () => Iterable<Value>) {
		this.stream = stream;
	}
}

/**
 * Reads a stream, following its tail calls on this one frame: a `Tail` replaces the stream being
 * read, a `Bounce` settles to the value it stands for, and an `Await` passes to the driver as
 * ever. The frame a `Tail` abandons is closed; a tail position guarantees it had nothing left.
 */
export function *unrolled(start: () => Iterable<Value>): Generator<Value, void, Resumed> {
	let iterator = start()[Symbol.iterator]() as Iterator<Value, unknown, Resumed>;
	try {
		let next = iterator.next();
		while (next.done !== true) {
			const item = next.value;
			if (item instanceof Tail) {
				const previous = iterator;
				iterator = item.stream()[Symbol.iterator]() as Iterator<Value, unknown, Resumed>;
				previous.return?.();
				next = iterator.next();
			} else if (item instanceof Bounce) {
				yield settle(item);
				next = iterator.next();
			} else if (item instanceof Await) {
				next = yield* forward(item, iterator);
			} else {
				yield item;
				next = iterator.next();
			}
		}
	} finally {
		iterator.return?.();
	}
}

/**
 * Drives a stream that awaits, from outside its frames: an async iteration of its values, each
 * yielded as it settles. An `Await` met here is settled — the resolution resumed into the
 * stream, a rejection thrown into it, where the program's own `try` may catch it. This is the
 * only async frame there is; between settlements the program below runs synchronously.
 */
export async function *driven(outputs: Iterable<Value>): AsyncGenerator<Value, void, undefined> {
	const iterator = outputs[Symbol.iterator]() as Iterator<Value, unknown, Resumed>;
	try {
		let next = iterator.next();
		while (next.done !== true) {
			const item = next.value;
			if (item instanceof Await) {
				// Resume with the value, or throw the rejection into the program; an error the
				// program then raises must propagate out, not be thrown back in, so the step runs
				// after the catch
				const step = await async function(): Promise<() => IteratorResult<Value, unknown>> {
					try {
						const value = await item.promise;
						return () => iterator.next(value);
					} catch (error) {
						return () => {
							if (iterator.throw === undefined) {
								throw error;
							}
							return iterator.throw(error);
						};
					}
				}();
				next = step();
			} else {
				yield item;
				next = iterator.next();
			}
		}
	} finally {
		iterator.return?.();
	}
}

/** A library function's path form, when it has one: `select`, `first`, `getpath`. */
export const pathForm: unique symbol = Symbol('jssq.path');

/**
 * A library function, keyed by name: given a `Render` and the syntax of its arguments, and called
 * with the context as `this`, it returns the filter of a call to it. Its parameters are `render`
 * and then one per argument, so its `length` is its arity plus one, which is how a call is checked.
 * One name serves every arity: an `overload` declares no parameters at all, takes any number, and
 * picks an implementation by how many there are.
 */
export interface LibFunction {
	(this: Context, render: Render, ...args: readonly ast.Node[]): Filter;
	readonly [pathForm]?: (this: Context, render: Render, ...args: readonly ast.Node[]) => PathFilter;
}

export type Lib = Readonly<Record<string, LibFunction>>;

/** A library function that is also a path expression: its value form, then its path form. */
export function runtimePathFunction<Fn extends LibFunction>(value: Fn, path: NonNullable<LibFunction[typeof pathForm]>): Fn {
	return Object.assign(value, { [pathForm]: path });
}

/**
 * One library function of several arities: each alternative declares its arguments as parameters
 * after `render`, and the one whose parameter count matches a call is the one used.
 */
export function overload(...alternatives: readonly LibFunction[]): LibFunction {
	const pick = (args: readonly ast.Node[]): LibFunction => alternatives.find(alternative => alternative.length === args.length + 1) ?? function() {
		throw new CompileError(`no definition takes ${args.length} argument${args.length === 1 ? '' : 's'}`);
	}();
	return runtimePathFunction(
		function(this: Context, ...call: [ Render, ...ast.Node[] ]) {
			const [ render, ...args ] = call;
			return pick(args).call(this, render, ...args);
		},
		function(this: Context, ...call: [ Render, ...ast.Node[] ]) {
			const [ render, ...args ] = call;
			return pathCall(pick(args), this, render, args);
		},
	);
}

const GeneratorFunction = Object.getPrototypeOf(function*() {}) as { constructor: new () => unknown };

/** Whether a filter yields a stream, read off the function itself. */
export function isStream(fn: Filter): fn is Stream {
	return fn instanceof GeneratorFunction.constructor;
}

export function allSingle(filters: readonly Filter[]): filters is readonly Single[] {
	return filters.every(filter => !isStream(filter));
}

/** A filter as a stream: itself when it is one, otherwise its one value yielded. */
export function generator(filter: Filter): Stream {
	if (isStream(filter)) {
		return filter;
	}
	return function*(input, env) {
		yield filter(input, env);
	};
}

/** A library function called as a path expression; one without a path form is invalid there, as jq has it. */
export function pathCall(fn: LibFunction, ctx: Context, render: Render, args: readonly ast.Node[]): PathFilter {
	const impl = fn[pathForm];
	return impl === undefined ? render.invalid(fn.call(ctx, render, ...args)) : impl.call(ctx, render, ...args);
}

/** Every combination of the streams' outputs, the first (or the last) varying slowest, as jq orders them. */
export function *product(streams: readonly Stream[], input: Value, env: Env, slowest: 'first' | 'last'): Generator<Value[], void, Resumed> {
	const order = streams.map((_stream, ii) => ii);
	if (slowest === 'last') {
		order.reverse();
	}
	const values: Value[] = new Array<Value>(streams.length);
	const go = streams.some(isTask)
		? function*(depth: number): Generator<Value[], void, Resumed> {
			if (depth === order.length) {
				yield [ ...values ];
				return;
			}
			const ii = order[depth]!;
			yield* each(streams[ii]!(input, env), function*(value) {
				values[ii] = value;
				yield* go(depth + 1);
			});
		}
		: function*(depth: number): Generator<Value[], void, Resumed> {
			if (depth === order.length) {
				yield [ ...values ];
				return;
			}
			const ii = order[depth]!;
			for (const value of streams[ii]!(input, env)) {
				values[ii] = value;
				yield* go(depth + 1);
			}
		};
	yield* go(0);
}

/** `body` over one value from each filter, for every combination; a single value when every filter is. */
export function combine(filters: readonly Filter[], body: (values: Value[], input: Value, env: Env) => Value, slowest: 'first' | 'last' = 'first'): Filter {
	if (allSingle(filters)) {
		// The hottest path in a compiled program — every binary operator and literal index lands
		// here — so the one- and two-argument forms skip the per-call `.map`
		if (filters.length === 1) {
			const only = filters[0]!;
			return (input, env) => body([ only(input, env) ], input, env);
		} else if (filters.length === 2) {
			const first = filters[0]!;
			const second = filters[1]!;
			return (input, env) => body([ first(input, env), second(input, env) ], input, env);
		}
		return (input, env) => body(filters.map(filter => filter(input, env)), input, env);
	}
	const streams = filters.map(generator);
	if (filters.some(isTask)) {
		return task(function*(input, env) {
			yield* each(product(streams, input, env, slowest), function*(values) {
				yield body(values, input, env);
			});
		});
	}
	return function*(input, env) {
		for (const values of product(streams, input, env, slowest)) {
			yield body(values, input, env);
		}
	};
}

/** As `combine`, for a body that yields. */
export function combineStreams(filters: readonly Filter[], body: (values: Value[], input: Value, env: Env) => Iterable<Value>, slowest: 'first' | 'last' = 'first'): Stream {
	const streams = filters.map(generator);
	if (filters.some(isTask)) {
		return task(function*(input, env) {
			yield* each(product(streams, input, env, slowest), function*(values) {
				yield* body(values, input, env);
			});
		});
	}
	return function*(input, env) {
		for (const values of product(streams, input, env, slowest)) {
			yield* body(values, input, env);
		}
	};
}

/** A library function of values: each argument evaluated, the call made once per combination. */
export function values(render: Render, args: readonly ast.Node[], body: (input: Value, ...args: Value[]) => Value): Filter {
	return combine(args.map(arg => render.filter(arg)), (vals, input) => body(input, ...vals));
}

/** As `values`, for a body that yields. */
export function streams(render: Render, args: readonly ast.Node[], body: (input: Value, ...args: Value[]) => Iterable<Value>): Stream {
	return combineStreams(args.map(arg => render.filter(arg)), (vals, input) => body(input, ...vals));
}

/** As `values`, for a body that returns a promise: each call settled by the driver, out of frame. */
export function promises(render: Render, args: readonly ast.Node[], body: (input: Value, ...args: Value[]) => Promise<Value>): Filter {
	const streams = args.map(arg => generator(render.filter(arg)));
	return task(function*(input, env) {
		yield* each(product(streams, input, env, 'first'), function*(vals) {
			// The driver resumes an `Await` with a value, whatever the types can spell of it
			const value = yield new Await(body(input, ...vals)) as unknown as Value;
			yield value as Value;
		});
	});
}

/** The literal a node spells out, if it is one; what a library function reads to do work up front. */
export function constant(node: ast.Node): ast.Scalar | undefined {
	return node.type === 'literal' ? node.value : undefined;
}
