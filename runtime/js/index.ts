/**
 * The default library: named functions. Each receives a `Render` and the syntax of its arguments,
 * with the run's context as `this`, and returns the filter of a call: a function of an input and
 * an environment, a generator function when it yields a stream. That is the whole of a declaration.
 * A name that takes several numbers of arguments is an `overload` of one implementation per
 * arity, told apart by their parameter counts; a function that is also a path expression —
 * `select`, `first`, `getpath` — is declared with `runtimePathFunction(value, path)`.
 *
 * An argument is whatever the function makes of it: `values` evaluates arguments as jq's `$`
 * parameters (once per combination of their outputs); `render.generator` takes one as a filter to
 * run; `render.path` takes one as a path expression; and `constant` reads a literal off the
 * syntax, which is how `test("^a")` compiles its pattern once.
 *
 * `compile` takes a `lib` option, so an application may supply a library of its own.
 */
import type * as ast from '#/compiler/ast.js';
import type { Context, Env, Filter, Lib, LibFunction, Path, PathFilter, Render, Resumed, Stream, Value, ValueObject } from '#/compiler/filter.js';
import { add, delpaths, field, getpath, halt, has, iterate, keys, length, recursePaths, setpath, split } from './intrinsics.js';
import { JqError, compare, describe, fromjson, isNumber, isObject, newObject, tojson, tonumber, tostring, truthy, typeOf } from './value.js';
import { Await, constant, each, feed, firstOf, forward, isTask, overload, runtimePathFunction, streams, task, values } from '#/compiler/filter.js';

export function assertString(value: Value, what: string): string {
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
	if (!isNumber(value)) {
		throw new JqError(`${describe(value)} number required for ${what}`);
	}
	return Number(value);
}

/** A library function of the input alone. */
export function unary(fn: (input: Value) => Value): LibFunction {
	return _render => input => fn(input);
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

/** `sort_by(f)` keys: `[f]` of each element. */
function keysBy(values: Value[], filter: Stream, env: Env): Value[] {
	return values.map(value => [ ...filter(value, env) ]);
}

/**
 * The functions that put values in order — `sort`, `sort_by`, `group_by`, `unique` — over a
 * comparison, since what the order is depends on the runtime: JavaScript's here, jq's in the jq
 * runtime. The keys of `sort_by` and `group_by` are `[f]` of each value, compared element by element.
 */
export function ordered(compareValues: (left: Value, right: Value) => number): Lib {
	type Comparison = typeof compareValues;
	const compareKeys: Comparison = (left, right) => {
		const lhs = left as Value[];
		const rhs = right as Value[];
		const length = Math.min(lhs.length, rhs.length);
		for (let ii = 0; ii < length; ++ii) {
			const order = compareValues(lhs[ii]!, rhs[ii]!);
			if (order !== 0) {
				return order;
			}
		}
		return lhs.length - rhs.length;
	};
	// Indices of `items` sorted by their keys, keeping order among equal keys
	const order = (items: Value[], keys: Value[], by: Comparison): number[] =>
		items.map((_value, ii) => ii).sort((left, right) => by(keys[left]!, keys[right]!) || left - right);
	const groups = (items: Value[], keys: Value[], by: Comparison): Value[][] => {
		const result: Value[][] = [];
		let previous: Value | undefined;
		for (const ii of order(items, keys, by)) {
			const key = keys[ii]!;
			if (result.length === 0 || by(previous!, key) !== 0) {
				result.push([]);
				previous = key;
			}
			result[result.length - 1]!.push(items[ii]!);
		}
		return result;
	};
	return {
		sort: unary(input => [ ...assertArray(input, 'sort') ].sort(compareValues)),
		sort_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'sort_by');
			return order(items, keysBy(items, filter, env), compareKeys).map(ii => items[ii]!);
		}),
		group_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'group_by');
			return groups(items, keysBy(items, filter, env), compareKeys);
		}),
		unique: unary(input => {
			const items = assertArray(input, 'unique');
			return groups(items, items, compareValues).map(group => group[0]!);
		}),
	};
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
			} else if (Array.isArray(element) || isObject(element)) {
				throw new JqError(`${describe(element)} cannot be added to a string`);
			} else {
				return tojson(element);
			}
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
		} else {
			return value;
		}
	}();
	yield* filter(inner, env);
}

function rangeBound(value: Value): number {
	if (!isNumber(value)) {
		throw new JqError('Range bounds must be numeric');
	}
	return Number(value);
}

function limitCount(value: Value): number {
	if (!isNumber(value)) {
		throw new JqError(`${describe(value)} is not a valid limit`);
	} else if (value < 0) {
		throw new JqError("limit doesn't support negative count");
	}
	return Number(value);
}

/** The first output of a stream, or nothing. */
function *head<Type>(outputs: Iterable<Type>): Generator<Type> {
	const next = outputs[Symbol.iterator]().next();
	if (next.done !== true) {
		yield next.value;
	}
}

/** As {@link limited}, over a stream that may await: its `Await`s forwarded, not counted. */
function *limitedTask<Type>(count: Value, outputs: Iterable<Type>): Generator<Type, void, Resumed> {
	let remaining = limitCount(count);
	if (remaining <= 0) {
		return;
	}
	const iterator = outputs[Symbol.iterator]() as Iterator<Type, unknown, Resumed>;
	try {
		let next = iterator.next();
		while (next.done !== true) {
			const item = next.value;
			if (item instanceof Await) {
				next = yield* forward(item, iterator);
			} else {
				yield item;
				if (--remaining <= 0) {
					return;
				}
				next = iterator.next();
			}
		}
	} finally {
		iterator.return?.();
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

/** Builds the RegExp of a match call: what the pattern and flags mean is the library's to say — JavaScript's reading here, jq's in the jq library. */
export type RegexCompiler = (pattern: Value, flags: Value, extra: string) => RegExp;

export function regex(pattern: Value, flags: Value, extra = ''): RegExp {
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
function regexOf(compile: RegexCompiler, render: Render, pattern: ast.Node, flags: ast.Node | null, extra = ''): WithRegex {
	const literalPattern = constant(pattern);
	const literalFlags = flags === null ? null : constant(flags);
	if (literalPattern !== undefined && literalFlags !== undefined) {
		const compiled = compile(literalPattern, literalFlags, extra);
		return (input, _env, body) => body(compiled, input);
	} else {
		const args = streams(render, flags === null ? [ pattern ] : [ pattern, flags ], function*(_input, re, fl) {
			yield [ re, fl ?? null ];
		});
		return function*(input, env, body) {
			for (const pair of args(input, env)) {
				const [ re, fl ] = pair as [ Value, Value ];
				yield* body(compile(re, fl, extra), input);
			}
		};
	}
}

const skipsEmpty: unique symbol = Symbol('qfil.skipsEmpty');

/** Marks a regex whose empty matches do not count, as jq's `n` flag has it. */
export function ignoringEmpty(regex: RegExp): RegExp {
	return Object.assign(regex, { [skipsEmpty]: true });
}

function ignoresEmpty(regex: RegExp): boolean {
	return (regex as { readonly [skipsEmpty]?: boolean })[skipsEmpty] === true;
}

/** Every match when the pattern is global, otherwise the first; a regex marked by `ignoringEmpty` counts only the nonempty ones. */
function execAll(regex: RegExp, input: Value): RegExpExecArray[] {
	const text = assertString(input, 'match');
	if (regex.global) {
		const all = [ ...text.matchAll(regex) ];
		return ignoresEmpty(regex) ? all.filter(match => match[0] !== '') : all;
	} else if (ignoresEmpty(regex)) {
		// The first nonempty match: an empty one at an earlier offset does not count
		for (const match of text.matchAll(new RegExp(regex.source, `${regex.flags}g`))) {
			if (match[0] !== '') {
				return [ match ];
			}
		}
		return [];
	} else {
		const match = regex.exec(text);
		return match === null ? [] : [ match ];
	}
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

function regexFunction(compile: RegexCompiler, extra: string, body: (regex: RegExp, input: Value) => Iterable<Value>): LibFunction {
	const withRegex = (regexes: WithRegex): Stream => function*(input, env) {
		yield* regexes(input, env, body);
	};
	return overload(
		(render, pattern) => withRegex(regexOf(compile, render, pattern, null, extra)),
		(render, pattern, flags) => withRegex(regexOf(compile, render, pattern, flags, extra)),
	);
}

function subFunction(compile: RegexCompiler, extra: string): LibFunction {
	const withRegex = (render: Render, regexes: WithRegex, replacementNode: ast.Node): Stream => {
		const replacement = render.generator(replacementNode);
		return function*(input, env) {
			yield* regexes(input, env, (compiled, text) => substitute(compiled, text, groups => replacement(groups, env)));
		};
	};
	return overload(
		(render, pattern, replacement) => withRegex(render, regexOf(compile, render, pattern, null, extra), replacement),
		(render, pattern, replacement, flags) => withRegex(render, regexOf(compile, render, pattern, flags, extra), replacement),
	);
}

function *testWith(compiled: RegExp, input: Value): Generator<Value> {
	yield ignoresEmpty(compiled) ? execAll(compiled, input).length > 0 : compiled.test(assertString(input, 'test'));
}

function matchWith(compiled: RegExp, input: Value): Value[] {
	return execAll(compiled, input).map(matchObject);
}

function *splitWith(compiled: RegExp, input: Value): Generator<Value> {
	const text = assertString(input, 'split');
	const pieces: string[] = [];
	let previous = 0;
	for (const match of text.matchAll(compiled)) {
		if (ignoresEmpty(compiled) && match[0] === '') {
			continue;
		}
		pieces.push(text.slice(previous, match.index));
		previous = match.index + match[0].length;
	}
	pieces.push(text.slice(previous));
	yield pieces;
}

/**
 * The functions that match a regex — `test`, `match`, `split`, `sub`, `gsub` — over a compiler,
 * since what a pattern and its flags mean is the library's to say: JavaScript's reading in this
 * one, jq's in the jq library.
 */
export function matching(compile: RegexCompiler): Lib {
	return {
		test: regexFunction(compile, '', testWith),
		match: regexFunction(compile, '', matchWith),
		sub: subFunction(compile, ''),
		gsub: subFunction(compile, 'g'),
		split: overload(
			(render, separator) => values(render, [ separator ], (input, value) => split(assertString(input, 'split'), assertString(value, 'split'))),
			(render, pattern, flags) => function*(input, env) {
				yield* regexOf(compile, render, pattern, flags, 'g')(input, env, splitWith);
			},
		),
	};
}

/** A filter argument run over the input, as `map(f)` and `select(f)` take one. */
function withFilter(build: (filter: Stream) => Filter): (render: Render, arg: ast.Node) => Filter {
	return (render, arg) => build(render.generator(arg));
}

/** A filter argument as a path expression, as `path(f)` and `del(f)` take one. */
function withPath(build: (paths: PathFilter) => Filter): (render: Render, arg: ast.Node) => Filter {
	return (render, arg) => build(render.path(arg));
}

export const lib: Lib = {
	not: unary(input => !truthy(input)),
	error: overload(
		unary(input => {
			throw new JqError(input);
		}),
		(render, message) => values(render, [ message ], (_input, value) => {
			throw new JqError(value);
		}),
	),
	length: unary(length),
	type: unary(typeOf),
	keys: unary(keys),
	has: (render, key) => values(render, [ key ], (input, value) => has(input, value)),
	add: unary(input => [ ...iterate(input) ].reduce(add, null)),
	tostring: unary(tostring),
	tonumber: unary(tonumber),
	tojson: unary(input => tojson(input)),
	fromjson: unary(input => fromjson(assertString(input, 'fromjson'))),
	getpath: runtimePathFunction(
		(render, path) => values(render, [ path ], (input, value) => getpath(input, value)),
		(render, path) => {
			const paths = render.generator(path);
			return function*(prefix, value, env) {
				for (const sub of paths(value, env)) {
					const found = getpath(value, sub);
					yield [ [ ...prefix, ...sub as Value[] ], found ];
				}
			};
		},
	),
	setpath: (render, path, value) => values(render, [ path, value ], (input, at, replacement) => setpath(input, at, replacement)),
	delpaths: (render, paths) => values(render, [ paths ], (input, value) => delpaths(input, value)),
	paths: _render => function*(input) {
		for (const [ path ] of recursePaths([], input)) {
			if (path.length > 0) {
				yield path;
			}
		}
	},
	to_entries: unary(toEntries),
	from_entries: unary(fromEntries),
	with_entries: withFilter(filter => (input, env) => fromEntries(mapOver(toEntries(input), entry => filter(entry, env)))),
	map: withFilter(filter => (input, env) => mapOver(iterate(input), value => filter(value, env))),
	recurse: withFilter(update => function*(input, env) {
		yield* unroll(repeat(input, env, update));
	}),
	repeat: withFilter(update => function*(input, env) {
		yield* unroll(repeat(input, env, update));
	}),
	until: (render, cond, update) => {
		const test = render.generator(cond);
		const step = render.generator(update);
		return function*(input, env) {
			yield* unroll(until(input, env, test, step));
		};
	},
	while: (render, cond, update) => {
		const test = render.generator(cond);
		const step = render.generator(update);
		return function*(input, env) {
			yield* unroll(loop(input, env, test, step));
		};
	},
	walk: withFilter(filter => function*(input, env) {
		yield* walk(input, env, filter);
	}),
	empty: runtimePathFunction(
		_render => function*() {
			yield* [];
		},
		_render => function*() {
			yield* [];
		},
	),
	path: withPath(paths => {
		if (isTask(paths)) {
			return task(function*(input, env) {
				yield* each(paths([], input, env), function*(pair) {
					yield pair[0];
				});
			});
		} else {
			return function*(input, env) {
				for (const [ path ] of paths([], input, env)) {
					yield path;
				}
			};
		}
	}),
	del: withPath(paths => {
		if (isTask(paths)) {
			return task(function*(input, env) {
				const collected: Path[] = [];
				yield* feed(paths([], input, env), pair => collected.push(pair[0]));
				yield delpaths(input, collected);
			});
		} else {
			return (input, env) => delpaths(input, [ ...paths([], input, env) ].map(([ path ]) => path));
		}
	}),
	select: runtimePathFunction(
		withFilter(condition => function*(input, env) {
			for (const test of condition(input, env)) {
				if (truthy(test)) {
					yield input;
				}
			}
		}),
		(render, arg) => {
			const condition = render.generator(arg);
			return function*(path, value, env) {
				for (const test of condition(value, env)) {
					if (truthy(test)) {
						yield [ path, value ];
					}
				}
			};
		},
	),
	first: overload(
		unary(input => assertArray(input, 'first')[0] ?? null),
		runtimePathFunction(
			withFilter(filter => function*(input, env) {
				yield* head(filter(input, env));
			}),
			(render, arg) => {
				const filter = render.path(arg);
				if (isTask(filter)) {
					return task(function*(path, value, env) {
						const found = yield* firstOf(filter(path, value, env));
						if (found !== undefined) {
							yield found;
						}
					});
				} else {
					return function*(path, value, env) {
						yield* head(filter(path, value, env));
					};
				}
			},
		),
	),
	limit: runtimePathFunction(
		(render, count, arg) => {
			const counts = render.generator(count);
			const filter = render.generator(arg);
			return function*(input, env) {
				for (const bound of counts(input, env)) {
					yield* limited(bound, filter(input, env));
				}
			};
		},
		(render, count, arg) => {
			const counts = render.generator(count);
			const filter = render.path(arg);
			if (isTask(filter)) {
				return task(function*(path, value, env) {
					for (const bound of counts(value, env)) {
						yield* limitedTask(bound, filter(path, value, env));
					}
				});
			} else {
				return function*(path, value, env) {
					for (const bound of counts(value, env)) {
						yield* limited(bound, filter(path, value, env));
					}
				};
			}
		},
	),
	isempty: withFilter(filter => (input, env) => filter(input, env)[Symbol.iterator]().next().done === true),
	range: overload(
		(render, upto) => streams(render, [ upto ], function*(_input, end) {
			const bound = rangeBound(end);
			for (let ii = 0; ii < bound; ++ii) {
				yield ii;
			}
		}),
		(render, from, upto) => streams(render, [ from, upto ], function*(_input, start, end) {
			const bound = rangeBound(end);
			for (let ii = rangeBound(start); ii < bound; ++ii) {
				yield ii;
			}
		}),
		(render, from, upto, by) => streams(render, [ from, upto, by ], function*(_input, start, end, step) {
			const increment = rangeBound(step);
			const bound = rangeBound(end);
			if (increment > 0) {
				for (let ii = rangeBound(start); ii < bound; ii += increment) {
					yield ii;
				}
			} else if (increment < 0) {
				for (let ii = rangeBound(start); ii > bound; ii += increment) {
					yield ii;
				}
			}
		}),
	),
	input(this: Context, _render: Render) {
		return () => this.input();
	},
	inputs(this: Context, _render: Render) {
		return fromIterable(() => this.inputs());
	},
	debug(this: Context, _render: Render) {
		return (input: Value) => {
			this.debug(input);
			return input;
		};
	},
	stderr(this: Context, _render: Render) {
		return (input: Value) => {
			this.stderr(input);
			return input;
		};
	},
	any: unary(input => [ ...iterate(input) ].some(truthy)),
	all: unary(input => [ ...iterate(input) ].every(truthy)),
	last: unary(input => assertArray(input, 'last').at(-1) ?? null),
	...ordered(compare),
	reverse: unary(input => input === null ? [] : [ ...assertArray(input, 'reverse') ].reverse()),
	flatten: unary(flatten),
	startswith: (render, prefix) => values(render, [ prefix ], (input, value) => assertString(input, 'startswith').startsWith(assertString(value, 'startswith'))),
	endswith: (render, suffix) => values(render, [ suffix ], (input, value) => assertString(input, 'endswith').endsWith(assertString(value, 'endswith'))),
	ltrimstr: (render, prefix) => values(render, [ prefix ], (input, value) => {
		const text = assertString(input, 'ltrimstr');
		return typeof value === 'string' && text.startsWith(value) ? text.slice(value.length) : text;
	}),
	rtrimstr: (render, suffix) => values(render, [ suffix ], (input, value) => {
		const text = assertString(input, 'rtrimstr');
		return typeof value === 'string' && value !== '' && text.endsWith(value) ? text.slice(0, -value.length) : text;
	}),
	...matching(regex),
	join: (render, separator) => values(render, [ separator ], (input, value) => join(input, value)),
	ascii_downcase: unary(input => assertString(input, 'ascii_downcase').replace(/[A-Z]+/g, text => text.toLowerCase())),
	ascii_upcase: unary(input => assertString(input, 'ascii_upcase').replace(/[a-z]+/g, text => text.toUpperCase())),
	floor: unary(input => Math.floor(assertNumber(input, 'floor'))),
	sqrt: unary(input => Math.sqrt(assertNumber(input, 'sqrt'))),
	pow: (render, base, exponent) => values(render, [ base, exponent ], (_input, left, right) => assertNumber(left, 'pow') ** assertNumber(right, 'pow')),
	halt: _render => () => halt(0),
	halt_error: overload(
		unary(input => halt(5, input)),
		(render, code) => values(render, [ code ], (input, status) => halt(assertNumber(status, 'halt_error'), input)),
	),
};
