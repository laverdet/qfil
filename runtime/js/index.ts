/**
 * The default library: named functions, each a direct export, so the module's namespace object —
 * `import * as lib` — is the library itself. Each function receives a `Render` and the syntax of
 * its arguments, with the run's context as `this`, and returns the filter of a call: a function
 * of an input and an environment, a generator function when it yields a stream. That is the whole
 * of a declaration. A name that takes several numbers of arguments is an `overload` of one
 * implementation per arity, told apart by their parameter counts; a function that is also a path
 * expression — `select`, `first`, `getpath` — is declared with `runtimePathFunction(value, path)`.
 *
 * An argument is whatever the function makes of it: `values` evaluates arguments as jq's `$`
 * parameters (once per combination of their outputs); `render.generator` takes one as a filter to
 * run; `render.path` takes one as a path expression; and `constant` reads a literal off the
 * syntax, which is how `test("^a")` compiles its pattern once.
 *
 * `compile` takes a `lib` option, so an application may supply a library of its own.
 */
import type { Context, Env, Filter, LibFunction, Path, Render, Resumed, Stream, Value } from '#/compiler/filter.js';
import { compare, truthy } from './value.js';
import { Await, awaited, each, feed, firstOf, forward, isTask, overload, runtimePathFunction, streams, task, values } from '#/compiler/filter.js';
import * as intrinsics from '#/runtime/lang/intrinsics.js';
import { assertArray, assertNumber, assertString, unary, withFilter, withPath } from '#/runtime/lang/library.js';
import { ordered } from '#/runtime/lang/order.js';
import { matching, regex } from '#/runtime/lang/regexp.js';
import { conditionals } from '#/runtime/lang/truth.js';
import { JqError, describe, fromjson as fromjsonOf, isNumber, isObject, newObject, tojson as tojsonOf, tostring as tostringOf, typeOf } from '#/runtime/lang/value.js';

export * from './date.js';
export * from './math.js';
export * from './strings.js';

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

function flattened(value: Value, depth: number): Value[] {
	const result: Value[] = [];
	for (const element of assertArray(value, 'flatten')) {
		result.push(...Array.isArray(element) && depth > 0 ? flattened(element, depth - 1) : [ element ]);
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

/** `walk(f)`: `f` applied bottom-up; a member whose result is empty is dropped, as `|=` drops it. */
function *walking(value: Value, env: Env, filter: Stream): Generator<Value> {
	const inner = function() {
		if (Array.isArray(value)) {
			return mapOver(value, element => walking(element, env, filter));
		} else if (isObject(value)) {
			const result = newObject();
			for (const key of Object.keys(value)) {
				const [ output ] = walking(value[key]!, env, filter);
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

const conds = conditionals(truthy);
export const { not, select, until, any, all } = conds;
const { while: whileOf } = conds;
export { whileOf as while };
export const error = overload(
	unary(input => {
		throw new JqError(input);
	}),
	values((_input, value) => {
		throw new JqError(value);
	}),
);
export const length = unary(intrinsics.length);
export const type = unary(typeOf);
export const keys = unary(intrinsics.keys);
export const has = values(intrinsics.has);
export const add = unary(input => [ ...intrinsics.iterate(input) ].reduce(intrinsics.add, null));
export const tostring = unary(tostringOf);
// A string is a number as JavaScript reads one — `Number()`: hex, binary and whitespace
// included, and NaN where nothing parses rather than an error; jq's C reading is the jq flavor's
export const tonumber = unary(input => {
	if (isNumber(input)) {
		return input;
	} else if (typeof input === 'string') {
		return Number(input);
	}
	throw new JqError(`${describe(input)} cannot be parsed as a number`);
});
export const tojson = unary(input => tojsonOf(input));
export const fromjson = unary(input => fromjsonOf(assertString(input, 'fromjson')));
export const getpath: LibFunction = runtimePathFunction(
	values(intrinsics.getpath),
	(render, path) => {
		const paths = render.generator(path);
		return function*(prefix, value, env) {
			for (const sub of paths(value, env)) {
				const found = intrinsics.getpath(value, sub);
				yield [ [ ...prefix, ...sub as Value[] ], found ];
			}
		};
	},
);
export const setpath = values(intrinsics.setpath);
export const delpaths = values(intrinsics.delpaths);
export const paths: LibFunction = _render => function*(input) {
	for (const [ path ] of intrinsics.recursePaths([], input)) {
		if (path.length > 0) {
			yield path;
		}
	}
};
export const to_entries = unary(toEntries);
/**
 * The key is the first of `key`, `Key`, `name` that is not null or false, else `Name`; the value
 * is `value`, or `Value` when only that is present. Null and false are what jq's `//` skips, so
 * this is jq's builtin exactly, spelled without truthiness — a falsy key survives both flavors.
 */
export const from_entries = unary(input => {
	const result = newObject();
	for (const entry of intrinsics.iterate(input)) {
		const key = function() {
			for (const name of [ 'key', 'Key', 'name' ] as const) {
				const found = intrinsics.field(entry, name);
				if (found !== null && found !== false) {
					return found;
				}
			}
			return intrinsics.field(entry, 'Name');
		}();
		const value = intrinsics.has(entry, 'value') ? intrinsics.field(entry, 'value') : intrinsics.field(entry, 'Value');
		result[intrinsics.toKey(key)] = value;
	}
	return result;
});
export const map = withFilter(filter => (input, env) => mapOver(intrinsics.iterate(input), value => filter(value, env)));
// `def repeat(exp): def _repeat: exp, _repeat; _repeat;` — the same input every round, an
// endless stream until `exp` raises: `[repeat(.*2, error)?]` of 1 is `[2]`
export const repeat = withFilter(update => function*(input, env) {
	while (true) {
		yield* update(input, env);
	}
});
export const walk = withFilter(filter => function*(input, env) {
	yield* walking(input, env, filter);
});
export const empty: LibFunction = runtimePathFunction(
	_render => function*() {
		yield* [];
	},
	_render => function*() {
		yield* [];
	},
);
export const path = withPath(paths => {
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
});
export const del = withPath(paths => {
	if (isTask(paths)) {
		return task(function*(input, env) {
			const collected: Path[] = [];
			yield* feed(paths([], input, env), pair => collected.push(pair[0]));
			yield intrinsics.delpaths(input, collected);
		});
	} else {
		return (input, env) => intrinsics.delpaths(input, [ ...paths([], input, env) ].map(([ path ]) => path));
	}
});
export const first = overload(
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
);
export const limit: LibFunction = runtimePathFunction(
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
);
export const isempty = withFilter(filter => (input, env) => filter(input, env)[Symbol.iterator]().next().done === true);
export const range = overload(
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
);
export function input(this: Context, _render: Render): Filter {
	const { inputs } = this;
	if (inputs.awaits) {
		return task(function*(): Generator<Value, void, Resumed> {
			yield pulled(yield* awaited(inputs.iterator.next()));
		});
	} else {
		return () => pulled(inputs.iterator.next());
	}
}
export function inputs(this: Context, _render: Render): Filter {
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
}
export function debug(this: Context, _render: Render): Filter {
	return (input: Value) => {
		this.debug(input);
		return input;
	};
}
export function stderr(this: Context, _render: Render): Filter {
	return (input: Value) => {
		this.stderr(input);
		return input;
	};
}
export const last = unary(input => assertArray(input, 'last').at(-1) ?? null);
export const { sort, sort_by, group_by, unique, unique_by, min, max, min_by, max_by, bsearch } = ordered(compare);
export const { test, match, sub, gsub, split } = matching(regex);
export const reverse = unary(input => input === null ? [] : [ ...assertArray(input, 'reverse') ].reverse());
export const flatten = overload(
	unary(input => flattened(input, Infinity)),
	values((input, deep) => {
		const levels = assertNumber(deep, 'flatten');
		if (levels < 0) {
			throw new JqError('flatten depth must not be negative');
		}
		return flattened(input, levels);
	}),
);
export const keys_unsorted = unary(input => {
	if (Array.isArray(input)) {
		return input.map((_element, ii) => ii);
	} else if (isObject(input)) {
		return Object.keys(input);
	}
	throw new JqError(`${describe(input)} has no keys`);
});
export const format = values((input, value) => {
	const spec = assertString(value, 'format');
	if (!intrinsics.isFormat(spec)) {
		throw new JqError(`${spec} is not a valid format`);
	}
	return intrinsics.format(spec, input);
});
export function builtins(this: Context, _render: Render): Filter {
	return () => this.builtins();
}
export const input_filename: LibFunction = _render => () => null;
export const input_line_number: LibFunction = _render => () => 0;
export const have_decnum: LibFunction = _render => () => false;
export const have_literal_numbers: LibFunction = _render => () => false;
export const get_jq_origin = unary(() => {
	throw new JqError('qfil has no module system');
});
export const get_prog_origin = unary(() => {
	throw new JqError('qfil has no module system');
});
export const get_search_list = unary(() => {
	throw new JqError('qfil has no module system');
});
export const modulemeta = unary(() => {
	throw new JqError('qfil has no module system');
});
export const halt: LibFunction = _render => () => intrinsics.halt(0);
export const halt_error = overload(
	unary(input => intrinsics.halt(5, input)),
	values((input, status) => intrinsics.halt(assertNumber(status, 'halt_error'), input)),
);
