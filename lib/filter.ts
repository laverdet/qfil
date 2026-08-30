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
import type * as ast from '../ast.js';
import type { Path } from './intrinsics.js';
import type { Value } from './value.js';
import { invalidPath } from './intrinsics.js';

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

/** A filter that is not a path expression, as a path filter: its values are the error's. */
export function invalid(filter: Filter): PathFilter {
	const stream = generator(filter);
	return function*(_path, value, env) {
		for (const output of stream(value, env)) {
			yield invalidPath(output);
		}
	};
}

/** A library function called as a path expression; one without a path form is invalid there, as jq has it. */
export function pathCall(fn: LibFunction, ctx: Context, render: Render, args: readonly ast.Node[]): PathFilter {
	const impl = fn[pathForm];
	return impl === undefined ? invalid(fn.call(ctx, render, ...args)) : impl.call(ctx, render, ...args);
}

/** Every combination of the streams' outputs, the first (or the last) varying slowest, as jq orders them. */
export function *product(streams: readonly Stream[], input: Value, env: Env, slowest: 'first' | 'last'): Generator<Value[]> {
	const order = streams.map((_stream, ii) => ii);
	if (slowest === 'last') {
		order.reverse();
	}
	const values: Value[] = new Array<Value>(streams.length);
	const go = function*(depth: number): Generator<Value[]> {
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
		return (input, env) => body(filters.map(filter => filter(input, env)), input, env);
	}
	const streams = filters.map(generator);
	return function*(input, env) {
		for (const values of product(streams, input, env, slowest)) {
			yield body(values, input, env);
		}
	};
}

/** As `combine`, for a body that yields. */
export function combineStreams(filters: readonly Filter[], body: (values: Value[], input: Value, env: Env) => Iterable<Value>, slowest: 'first' | 'last' = 'first'): Stream {
	const streams = filters.map(generator);
	return function*(input, env) {
		for (const values of product(streams, input, env, slowest)) {
			yield* body(values, input, env);
		}
	};
}

/** A library function of values: each argument evaluated, the call made once per combination. */
export function values(render: Render, args: readonly ast.Node[], body: (input: Value, ...args: Value[]) => Value): Filter {
	return combine(args.map(arg => render.value(arg)), (vals, input) => body(input, ...vals));
}

/** As `values`, for a body that yields. */
export function streams(render: Render, args: readonly ast.Node[], body: (input: Value, ...args: Value[]) => Iterable<Value>): Stream {
	return combineStreams(args.map(arg => render.value(arg)), (vals, input) => body(input, ...vals));
}

/** The literal a node spells out, if it is one; what a library function reads to do work up front. */
export function constant(node: ast.Node): ast.Scalar | undefined {
	return node.type === 'literal' ? node.value : undefined;
}
