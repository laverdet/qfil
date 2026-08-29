/**
 * jssq — a jq-compatible query language compiled to JavaScript.
 *
 * `compile` turns a filter into a JavaScript function of one input. The function is a plain
 * function when the filter yields exactly one value and a generator function when it may yield
 * any number: `compile('.a')` returns the field, `compile('.[]')` returns an iterator over the
 * elements. `render` is the same compilation stopped at the JavaScript source.
 */
import type { CompileOptions, Shape } from './compiler.js';
import type { Context, Lib } from './lib/intrinsics.js';
import type { Runtime } from './lib/runtime.js';
import type { Value } from './lib/value.js';
import * as process from 'node:process';
import { render as renderSource } from './compiler.js';
import { lib as defaultLib } from './lib/index.js';
import { runtime as defaultRuntime } from './lib/runtime.js';
import { JqError, tojson } from './lib/value.js';

export type { Value, ValueObject } from './lib/value.js';
export type { CompileOptions, Shape } from './compiler.js';
export { CompileError } from './compiler.js';
export { ParseError, parse } from './parser.js';
export { Break, Halt, JqError } from './lib/value.js';
export type { Annotations, Closure, Context, Lib, LibFunction, Path } from './lib/intrinsics.js';
export { runtimeFunction, closures, runtimePathFunction, pathForm } from './lib/intrinsics.js';
export { lib } from './lib/index.js';
export type { BinaryOperator, Comparison, Runtime } from './lib/runtime.js';
export { runtime } from './lib/runtime.js';

export interface RunOptions extends CompileOptions {
	/** Named arguments, available as `$name`. */
	readonly args?: Readonly<Record<string, Value>>;
	/** What the program is built from; jq's semantics unless given. */
	readonly runtime?: Runtime;
	/** Further inputs for `input` and `inputs`; none by default. */
	readonly inputs?: Iterable<Value>;
	readonly env?: Readonly<Record<string, string>>;
	readonly debug?: (value: Value) => void;
	readonly stderr?: (value: Value) => void;
}

export interface SingleFilter {
	(input: Value): Value;
	readonly shape: 'expr' | 'single';
	readonly code: string;
}

export interface StreamFilter {
	(input: Value): Iterable<Value>;
	readonly shape: 'stream';
	readonly code: string;
}

export type Filter = SingleFilter | StreamFilter;

/** The JavaScript source of a filter: a factory expression taking the runtime and a context. */
export function render(source: string, options: CompileOptions = {}): { code: string; shape: Shape } {
	return renderSource(source, options);
}

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
 * whether the filter is a stream; `shape` says the same.
 */
export function compile(source: string, options: RunOptions = {}): Filter {
	const { code, shape } = renderSource(source, options);
	// The rendered source is a factory over the runtime; evaluating it is the point
	// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
	const evaluate = new Function(`return ${code};`) as () => (rt: Runtime, lib: Lib, ctx: Context) => Filter;
	const factory = evaluate();
	const filter = factory(options.runtime ?? defaultRuntime, options.lib ?? defaultLib, createContext(options));
	return Object.assign(filter, { shape, code }) as Filter;
}

/** Runs a filter over one input, collecting every output. */
export function run(source: string, input: Value, options: RunOptions = {}): Value[] {
	const filter = compile(source, options);
	return filter.shape === 'stream' ? [ ...filter(input) ] : [ filter(input) ];
}
