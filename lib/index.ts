/**
 * The default library: named functions keyed by `name/arity`. Each is called with the run's context
 * as `this`, then the input, then its arguments as values, once per combination of the arguments'
 * outputs — except a parameter marked by `runtimeFunction(fn, { closures: [ … ] })`, which arrives as a
 * closure: a function of an input yielding a stream, carrying its path form as `.path`. A function
 * written as a generator yields a stream; any other returns exactly one value. One that is meaningful
 * as a path expression — `select`, `first`, `getpath` — is declared with `runtimePathFunction(expr, path)`.
 * That is the whole of a declaration: the compiler reads the shape off the function itself and the
 * rest off symbols on it.
 *
 * `compile` takes a `lib` option, so an application may supply a library of its own.
 */
import type { Closure, Context, Lib } from './intrinsics.js';
import type { Value, ValueObject } from './value.js';
import { add, delpaths, field, getpath, halt, has, iterate, keys, length, recursePaths, runtimeFunction, runtimePathFunction, setpath, split } from './intrinsics.js';
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

/** `[.[] | f]` over any iterable of values. */
function mapOver(values: Iterable<Value>, filter: (value: Value) => Iterable<Value>): Value[] {
	const result: Value[] = [];
	for (const value of values) {
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
function keysBy(values: Value[], filter: Closure): Value[] {
	return values.map(value => [ ...filter(value) ]);
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
function *repeat(state: Value, update: Closure): Generator<Value | Recur> {
	yield state;
	for (const next of update(state)) {
		yield new Recur(repeat(next, update));
	}
}

/** `def until(cond; update): if cond then . else (update | until(cond; update)) end;` */
function *until(state: Value, cond: Closure, update: Closure): Generator<Value | Recur> {
	for (const test of cond(state)) {
		if (truthy(test)) {
			yield state;
		} else {
			for (const next of update(state)) {
				yield new Recur(until(next, cond, update));
			}
		}
	}
}

/** `def while(cond; update): if cond then ., (update | while(cond; update)) else empty end;` */
function *loop(state: Value, cond: Closure, update: Closure): Generator<Value | Recur> {
	for (const test of cond(state)) {
		if (truthy(test)) {
			yield state;
			for (const next of update(state)) {
				yield new Recur(loop(next, cond, update));
			}
		}
	}
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

/** `walk(f)`: `f` applied bottom-up; a member whose result is empty is dropped, as `|=` drops it. */
function *walk(value: Value, filter: Closure): Generator<Value> {
	const inner = function() {
		if (Array.isArray(value)) {
			return mapOver(value, element => walk(element, filter));
		} else if (isObject(value)) {
			const result = newObject();
			for (const key of Object.keys(value)) {
				const [ output ] = walk(value[key]!, filter);
				if (output !== undefined) {
					result[key] = output;
				}
			}
			return result;
		}
		return value;
	}();
	yield* filter(inner);
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

/** Every match when the pattern is global, otherwise the first. */
function execAll(input: Value, pattern: Value, flags: Value): RegExpExecArray[] {
	const text = assertString(input, 'match');
	const compiled = regex(pattern, flags);
	if (compiled.global) {
		return [ ...text.matchAll(compiled) ];
	}
	const match = compiled.exec(text);
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
function *substitute(input: Value, pattern: Value, flags: Value, replacement: Closure): Generator<string> {
	const text = assertString(input, 'sub');
	const edits = execAll(text, pattern, flags).map(match => ({
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

export const lib: Lib = {
	'not/0'(input) {
		return !truthy(input);
	},
	'error/0'(input) {
		throw new JqError(input);
	},
	'error/1'(_input, message: Value) {
		throw new JqError(message);
	},
	'length/0'(input) {
		return length(input);
	},
	'type/0'(input) {
		return typeOf(input);
	},
	'keys/0'(input) {
		return keys(input);
	},
	'has/1'(input, key: Value) {
		return has(input, key);
	},
	'add/0'(input) {
		return [ ...iterate(input) ].reduce(add, null);
	},
	'tostring/0'(input) {
		return tostring(input);
	},
	'tonumber/0'(input) {
		return tonumber(input);
	},
	'tojson/0'(input) {
		return tojson(input);
	},
	'fromjson/0'(input) {
		return fromjson(assertString(input, 'fromjson'));
	},
	'getpath/1': runtimePathFunction(
		(input: Value, path: Value) => getpath(input, path),
		function*(path, value, sub: Value) {
			const found = getpath(value, sub);
			yield [ [ ...path, ...sub as Value[] ], found ];
		},
	),
	'setpath/2'(input, path: Value, value: Value) {
		return setpath(input, path, value);
	},
	'delpaths/1'(input, paths: Value) {
		return delpaths(input, paths);
	},
	*'paths/0'(input) {
		for (const [ path ] of recursePaths([], input)) {
			if (path.length > 0) {
				yield path;
			}
		}
	},
	'to_entries/0'(input) {
		return toEntries(input);
	},
	'from_entries/0'(input) {
		return fromEntries(input);
	},
	'with_entries/1': runtimeFunction(
		(input: Value, filter: Closure) => fromEntries(mapOver(toEntries(input), filter)),
		{ closures: [ 0 ] },
	),
	'map/1': runtimeFunction(
		(input: Value, filter: Closure) => mapOver(iterate(input), filter),
		{ closures: [ 0 ] },
	),
	'recurse/1': runtimeFunction(
		function*(input: Value, update: Closure) {
			yield* unroll(repeat(input, update));
		},
		{ closures: [ 0 ] },
	),
	'repeat/1': runtimeFunction(
		function*(input: Value, update: Closure) {
			yield* unroll(repeat(input, update));
		},
		{ closures: [ 0 ] },
	),
	'until/2': runtimeFunction(
		function*(input: Value, cond: Closure, update: Closure) {
			yield* unroll(until(input, cond, update));
		},
		{ closures: [ 0, 1 ] },
	),
	'while/2': runtimeFunction(
		function*(input: Value, cond: Closure, update: Closure) {
			yield* unroll(loop(input, cond, update));
		},
		{ closures: [ 0, 1 ] },
	),
	'empty/0': runtimePathFunction(
		function*() {
			yield* [];
		},
		function*() {
			yield* [];
		},
	),
	'path/1': runtimeFunction(
		function*(input: Value, filter: Closure) {
			for (const [ path ] of filter.path([], input)) {
				yield path;
			}
		},
		{ closures: [ 0 ] },
	),
	'del/1': runtimeFunction(
		(input: Value, filter: Closure) => delpaths(input, [ ...filter.path([], input) ].map(([ path ]) => path)),
		{ closures: [ 0 ] },
	),
	'select/1': runtimePathFunction(
		function*(input: Value, condition: Closure) {
			for (const test of condition(input)) {
				if (truthy(test)) {
					yield input;
				}
			}
		},
		function*(path, value, condition: Closure) {
			for (const test of condition(value)) {
				if (truthy(test)) {
					yield [ path, value ];
				}
			}
		},
		{ closures: [ 0 ] },
	),
	'first/1': runtimePathFunction(
		function*(input: Value, filter: Closure) {
			yield* head(filter(input));
		},
		function*(path, value, filter: Closure) {
			yield* head(filter.path(path, value));
		},
		{ closures: [ 0 ] },
	),
	'limit/2': runtimePathFunction(
		function*(input: Value, count: Value, filter: Closure) {
			let remaining = limitCount(count);
			if (remaining <= 0) {
				return;
			}
			for (const output of filter(input)) {
				yield output;
				if (--remaining <= 0) {
					return;
				}
			}
		},
		function*(path, value, count: Value, filter: Closure) {
			let remaining = limitCount(count);
			if (remaining <= 0) {
				return;
			}
			for (const pair of filter.path(path, value)) {
				yield pair;
				if (--remaining <= 0) {
					return;
				}
			}
		},
		{ closures: [ 1 ] },
	),
	'isempty/1': runtimeFunction(
		(input: Value, filter: Closure) => filter(input)[Symbol.iterator]().next().done === true,
		{ closures: [ 0 ] },
	),
	*'range/1'(input, upto: Value) {
		const end = rangeBound(upto);
		for (let ii = 0; ii < end; ++ii) {
			yield ii;
		}
	},
	*'range/2'(input, from: Value, upto: Value) {
		const end = rangeBound(upto);
		for (let ii = rangeBound(from); ii < end; ++ii) {
			yield ii;
		}
	},
	*'range/3'(input, from: Value, upto: Value, by: Value) {
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
	},
	'input/0'(this: Context) {
		return this.input();
	},
	*'inputs/0'(this: Context) {
		yield* this.inputs();
	},
	'debug/0'(this: Context, input) {
		this.debug(input);
		return input;
	},
	'stderr/0'(this: Context, input) {
		this.stderr(input);
		return input;
	},
	'walk/1': runtimeFunction(
		function*(input: Value, filter: Closure) {
			yield* walk(input, filter);
		},
		{ closures: [ 0 ] },
	),
	'any/0'(input) {
		return [ ...iterate(input) ].some(truthy);
	},
	'all/0'(input) {
		return [ ...iterate(input) ].every(truthy);
	},
	'first/0'(input) {
		return assertArray(input, 'first')[0] ?? null;
	},
	'last/0'(input) {
		return assertArray(input, 'last').at(-1) ?? null;
	},
	'sort/0'(input) {
		return [ ...assertArray(input, 'sort') ].sort(compare);
	},
	'sort_by/1': runtimeFunction(
		(input: Value, filter: Closure) => {
			const values = assertArray(input, 'sort_by');
			return order(values, keysBy(values, filter)).map(ii => values[ii]!);
		},
		{ closures: [ 0 ] },
	),
	'group_by/1': runtimeFunction(
		(input: Value, filter: Closure) => {
			const values = assertArray(input, 'group_by');
			return groups(values, keysBy(values, filter));
		},
		{ closures: [ 0 ] },
	),
	'unique/0'(input) {
		const values = assertArray(input, 'unique');
		return groups(values, values).map(group => group[0]!);
	},
	'reverse/0'(input) {
		return input === null ? [] : [ ...assertArray(input, 'reverse') ].reverse();
	},
	'flatten/0'(input) {
		return flatten(input);
	},
	'startswith/1'(input, prefix: Value) {
		return assertString(input, 'startswith').startsWith(assertString(prefix, 'startswith'));
	},
	'endswith/1'(input, suffix: Value) {
		return assertString(input, 'endswith').endsWith(assertString(suffix, 'endswith'));
	},
	'ltrimstr/1'(input, prefix: Value) {
		const text = assertString(input, 'ltrimstr');
		return typeof prefix === 'string' && text.startsWith(prefix) ? text.slice(prefix.length) : text;
	},
	'rtrimstr/1'(input, suffix: Value) {
		const text = assertString(input, 'rtrimstr');
		return typeof suffix === 'string' && suffix !== '' && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
	},
	'split/1'(input, separator: Value) {
		return split(assertString(input, 'split'), assertString(separator, 'split'));
	},
	'split/2'(input, pattern: Value, flags: Value) {
		const text = assertString(input, 'split');
		const pieces: string[] = [];
		let previous = 0;
		for (const match of text.matchAll(regex(pattern, flags, 'g'))) {
			pieces.push(text.slice(previous, match.index));
			previous = match.index + match[0].length;
		}
		pieces.push(text.slice(previous));
		return pieces;
	},
	'join/1'(input, separator: Value) {
		return join(input, separator);
	},
	'ascii_downcase/0'(input) {
		return assertString(input, 'ascii_downcase').replace(/[A-Z]+/g, text => text.toLowerCase());
	},
	'ascii_upcase/0'(input) {
		return assertString(input, 'ascii_upcase').replace(/[a-z]+/g, text => text.toUpperCase());
	},
	'test/1'(input, pattern: Value) {
		return regex(pattern, null).test(assertString(input, 'test'));
	},
	'test/2'(input, pattern: Value, flags: Value) {
		return regex(pattern, flags).test(assertString(input, 'test'));
	},
	*'match/1'(input, pattern: Value) {
		yield* execAll(input, pattern, null).map(matchObject);
	},
	*'match/2'(input, pattern: Value, flags: Value) {
		yield* execAll(input, pattern, flags).map(matchObject);
	},
	'sub/2': runtimeFunction(
		function*(input: Value, pattern: Value, replacement: Closure) {
			yield* substitute(input, pattern, null, replacement);
		},
		{ closures: [ 1 ] },
	),
	'sub/3': runtimeFunction(
		function*(input: Value, pattern: Value, replacement: Closure, flags: Value) {
			yield* substitute(input, pattern, flags, replacement);
		},
		{ closures: [ 1 ] },
	),
	'gsub/2': runtimeFunction(
		function*(input: Value, pattern: Value, replacement: Closure) {
			yield* substitute(input, pattern, 'g', replacement);
		},
		{ closures: [ 1 ] },
	),
	'floor/0'(input) {
		return Math.floor(assertNumber(input, 'floor'));
	},
	'sqrt/0'(input) {
		return Math.sqrt(assertNumber(input, 'sqrt'));
	},
	'pow/2'(_input, base: Value, exponent: Value) {
		return assertNumber(base, 'pow') ** assertNumber(exponent, 'pow');
	},
	'halt/0'() {
		return halt(0);
	},
	'halt_error/0'(input) {
		return halt(5, input);
	},
	'halt_error/1'(input, code: Value) {
		return halt(assertNumber(code, 'halt_error'), input);
	},
};
