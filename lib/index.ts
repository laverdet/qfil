/**
 * The default library: named functions keyed by `name/arity`. Each receives the syntax of its
 * arguments and a `Render`, with the run's context as `this`, and returns the filter of a call:
 * a function of an input and an environment, a generator function when it yields a stream. That
 * is the whole of a declaration. A function that is also a path expression — `select`, `first`,
 * `getpath` — is declared with `runtimePathFunction(value, path)`.
 *
 * An argument is whatever the function makes of it: `values` evaluates arguments as jq's `$`
 * parameters (once per combination of their outputs); `render.generator` takes one as a filter to
 * run; `render.path` takes one as a path expression; and `constant` reads a literal off the
 * syntax, which is how `test("^a")` compiles its pattern once.
 *
 * `compile` takes a `lib` option, so an application may supply a library of its own.
 */
import type * as ast from '../ast.js';
import type { Context, Env, Lib, LibFunction, Render, Stream } from './filter.js';
import type { Value, ValueObject } from './value.js';
import { constant, runtimePathFunction, streams, values } from './filter.js';
import { add, delpaths, field, getpath, halt, has, iterate, keys, length, recursePaths, setpath, split } from './intrinsics.js';
import { JqError, compare, describe, fromjson, isObject, newObject, tojson, tonumber, tostring, truthy, typeOf } from './value.js';

function assertString(value: Value, what: string): string {
	if (typeof value !== 'string') {
		throw new JqError(`${what} input must be a string`);
	}
	return value;
}

function assertArray(value: Value, what: string): Value[] {
	if (!Array.isArray(value)) {
		throw new JqError(`${what} input must be an array`);
	}
	return value;
}

function assertNumber(value: Value, what: string): number {
	if (typeof value !== 'number') {
		throw new JqError(`${describe(value)} number required for ${what}`);
	}
	return value;
}

/** A library function of the input alone. */
function unary(fn: (input: Value) => Value): LibFunction {
	return () => input => fn(input);
}

/** A stream drawn from outside the program, as `inputs` is. */
function fromIterable(source: () => Iterable<Value>): Stream {
	return function*() {
		yield* source();
	};
}

/** `[.[] | f]` over any iterable of values. */
function mapOver(inputs: Iterable<Value>, filter: (value: Value) => Iterable<Value>): Value[] {
	const result: Value[] = [];
	for (const value of inputs) {
		result.push(...filter(value));
	}
	return result;
}

/** Sorts indices of `values` by their keys, keeping order among equal keys. */
function order(values: Value[], keys: Value[]): number[] {
	return values.map((_value, ii) => ii).sort((left, right) => compare(keys[left]!, keys[right]!) || left - right);
}

function groups(values: Value[], keys: Value[]): Value[][] {
	const result: Value[][] = [];
	let previous: Value | undefined;
	for (const ii of order(values, keys)) {
		const key = keys[ii]!;
		if (result.length === 0 || compare(previous!, key) !== 0) {
			result.push([]);
			previous = key;
		}
		result[result.length - 1]!.push(values[ii]!);
	}
	return result;
}

/** `sort_by(f)` keys: `[f]` of each element. */
function keysBy(values: Value[], filter: Stream, env: Env): Value[] {
	return values.map(value => [ ...filter(value, env) ]);
}

function flatten(value: Value): Value[] {
	const result: Value[] = [];
	for (const element of assertArray(value, 'flatten')) {
		result.push(...Array.isArray(element) ? flatten(element) : [ element ]);
	}
	return result;
}

function toEntries(value: Value): Value[] {
	if (Array.isArray(value)) {
		return value.map((element, ii) => ({ __proto__: null, key: ii, value: element }));
	} else if (isObject(value)) {
		return Object.keys(value).map(key => ({ __proto__: null, key, value: value[key]! }));
	}
	throw new JqError(`${describe(value)} has no keys`);
}

function fromEntries(value: Value): ValueObject {
	const result = newObject();
	for (const entry of assertArray(value, 'from_entries')) {
		const key = field(entry, 'key');
		if (typeof key !== 'string') {
			throw new JqError(`Cannot use ${describe(key)} as object key`);
		}
		result[key] = field(entry, 'value');
	}
	return result;
}

function join(value: Value, separator: Value): Value {
	let result: Value = null;
	let first = true;
	for (const element of iterate(value)) {
		const piece = function() {
			if (element === null) {
				return '';
			} else if (typeof element === 'string') {
				return element;
			} else if (typeof element === 'object') {
				throw new JqError(`${describe(element)} cannot be added to a string`);
			}
			return tojson(element);
		}();
		result = add(first ? '' : add(result, separator), piece);
		first = false;
	}
	return result ?? '';
}

/**
 * Recursion as data, so that a recursive stream runs on the heap rather than the call stack: a step
 * yields outputs and `Recur`s, each of which is a step to run to completion before going on.
 */
class Recur {
	readonly step: Iterable<Value | Recur>;

	constructor(step: Iterable<Value | Recur>) {
		this.step = step;
	}
}

function *unroll(step: Iterable<Value | Recur>): Generator<Value> {
	const stack = [ step[Symbol.iterator]() ];
	while (stack.length > 0) {
		const next = stack[stack.length - 1]!.next();
		if (next.done === true) {
			stack.pop();
		} else if (next.value instanceof Recur) {
			stack.push(next.value.step[Symbol.iterator]());
		} else {
			yield next.value;
		}
	}
}

/** `def repeat(f): ., (f | repeat(f));` — which is also `recurse(f)`. */
function *repeat(state: Value, env: Env, update: Stream): Generator<Value | Recur> {
	yield state;
	for (const next of update(state, env)) {
		yield new Recur(repeat(next, env, update));
	}
}

/** `def until(cond; update): if cond then . else (update | until(cond; update)) end;` */
function *until(state: Value, env: Env, cond: Stream, update: Stream): Generator<Value | Recur> {
	for (const test of cond(state, env)) {
		if (truthy(test)) {
			yield state;
		} else {
			for (const next of update(state, env)) {
				yield new Recur(until(next, env, cond, update));
			}
		}
	}
}

/** `def while(cond; update): if cond then ., (update | while(cond; update)) else empty end;` */
function *loop(state: Value, env: Env, cond: Stream, update: Stream): Generator<Value | Recur> {
	for (const test of cond(state, env)) {
		if (truthy(test)) {
			yield state;
			for (const next of update(state, env)) {
				yield new Recur(loop(next, env, cond, update));
			}
		}
	}
}

/** `walk(f)`: `f` applied bottom-up; a member whose result is empty is dropped, as `|=` drops it. */
function *walk(value: Value, env: Env, filter: Stream): Generator<Value> {
	const inner = function() {
		if (Array.isArray(value)) {
			return mapOver(value, element => walk(element, env, filter));
		} else if (isObject(value)) {
			const result = newObject();
			for (const key of Object.keys(value)) {
				const [ output ] = walk(value[key]!, env, filter);
				if (output !== undefined) {
					result[key] = output;
				}
			}
			return result;
		}
		return value;
	}();
	yield* filter(inner, env);
}

function rangeBound(value: Value): number {
	if (typeof value !== 'number') {
		throw new JqError('Range bounds must be numeric');
	}
	return value;
}

function limitCount(value: Value): number {
	if (typeof value !== 'number') {
		throw new JqError(`${describe(value)} is not a valid limit`);
	} else if (value < 0) {
		throw new JqError("limit doesn't support negative count");
	}
	return value;
}

/** The first output of a stream, or nothing. */
function *head<Type>(outputs: Iterable<Type>): Generator<Type> {
	const next = outputs[Symbol.iterator]().next();
	if (next.done !== true) {
		yield next.value;
	}
}

/** At most `count` outputs of a stream. */
function *limited<Type>(count: Value, outputs: Iterable<Type>): Generator<Type> {
	let remaining = limitCount(count);
	if (remaining <= 0) {
		return;
	}
	for (const output of outputs) {
		yield output;
		if (--remaining <= 0) {
			return;
		}
	}
}

// Regular expressions are JavaScript's, flags included. `u` and `d` are always set, so patterns
// are Unicode-aware and captures carry offsets; offsets are UTF-16 code units.

function regex(pattern: Value, flags: Value, extra = ''): RegExp {
	if (typeof pattern !== 'string') {
		throw new JqError(`${describe(pattern)} cannot be matched, as it is not a string`);
	} else if (flags !== null && typeof flags !== 'string') {
		throw new JqError(`${describe(flags)} is not a string`);
	}
	try {
		return new RegExp(pattern, [ ...new Set(`du${flags ?? ''}${extra}`) ].join(''));
	} catch (error) {
		throw new JqError((error as Error).message);
	}
}

/** Runs `body` with a regex for each combination of the pattern and flag arguments' outputs. */
type WithRegex = (input: Value, env: Env, body: (regex: RegExp, input: Value) => Iterable<Value>) => Iterable<Value>;

/** A regex from its arguments — compiled once when both are literals, otherwise per call: the syntax is there to be read. */
function regexOf(render: Render, pattern: ast.Node, flags: ast.Node | null, extra = ''): WithRegex {
	const literalPattern = constant(pattern);
	const literalFlags = flags === null ? null : constant(flags);
	if (literalPattern !== undefined && literalFlags !== undefined) {
		const compiled = regex(literalPattern, literalFlags, extra);
		return (input, _env, body) => body(compiled, input);
	}
	const args = streams(render, flags === null ? [ pattern ] : [ pattern, flags ], function*(_input, re, fl) {
		yield [ re, fl ?? null ];
	});
	return function*(input, env, body) {
		for (const pair of args(input, env)) {
			const [ re, fl ] = pair as [ Value, Value ];
			yield* body(regex(re, fl, extra), input);
		}
	};
}

/** Every match when the pattern is global, otherwise the first. */
function execAll(regex: RegExp, input: Value): RegExpExecArray[] {
	const text = assertString(input, 'match');
	if (regex.global) {
		return [ ...text.matchAll(regex) ];
	}
	const match = regex.exec(text);
	return match === null ? [] : [ match ];
}

/** A match as jq's `match` object. */
function matchObject(match: RegExpExecArray): ValueObject {
	const indices: readonly ([ number, number ] | undefined)[] = match.indices!;
	// The indices of a named group are the same pair object as its positional entry
	const names = new Map(Object.entries<[ number, number ] | undefined>(match.indices!.groups ?? {})
		.filter(([ , range ]) => range !== undefined)
		.map(([ name, range ]) => [ range, name ]));
	const captures = indices.slice(1).map((range, ii) => range === undefined
		? { __proto__: null, offset: -1, length: 0, string: null, name: null }
		: { __proto__: null, offset: range[0], length: range[1] - range[0], string: match[ii + 1]!, name: names.get(range) ?? null });
	return { __proto__: null, offset: match.index, length: match[0].length, string: match[0], captures };
}

/** The named groups of a match as an object, null for the ones that did not participate. */
function namedGroups(match: RegExpExecArray): ValueObject {
	const result = newObject();
	for (const [ name, string ] of Object.entries<string | undefined>(match.groups ?? {})) {
		result[name] = string ?? null;
	}
	return result;
}

/**
 * `sub` and `gsub`. The replacement filter runs once per match with the named groups as its input;
 * when it yields several strings, the k-th result replaces every match with its k-th one.
 */
function *substitute(regex: RegExp, input: Value, replacement: (groups: Value) => Iterable<Value>): Generator<string> {
	const text = assertString(input, 'sub');
	const edits = execAll(regex, text).map(match => ({
		start: match.index,
		end: match.index + match[0].length,
		outputs: [ ...replacement(namedGroups(match)) ].map(output => typeof output === 'string' ? output : function() {
			throw new JqError(`${describe(output)} cannot be added to a string`);
		}()),
	}));
	if (edits.length === 0) {
		yield text;
		return;
	}
	const count = Math.min(...edits.map(edit => edit.outputs.length));
	for (let kk = 0; kk < count; ++kk) {
		let output = '';
		let previous = 0;
		for (const edit of edits) {
			output += text.slice(previous, edit.start) + edit.outputs[kk]!;
			previous = edit.end;
		}
		yield output + text.slice(previous);
	}
}

function regexFunction(flags: (args: readonly ast.Node[]) => ast.Node | null, extra: string, body: (regex: RegExp, input: Value) => Iterable<Value>): LibFunction {
	return (args, render) => {
		const regexes = regexOf(render, args[0]!, flags(args), extra);
		return function*(input, env) {
			yield* regexes(input, env, body);
		};
	};
}

function subFunction(flags: (args: readonly ast.Node[]) => ast.Node | null, extra: string): LibFunction {
	return (args, render) => {
		const regexes = regexOf(render, args[0]!, flags(args), extra);
		const replacement = render.generator(args[1]!);
		return function*(input, env) {
			yield* regexes(input, env, (compiled, text) => substitute(compiled, text, groups => replacement(groups, env)));
		};
	};
}

function *testWith(compiled: RegExp, input: Value): Generator<Value> {
	yield compiled.test(assertString(input, 'test'));
}

function matchWith(compiled: RegExp, input: Value): Value[] {
	return execAll(compiled, input).map(matchObject);
}

function *splitWith(compiled: RegExp, input: Value): Generator<Value> {
	const text = assertString(input, 'split');
	const pieces: string[] = [];
	let previous = 0;
	for (const match of text.matchAll(compiled)) {
		pieces.push(text.slice(previous, match.index));
		previous = match.index + match[0].length;
	}
	pieces.push(text.slice(previous));
	yield pieces;
}

export const lib: Lib = {
	'not/0': unary(input => !truthy(input)),
	'error/0': unary(input => {
		throw new JqError(input);
	}),
	'error/1': (args, render) => values(render, args, (_input, message) => {
		throw new JqError(message);
	}),
	'length/0': () => length,
	'type/0': () => typeOf,
	'keys/0': () => keys,
	'has/1': (args, render) => values(render, args, (input, key) => has(input, key)),
	'add/0': unary(input => [ ...iterate(input) ].reduce(add, null)),
	'tostring/0': () => tostring,
	'tonumber/0': () => tonumber,
	'tojson/0': unary(input => tojson(input)),
	'fromjson/0': unary(input => fromjson(assertString(input, 'fromjson'))),
	'getpath/1': runtimePathFunction(
		(args, render) => values(render, args, (input, path) => getpath(input, path)),
		(args, render) => {
			const paths = render.generator(args[0]!);
			return function*(path, value, env) {
				for (const sub of paths(value, env)) {
					const found = getpath(value, sub);
					yield [ [ ...path, ...sub as Value[] ], found ];
				}
			};
		},
	),
	'setpath/2': (args, render) => values(render, args, (input, path, value) => setpath(input, path, value)),
	'delpaths/1': (args, render) => values(render, args, (input, paths) => delpaths(input, paths)),
	'paths/0': () => function*(input) {
		for (const [ path ] of recursePaths([], input)) {
			if (path.length > 0) {
				yield path;
			}
		}
	},
	'to_entries/0': () => toEntries,
	'from_entries/0': () => fromEntries,
	'with_entries/1': (args, render) => {
		const filter = render.generator(args[0]!);
		return (input, env) => fromEntries(mapOver(toEntries(input), entry => filter(entry, env)));
	},
	'map/1': (args, render) => {
		const filter = render.generator(args[0]!);
		return (input, env) => mapOver(iterate(input), value => filter(value, env));
	},
	'recurse/1': (args, render) => {
		const update = render.generator(args[0]!);
		return function*(input, env) {
			yield* unroll(repeat(input, env, update));
		};
	},
	'repeat/1': (args, render) => {
		const update = render.generator(args[0]!);
		return function*(input, env) {
			yield* unroll(repeat(input, env, update));
		};
	},
	'until/2': (args, render) => {
		const cond = render.generator(args[0]!);
		const update = render.generator(args[1]!);
		return function*(input, env) {
			yield* unroll(until(input, env, cond, update));
		};
	},
	'while/2': (args, render) => {
		const cond = render.generator(args[0]!);
		const update = render.generator(args[1]!);
		return function*(input, env) {
			yield* unroll(loop(input, env, cond, update));
		};
	},
	'walk/1': (args, render) => {
		const filter = render.generator(args[0]!);
		return function*(input, env) {
			yield* walk(input, env, filter);
		};
	},
	'empty/0': runtimePathFunction(
		() => function*() {
			yield* [];
		},
		() => function*() {
			yield* [];
		},
	),
	'path/1': (args, render) => {
		const paths = render.path(args[0]!);
		return function*(input, env) {
			for (const [ path ] of paths([], input, env)) {
				yield path;
			}
		};
	},
	'del/1': (args, render) => {
		const paths = render.path(args[0]!);
		return (input, env) => delpaths(input, [ ...paths([], input, env) ].map(([ path ]) => path));
	},
	'select/1': runtimePathFunction(
		(args, render) => {
			const condition = render.generator(args[0]!);
			return function*(input, env) {
				for (const test of condition(input, env)) {
					if (truthy(test)) {
						yield input;
					}
				}
			};
		},
		(args, render) => {
			const condition = render.generator(args[0]!);
			return function*(path, value, env) {
				for (const test of condition(value, env)) {
					if (truthy(test)) {
						yield [ path, value ];
					}
				}
			};
		},
	),
	'first/1': runtimePathFunction(
		(args, render) => {
			const filter = render.generator(args[0]!);
			return function*(input, env) {
				yield* head(filter(input, env));
			};
		},
		(args, render) => {
			const filter = render.path(args[0]!);
			return function*(path, value, env) {
				yield* head(filter(path, value, env));
			};
		},
	),
	'limit/2': runtimePathFunction(
		(args, render) => {
			const counts = render.generator(args[0]!);
			const filter = render.generator(args[1]!);
			return function*(input, env) {
				for (const count of counts(input, env)) {
					yield* limited(count, filter(input, env));
				}
			};
		},
		(args, render) => {
			const counts = render.generator(args[0]!);
			const filter = render.path(args[1]!);
			return function*(path, value, env) {
				for (const count of counts(value, env)) {
					yield* limited(count, filter(path, value, env));
				}
			};
		},
	),
	'isempty/1': (args, render) => {
		const filter = render.generator(args[0]!);
		return (input, env) => filter(input, env)[Symbol.iterator]().next().done === true;
	},
	'range/1': (args, render) => streams(render, args, function*(_input, upto) {
		const end = rangeBound(upto);
		for (let ii = 0; ii < end; ++ii) {
			yield ii;
		}
	}),
	'range/2': (args, render) => streams(render, args, function*(_input, from, upto) {
		const end = rangeBound(upto);
		for (let ii = rangeBound(from); ii < end; ++ii) {
			yield ii;
		}
	}),
	'range/3': (args, render) => streams(render, args, function*(_input, from, upto, by) {
		const step = rangeBound(by);
		const end = rangeBound(upto);
		if (step > 0) {
			for (let ii = rangeBound(from); ii < end; ii += step) {
				yield ii;
			}
		} else if (step < 0) {
			for (let ii = rangeBound(from); ii > end; ii += step) {
				yield ii;
			}
		}
	}),
	'input/0'(this: Context) {
		return () => this.input();
	},
	'inputs/0'(this: Context) {
		return fromIterable(() => this.inputs());
	},
	'debug/0'(this: Context) {
		return (input: Value) => {
			this.debug(input);
			return input;
		};
	},
	'stderr/0'(this: Context) {
		return (input: Value) => {
			this.stderr(input);
			return input;
		};
	},
	'any/0': unary(input => [ ...iterate(input) ].some(truthy)),
	'all/0': unary(input => [ ...iterate(input) ].every(truthy)),
	'first/0': unary(input => assertArray(input, 'first')[0] ?? null),
	'last/0': unary(input => assertArray(input, 'last').at(-1) ?? null),
	'sort/0': unary(input => [ ...assertArray(input, 'sort') ].sort(compare)),
	'sort_by/1': (args, render) => {
		const filter = render.generator(args[0]!);
		return (input, env) => {
			const items = assertArray(input, 'sort_by');
			return order(items, keysBy(items, filter, env)).map(ii => items[ii]!);
		};
	},
	'group_by/1': (args, render) => {
		const filter = render.generator(args[0]!);
		return (input, env) => {
			const items = assertArray(input, 'group_by');
			return groups(items, keysBy(items, filter, env));
		};
	},
	'unique/0': unary(input => {
		const items = assertArray(input, 'unique');
		return groups(items, items).map(group => group[0]!);
	}),
	'reverse/0': unary(input => input === null ? [] : [ ...assertArray(input, 'reverse') ].reverse()),
	'flatten/0': unary(flatten),
	'startswith/1': (args, render) => values(render, args, (input, prefix) => assertString(input, 'startswith').startsWith(assertString(prefix, 'startswith'))),
	'endswith/1': (args, render) => values(render, args, (input, suffix) => assertString(input, 'endswith').endsWith(assertString(suffix, 'endswith'))),
	'ltrimstr/1': (args, render) => values(render, args, (input, prefix) => {
		const text = assertString(input, 'ltrimstr');
		return typeof prefix === 'string' && text.startsWith(prefix) ? text.slice(prefix.length) : text;
	}),
	'rtrimstr/1': (args, render) => values(render, args, (input, suffix) => {
		const text = assertString(input, 'rtrimstr');
		return typeof suffix === 'string' && suffix !== '' && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
	}),
	'split/1': (args, render) => values(render, args, (input, separator) => split(assertString(input, 'split'), assertString(separator, 'split'))),
	'split/2': regexFunction(args => args[1]!, 'g', splitWith),
	'join/1': (args, render) => values(render, args, (input, separator) => join(input, separator)),
	'ascii_downcase/0': unary(input => assertString(input, 'ascii_downcase').replace(/[A-Z]+/g, text => text.toLowerCase())),
	'ascii_upcase/0': unary(input => assertString(input, 'ascii_upcase').replace(/[a-z]+/g, text => text.toUpperCase())),
	'test/1': regexFunction(() => null, '', testWith),
	'test/2': regexFunction(args => args[1]!, '', testWith),
	'match/1': regexFunction(() => null, '', matchWith),
	'match/2': regexFunction(args => args[1]!, '', matchWith),
	'sub/2': subFunction(() => null, ''),
	'sub/3': subFunction(args => args[2]!, ''),
	'gsub/2': subFunction(() => null, 'g'),
	'floor/0': unary(input => Math.floor(assertNumber(input, 'floor'))),
	'sqrt/0': unary(input => Math.sqrt(assertNumber(input, 'sqrt'))),
	'pow/2': (args, render) => values(render, args, (_input, base, exponent) => assertNumber(base, 'pow') ** assertNumber(exponent, 'pow')),
	'halt/0': () => () => halt(0),
	'halt_error/0': unary(input => halt(5, input)),
	'halt_error/1': (args, render) => values(render, args, (input, code) => halt(assertNumber(code, 'halt_error'), input)),
};
