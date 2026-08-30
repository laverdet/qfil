/**
 * jssq — a jq-compatible query language, run as JavaScript.
 *
 * `compile` turns a filter into a JavaScript function of one input. The function is a plain
 * function when the filter yields exactly one value and a generator function when it may yield
 * any number: `compile('.a')` returns the field, `compile('.[]')` returns an iterator over the
 * elements. The filter is not turned into source text; it is assembled from the functions the
 * runtime and the library return for each piece of its syntax.
 */
import type { Context, Lib, Runtime, Value } from './compiler/filter.js';
import * as process from 'node:process';
import { instantiate } from './compiler/compiler.js';
import { parse } from './compiler/parser.js';
import { lib as defaultLib } from './runtime/js/index.js';
import { runtime as defaultRuntime } from './runtime/js/runtime.js';
import { JqError, tojson } from './runtime/js/value.js';

export type { Context, Env, Filter as LibFilter, Handled, Handler, Lib, LibFunction, Path, PathFilter, Render, Runtime, Stream, Value, ValueObject } from './compiler/filter.js';
export { Break, CompileError, combine, combineStreams, constant, generator, isStream, overload, pathForm, runtimePathFunction, streams, values } from './compiler/filter.js';
export { ParseError, parse } from './compiler/parser.js';
export { lib } from './runtime/js/index.js';
export { runtime } from './runtime/js/runtime.js';
export { Halt, JqError } from './runtime/js/value.js';

export interface RunOptions {
	/** The library of named functions; the default one unless given. */
	readonly lib?: Lib;
	/** The meaning of the language's constructs; jq's unless given. */
	readonly runtime?: Runtime;
	/** Named arguments, available as `$name`. */
	readonly args?: Readonly<Record<string, Value>>;
	/** Further inputs for `input` and `inputs`; none by default. */
	readonly inputs?: Iterable<Value>;
	readonly env?: Readonly<Record<string, string>>;
	readonly debug?: (value: Value) => void;
	readonly stderr?: (value: Value) => void;
}

export interface SingleFilter {
	(input: Value): Value;
	readonly stream: false;
}

export interface StreamFilter {
	(input: Value): Iterable<Value>;
	readonly stream: true;
}

export type Filter = SingleFilter | StreamFilter;

export function createContext(options: RunOptions = {}): Context {
	const inputs = (options.inputs ?? [])[Symbol.iterator]();
	const env = options.env ?? process.env as Record<string, string>;
	return {
		args: options.args ?? {},
		env,
		input: () => {
			const next = inputs.next();
			if (next.done === true) {
				throw new JqError('No more inputs');
			}
			return next.value;
		},
		inputs: () => ({ [Symbol.iterator]: () => inputs }),
		debug: options.debug ?? (value => {
			process.stderr.write(`${tojson([ 'DEBUG:', value ])}\n`);
		}),
		stderr: options.stderr ?? (value => {
			process.stderr.write(tojson(value));
		}),
	};
}

/**
 * Compiles a filter to a function of its input. Whether the result is a generator function says
 * whether the filter is a stream; `stream` says the same.
 */
export function compile(source: string, options: RunOptions = {}): Filter {
	const program = instantiate(source, parse(source), options.runtime ?? defaultRuntime, options.lib ?? defaultLib, createContext(options));
	return Object.assign(program.filter, { stream: program.stream }) as Filter;
}

/** Runs a filter over one input, collecting every output. */
export function run(source: string, input: Value, options: RunOptions = {}): Value[] {
	const filter = compile(source, options);
	return filter.stream ? [ ...filter(input) ] : [ filter(input) ];
}
