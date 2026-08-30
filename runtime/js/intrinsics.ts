/**
 * The operations on values: field access, indexing, iteration, the operators, paths and the
 * `@format`s. The runtime (`runtime.ts`) gives the language's constructs their meaning in terms of
 * these; the library (`index.ts`) is built on them too. Nothing here knows about syntax.
 */
import type { Path, Value, ValueObject } from '#/compiler/filter.js';
import { Halt, JqError, compare, copyObject, describe, equal, isObject, newObject, tojson, tostring, typeOf } from './value.js';

export { Halt, JqError, compare, equal, fromjson, tojson, tonumber, tostring, truthy, typeOf } from './value.js';

export function error(value: Value): never {
	throw new JqError(value);
}

/** `.name` */
export function field(value: Value, name: string): Value {
	if (value === null) {
		return null;
	} else if (isObject(value)) {
		return Object.hasOwn(value, name) ? value[name]! : null;
	}
	throw new JqError(`Cannot index ${typeOf(value)} with ${describe(name)}`);
}

/** `.[index]` on an array; a fractional index truncates and a negative one counts from the end. */
export function element(value: Value, index: number): Value {
	if (value === null) {
		return null;
	} else if (Array.isArray(value)) {
		const whole = Math.trunc(index);
		const at = whole < 0 ? value.length + whole : whole;
		return at >= 0 && at < value.length ? value[at]! : null;
	}
	throw new JqError(`Cannot index ${typeOf(value)} with ${describe(index)}`);
}

/** `.[key]` for any key: a string, a number, or a slice `{start, end}`. */
export function index(value: Value, key: Value): Value {
	if (typeof key === 'string') {
		return field(value, key);
	} else if (typeof key === 'number') {
		return element(value, key);
	} else if (isObject(key) && (value === null || Array.isArray(value) || typeof value === 'string')) {
		return slice(value, key.start ?? null, key.end ?? null);
	}
	throw new JqError(`Cannot index ${typeOf(value)} with ${describe(key)}`);
}

/** `.[from:to]` — of an array or string. Bounds are clamped; negative ones count from the end. */
export function slice(value: Value, from: Value, to: Value): Value {
	if (value === null) {
		return null;
	} else if ((from !== null && typeof from !== 'number') || (to !== null && typeof to !== 'number')) {
		throw new JqError('Start and end indices of an array slice must be numbers');
	} else if (typeof value === 'string' || Array.isArray(value)) {
		const [ start, end ] = sliceBounds(value.length, from, to);
		return value.slice(start, end);
	}
	throw new JqError(`Cannot index ${typeOf(value)} with object ({"start":${tojson(from)},"end":${tojson(to)}})`);
}

/** Resolves slice bounds against a length: the start floors, the end ceils, and both clamp. */
export function sliceBounds(length: number, from: number | null, to: number | null): [ number, number ] {
	const resolve = (bound: number) => {
		const offset = bound < 0 ? length + bound : bound;
		return Math.max(0, Math.min(length, offset));
	};
	const start = from === null ? 0 : resolve(Math.floor(from));
	const end = to === null ? length : resolve(Math.ceil(to));
	return [ start, Math.max(start, end) ];
}

/** `.[]` — the elements of an array or the values of an object. */
export function iterate(value: Value): Iterable<Value> {
	if (Array.isArray(value)) {
		return value;
	} else if (isObject(value)) {
		return Object.values(value);
	}
	throw new JqError(`Cannot iterate over ${describe(value)}`);
}

/** `..`: a value and everything beneath it, depth first. */
export function *recurse(value: Value): Generator<Value> {
	yield value;
	if (typeof value === 'object' && value !== null) {
		for (const child of iterate(value)) {
			yield* recurse(child);
		}
	}
}

/** `..` as paths. */
export function *recursePaths(path: Path, value: Value): Generator<[ Path, Value ]> {
	yield [ path, value ];
	if (typeof value === 'object' && value !== null) {
		for (const key of keysOf(value)) {
			yield* recursePaths([ ...path, key ], index(value, key));
		}
	}
}

/** The keys `.[]` visits, in the order it visits them — for walking a value alongside its paths. */
export function keysOf(value: Value): (number | string)[] {
	if (Array.isArray(value)) {
		return Array.from(value, (_value, ii) => ii);
	} else if (isObject(value)) {
		return Object.keys(value);
	}
	throw new JqError(`Cannot iterate over ${describe(value)}`);
}

/** `keys` — sorted; array keys are indices. */
export function keys(value: Value): Value {
	if (Array.isArray(value)) {
		return keysOf(value);
	} else if (isObject(value)) {
		return Object.keys(value).sort();
	}
	throw new JqError(`${describe(value)} has no keys`);
}

export function has(value: Value, key: Value): boolean {
	if (isObject(value) && typeof key === 'string') {
		return Object.hasOwn(value, key);
	} else if (Array.isArray(value) && typeof key === 'number') {
		return key >= 0 && key < value.length;
	}
	throw new JqError(`Cannot check whether ${typeOf(value)} has a ${typeOf(key)} key`);
}

export function length(value: Value): number {
	if (typeof value === 'string') {
		return value.length;
	} else if (typeof value === 'number') {
		return Math.abs(value);
	} else if (typeof value === 'boolean') {
		throw new JqError(`${describe(value)} has no length`);
	} else if (value === null) {
		return 0;
	} else if (Array.isArray(value)) {
		return value.length;
	}
	return Object.keys(value).length;
}

export function add(left: Value, right: Value): Value {
	if (typeof left === 'number' && typeof right === 'number') {
		return left + right;
	} else if (left === null) {
		return right;
	} else if (right === null) {
		return left;
	} else if (typeof left === 'string' && typeof right === 'string') {
		return left + right;
	} else if (Array.isArray(left) && Array.isArray(right)) {
		return [ ...left, ...right ];
	} else if (isObject(left) && isObject(right)) {
		return Object.assign(copyObject(left), right);
	}
	throw new JqError(`${describe(left)} and ${describe(right)} cannot be added`);
}

export function subtract(left: Value, right: Value): Value {
	if (typeof left === 'number' && typeof right === 'number') {
		return left - right;
	} else if (Array.isArray(left) && Array.isArray(right)) {
		return left.filter(value => !right.some(other => equal(value, other)));
	}
	throw new JqError(`${describe(left)} and ${describe(right)} cannot be subtracted`);
}

export function multiply(left: Value, right: Value): Value {
	if (typeof left === 'number' && typeof right === 'number') {
		return left * right;
	} else if (typeof left === 'string' && typeof right === 'number') {
		return repeat(left, right);
	} else if (typeof left === 'number' && typeof right === 'string') {
		return repeat(right, left);
	} else if (isObject(left) && isObject(right)) {
		return merge(left, right);
	}
	throw new JqError(`${describe(left)} and ${describe(right)} cannot be multiplied`);
}

function repeat(text: string, count: number): Value {
	return count < 0 || Number.isNaN(count) ? null : text.repeat(Math.floor(count));
}

/** Recursive object merge: where both sides hold an object under a key, those merge too. */
function merge(left: ValueObject, right: ValueObject): ValueObject {
	const result = copyObject(left);
	for (const key of Object.keys(right)) {
		const value = right[key]!;
		const existing = Object.hasOwn(result, key) ? result[key]! : null;
		result[key] = isObject(existing) && isObject(value) ? merge(existing, value) : value;
	}
	return result;
}

export function divide(left: Value, right: Value): Value {
	if (typeof left === 'number' && typeof right === 'number') {
		if (right === 0) {
			throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided because the divisor is zero`);
		}
		return left / right;
	} else if (typeof left === 'string' && typeof right === 'string') {
		return split(left, right);
	}
	throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided`);
}

/** `split(separator)` — an empty string splits into nothing. */
export function split(text: string, separator: string): string[] {
	return text === '' ? [] : text.split(separator);
}

export function modulo(left: Value, right: Value): Value {
	if (typeof left === 'number' && typeof right === 'number') {
		const divisor = Math.trunc(right);
		if (divisor === 0) {
			throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided (remainder) because the divisor is zero`);
		}
		return Math.trunc(left) % divisor;
	}
	throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided (remainder)`);
}

export function negate(value: Value): Value {
	if (typeof value === 'number') {
		return -value;
	}
	throw new JqError(`${describe(value)} cannot be negated`);
}

/** The key of an object construction, which must be a string. */
export function toKey(value: Value): string {
	if (typeof value === 'string') {
		return value;
	}
	throw new JqError('Object keys must be strings');
}

function assertPath(path: Value): Value[] {
	if (Array.isArray(path)) {
		return path;
	}
	throw new JqError('Path must be specified as an array');
}

export function getpath(value: Value, path: Value): Value {
	let current = value;
	for (const key of assertPath(path)) {
		if (current === null) {
			return null;
		}
		current = index(current, key);
	}
	return current;
}

export function setpath(value: Value, path: Value, replacement: Value): Value {
	return setAt(value, assertPath(path), 0, replacement);
}

function setAt(value: Value, path: Value[], depth: number, replacement: Value): Value {
	if (depth === path.length) {
		return replacement;
	}
	const key = path[depth]!;
	const current = index(value, key);
	const updated = setAt(current, path, depth + 1, replacement);
	return setKey(value, key, updated);
}

/** A copy of `value` with `key` set — the one place a container is rebuilt around a new member. */
function setKey(value: Value, key: Value, updated: Value): Value {
	if (typeof key === 'string') {
		const result = value === null ? newObject() : copyObject(value as ValueObject);
		result[key] = updated;
		return result;
	} else if (typeof key === 'number') {
		const array = value === null ? [] : [ ...value as Value[] ];
		const whole = Math.trunc(key);
		const at = whole < 0 ? array.length + whole : whole;
		if (at < 0) {
			throw new JqError('Out of bounds negative array index');
		}
		while (array.length < at) {
			array.push(null);
		}
		array[at] = updated;
		return array;
	} else if (isObject(key)) {
		if (!Array.isArray(updated)) {
			throw new JqError('A slice of an array can only be assigned another array');
		}
		const array = value === null ? [] : value as Value[];
		const from = key.start ?? null;
		const to = key.end ?? null;
		if ((from !== null && typeof from !== 'number') || (to !== null && typeof to !== 'number')) {
			throw new JqError('Start and end indices of an array slice must be numbers');
		}
		const [ start, end ] = sliceBounds(array.length, from, to);
		return [ ...array.slice(0, start), ...updated, ...array.slice(end) ];
	}
	throw new JqError(`Cannot update field at object index of ${typeOf(value)}`);
}

/** Deletes every path, longest and last first, so that deleting one never moves another. */
export function delpaths(value: Value, paths: Value): Value {
	if (!Array.isArray(paths)) {
		throw new JqError('Paths must be specified as an array');
	}
	const sorted = paths.map(path => {
		if (!Array.isArray(path)) {
			throw new JqError(`Path must be specified as array, not ${typeOf(path)}`);
		}
		return path;
	}).sort(compare).reverse();
	let result = value;
	for (const path of sorted) {
		result = deleteAt(result, path, 0);
	}
	return result;
}

function deleteAt(value: Value, path: Value[], depth: number): Value {
	if (depth === path.length) {
		return null;
	} else if (value === null) {
		return null;
	}
	const key = path[depth]!;
	if (depth === path.length - 1) {
		return deleteKey(value, key);
	}
	const current = index(value, key);
	if (current === null) {
		return value;
	}
	return setKey(value, key, deleteAt(current, path, depth + 1));
}

function deleteKey(value: Value, key: Value): Value {
	if (typeof key === 'string') {
		if (!isObject(value)) {
			throw new JqError(`Cannot delete field at object index of ${typeOf(value)}`);
		} else if (!Object.hasOwn(value, key)) {
			return value;
		}
		const result = copyObject(value);
		delete result[key];
		return result;
	} else if (typeof key === 'number') {
		if (!Array.isArray(value)) {
			throw new JqError(`Cannot delete field at array index of ${typeOf(value)}`);
		}
		const whole = Math.trunc(key);
		const at = whole < 0 ? value.length + whole : whole;
		if (at < 0 || at >= value.length) {
			return value;
		}
		return [ ...value.slice(0, at), ...value.slice(at + 1) ];
	} else if (isObject(key)) {
		if (!Array.isArray(value)) {
			throw new JqError(`Cannot delete slice of ${typeOf(value)}`);
		}
		const from = key.start ?? null;
		const to = key.end ?? null;
		if ((from !== null && typeof from !== 'number') || (to !== null && typeof to !== 'number')) {
			throw new JqError('Start and end indices of an array slice must be numbers');
		}
		const [ start, end ] = sliceBounds(value.length, from, to);
		return [ ...value.slice(0, start), ...value.slice(end) ];
	}
	throw new JqError(`Cannot delete ${describe(key)} element of ${typeOf(value)}`);
}

/**
 * Applies a sequence of updates to one value, as `|=` and `=` do, without copying the whole value
 * for each. The first update along a path copies the containers it passes through and remembers
 * them as its own; later updates through the same containers write in place, since nothing else
 * can see them yet. `result` is the value with every update applied.
 */
export class Editor {
	private root: Value;
	private readonly owned = new Set<object>();

	constructor(root: Value) {
		this.root = root;
	}

	get(path: Value): Value {
		return getpath(this.root, path);
	}

	set(path: Value, value: Value): void {
		this.root = this.setAt(this.root, assertPath(path), 0, value);
	}

	result(): Value {
		return this.root;
	}

	private setAt(value: Value, path: Value[], depth: number, replacement: Value): Value {
		if (depth === path.length) {
			return replacement;
		}
		const key = path[depth]!;
		const updated = this.setAt(index(value, key), path, depth + 1, replacement);
		if (typeof value === 'object' && value !== null && this.owned.has(value)) {
			if (typeof key === 'string') {
				(value as ValueObject)[key] = updated;
				return value;
			} else if (typeof key === 'number') {
				const array = value as Value[];
				const whole = Math.trunc(key);
				const at = whole < 0 ? array.length + whole : whole;
				if (at >= 0 && at < array.length) {
					array[at] = updated;
					return value;
				}
			}
		}
		const result = setKey(value, key, updated);
		this.owned.add(result as object);
		return result;
	}
}

/**
 * Runs `body` under `try`: its errors go to `handler` — or end the stream, when there is none —
 * while errors raised by whoever consumes the stream pass through untouched, since they happen
 * between one `next` and the following. That is what makes `try` cover only its own body.
 */
export function *tryCatch<Type>(body: Iterable<Type>, handler: ((error: Value) => Iterable<Type>) | null): Iterable<Type> {
	const iterator = body[Symbol.iterator]();
	while (true) {
		const next = function() {
			try {
				return iterator.next();
			} catch (error) {
				if (error instanceof JqError) {
					return error;
				}
				throw error;
			}
		}();
		if (next instanceof JqError) {
			if (handler !== null) {
				yield* handler(next.value);
			}
			return;
		} else if (next.done === true) {
			return;
		}
		yield next.value;
	}
}

export function invalidPath(value: Value): never {
	throw new JqError(`Invalid path expression with result ${tojson(value)}`);
}

/** `halt` and `halt_error`. */
export function halt(code: number, value?: Value): never {
	// eslint-disable-next-line @typescript-eslint/only-throw-error
	throw new Halt(code, value);
}

/** `.[]?` — the elements of a container, or nothing at all for anything else. */
export function iterateOptional(value: Value): Iterable<Value> {
	if (Array.isArray(value)) {
		return value;
	} else if (isObject(value)) {
		return Object.values(value);
	}
	return [];
}

/** The keys `.[]?` visits: none, for a value with no members. */
export function keysOfOptional(value: Value): (number | string)[] {
	return Array.isArray(value) || isObject(value) ? keysOf(value) : [];
}

/** `@name` string formats. */
const formats: Readonly<Record<string, (value: Value) => string>> = {
	text: tostring,
	json: value => tojson(value),
	base64: value => Buffer.from(tostring(value), 'utf8').toString('base64'),
	base64d: value => Buffer.from(tostring(value), 'base64').toString('utf8'),
};

export function isFormat(name: string): boolean {
	return Object.hasOwn(formats, name);
}

export function format(name: string, value: Value): string {
	return formats[name]!(value);
}
