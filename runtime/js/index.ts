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
import type { Context, Env, Lib, Path, Render, Resumed, Stream, Value } from '#/compiler/filter.js';
import { dates } from './date.js';
import { add, delpaths, format, getpath, halt, has, isFormat, iterate, keys, length, recursePaths, setpath } from './intrinsics.js';
import { assertArray, assertNumber, assertString, unary, withFilter, withPath } from './library.js';
import { math } from './math.js';
import { matching, regex } from './regex.js';
import { strings } from './strings.js';
import { JqError, compare, describe, fromjson, isNumber, isObject, newObject, tojson, tonumber, tostring, truthy, typeOf } from './value.js';
import { Await, awaited, each, feed, firstOf, forward, isTask, overload, runtimePathFunction, streams, task, values } from '#/compiler/filter.js';

/** The pulled input, or the language's error past the last one. */
function pulled(next: IteratorResult<Value>): Value {
	if (next.done === true) {
		throw new JqError('No more inputs');
	}
	return next.value;
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
		unique_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'unique_by');
			return groups(items, keysBy(items, filter, env), compareKeys).map(group => group[0]!);
		}),
		// The first of equal least elements, and the last of equal greatest, as jq picks them
		min: unary(input => least(assertArray(input, 'min'), assertArray(input, 'min'), compareValues)),
		max: unary(input => greatest(assertArray(input, 'max'), assertArray(input, 'max'), compareValues)),
		min_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'min_by');
			return least(items, keysBy(items, filter, env), compareKeys);
		}),
		max_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'max_by');
			return greatest(items, keysBy(items, filter, env), compareKeys);
		}),
		bsearch: (render, target) => values(render, [ target ], (input, value) => {
			const items = assertArray(input, 'bsearch');
			let lo = 0;
			let hi = items.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				const order = compareValues(items[mid]!, value);
				if (order === 0) {
					return mid;
				} else if (order < 0) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			return -lo - 1;
		}),
	};

	function least(items: Value[], keys: Value[], by: Comparison): Value {
		let found: number | null = null;
		for (let ii = 0; ii < items.length; ++ii) {
			if (found === null || by(keys[ii]!, keys[found]!) < 0) {
				found = ii;
			}
		}
		return found === null ? null : items[found]!;
	}

	function greatest(items: Value[], keys: Value[], by: Comparison): Value {
		let found: number | null = null;
		for (let ii = 0; ii < items.length; ++ii) {
			if (found === null || by(keys[ii]!, keys[found]!) >= 0) {
				found = ii;
			}
		}
		return found === null ? null : items[found]!;
	}
}

function flatten(value: Value, depth: number): Value[] {
	const result: Value[] = [];
	for (const element of assertArray(value, 'flatten')) {
		result.push(...Array.isArray(element) && depth > 0 ? flatten(element, depth - 1) : [ element ]);
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
		const { inputs } = this;
		if (inputs.awaits) {
			return task(function*(): Generator<Value, void, Resumed> {
				yield pulled(yield* awaited(inputs.iterator.next()));
			});
		} else {
			return () => pulled(inputs.iterator.next());
		}
	},
	inputs(this: Context, _render: Render) {
		const { inputs } = this;
		if (inputs.awaits) {
			return task(function*(): Generator<Value, void, Resumed> {
				while (true) {
					const next = yield* awaited(inputs.iterator.next());
					if (next.done === true) {
						return;
					}
					yield next.value;
				}
			});
		} else {
			return fromIterable(() => ({ [Symbol.iterator]: () => inputs.iterator }));
		}
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
	flatten: overload(
		unary(input => flatten(input, Infinity)),
		(render, depth) => values(render, [ depth ], (input, deep) => {
			const levels = assertNumber(deep, 'flatten');
			if (levels < 0) {
				throw new JqError('flatten depth must not be negative');
			}
			return flatten(input, levels);
		}),
	),
	keys_unsorted: unary(input => {
		if (Array.isArray(input)) {
			return input.map((_element, ii) => ii);
		} else if (isObject(input)) {
			return Object.keys(input);
		}
		throw new JqError(`${describe(input)} has no keys`);
	}),
	format: (render, name) => values(render, [ name ], (input, value) => {
		const spec = assertString(value, 'format');
		if (!isFormat(spec)) {
			throw new JqError(`${spec} is not a valid format`);
		}
		return format(spec, input);
	}),
	builtins(this: Context, _render: Render) {
		return () => this.builtins();
	},
	input_filename: _render => () => null,
	input_line_number: _render => () => 0,
	have_decnum: _render => () => false,
	have_literal_numbers: _render => () => false,
	get_jq_origin: unary(() => {
		throw new JqError('qfil has no module system');
	}),
	get_prog_origin: unary(() => {
		throw new JqError('qfil has no module system');
	}),
	get_search_list: unary(() => {
		throw new JqError('qfil has no module system');
	}),
	modulemeta: unary(() => {
		throw new JqError('qfil has no module system');
	}),
	...dates,
	...strings,
	...matching(regex),
	...math,
	halt: _render => () => halt(0),
	halt_error: overload(
		unary(input => halt(5, input)),
		(render, code) => values(render, [ code ], (input, status) => halt(assertNumber(status, 'halt_error'), input)),
	),
};
