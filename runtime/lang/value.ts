/**
 * What a value is to every runtime: plain JSON as JavaScript holds it, deep equality, and JSON to
 * and from. A boxed `Number` counts as a number — JavaScript coerces one wherever a number is
 * used, and `isNumber` says so — which is what lets a runtime carry more on a number than its
 * value. Ordering is the one thing left out: JavaScript's is `runtime/js/value.ts`'s, jq's total
 * order the jq runtime's. Nothing here mutates a value it was given; a result that differs from
 * its input is a new value sharing whatever it can.
 */
import type { Value, ValueObject } from '#/compiler/filter.js';

export type ValueType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

/**
 * An error a filter raised — `error("…")`, a failed index, a type mismatch. It carries a value, as
 * jq's errors do, which is what `try … catch .` receives. Anything else thrown while a filter runs
 * is a bug in the runtime rather than a condition the filter can handle, and passes through `try`.
 */
export class JqError extends Error {
	override name = 'JqError';
	readonly value: Value;

	constructor(value: Value) {
		super(isString(value) ? String(value) : `${tojson(value)} (not a string)`);
		this.value = value;
	}
}

/** Thrown by `halt` and `halt_error`; the driver exits with the code. */
export class Halt {
	readonly code: number;
	/** What `halt_error` was given, to print before exiting; `halt` has none. */
	readonly value: Value | undefined;

	constructor(code: number, value?: Value) {
		this.code = code;
		this.value = value;
	}
}

export function typeOf(value: Value): ValueType {
	const type = typeof value;
	if (type === 'boolean' || type === 'number' || type === 'string') {
		return type;
	} else if (value === null) {
		return 'null';
	} else if (Array.isArray(value)) {
		return 'array';
	} else if (value instanceof Number) {
		return 'number';
	} else if (value instanceof String) {
		return 'string';
	} else {
		return 'object';
	}
}

/** A number, boxed or not: a boxed `Number` behaves as its number wherever one is used, and the type says as much. */
export function isNumber(value: Value): value is number {
	return typeof value === 'number' || value instanceof Number;
}

/** A string, boxed or not: a boxed `String` behaves as its characters wherever they are read, and the type says as much. */
export function isString(value: Value): value is string {
	return typeof value === 'string' || value instanceof String;
}

export function isObject(value: Value): value is ValueObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Number) && !(value instanceof String);
}

/**
 * A string an embedder boxes, to carry more than its characters — as the jq flavor's `Numeral`
 * carries a number's spelling on a boxed `Number`. The machinery counts any boxed `String` as a
 * string, `isString` says so, and an operation that makes a new string unwraps to a plain one;
 * this class is the sanctioned base for an embedder's brands. Nothing in the runtimes makes one.
 */
export class Text extends String {}

/** A value as an error message names it: `number (1)`, `string ("abc…)`. */
export function describe(value: Value): string {
	const json = tojson(value);
	return `${typeOf(value)} (${json.length > 14 ? `${json.slice(0, 11)}...` : json})`;
}

/**
 * Writes a value as JSON, compact, and with `indent` spaces per level when asked. Infinite numbers
 * are written as the largest finite ones, as jq writes them; NaN is `null`, as JSON has nothing
 * else; and -0 keeps its sign, which `JSON.stringify` would drop.
 */
export function tojson(value: Value, indent?: number | string): string {
	return JSON.stringify(value, replacer, indent);
}

function replacer(this: unknown, _key: string, value: unknown): unknown {
	if (typeof value === 'number' && !Number.isFinite(value) && !Number.isNaN(value)) {
		return value > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
	} else if (value === 0 && Object.is(value, -0)) {
		return JSON.rawJSON('-0');
	}
	return value;
}

export function fromjson(text: string): Value {
	try {
		return JSON.parse(text) as Value;
	} catch (error) {
		throw new JqError(`${(error as Error).message} (while parsing '${text}')`);
	}
}

/** Strings are themselves; anything else is its JSON. */
export function tostring(value: Value): string {
	return isString(value) ? String(value) : tojson(value);
}

/** Strings against strings, by code unit, which every ordering shares; a box compares as its characters. */
export function compareStrings(left: string, right: string): number {
	const lhs = String(left);
	const rhs = String(right);
	if (lhs === rhs) {
		return 0;
	} else {
		return lhs < rhs ? -1 : 1;
	}
}

/** Deep equality. Numbers compare as numbers, boxed or not, so `nan == nan` is false and `-0 == 0` is true. */
export function equal(left: Value, right: Value): boolean {
	if (left === right) {
		return true;
	} else if (isNumber(left)) {
		return isNumber(right) && Number(left) === Number(right);
	} else if (isNumber(right)) {
		return false;
	} else if (isString(left)) {
		return isString(right) && String(left) === String(right);
	} else if (isString(right)) {
		return false;
	} else if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
		return false;
	} else if (Array.isArray(left)) {
		return Array.isArray(right) && left.length === right.length && left.every((value, ii) => equal(value, right[ii]!));
	} else if (Array.isArray(right)) {
		return false;
	} else {
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length &&
			keys.every(key => Object.hasOwn(right, key) && equal(left[key]!, right[key]!));
	}
}

/**
 * Deep containment, as jq has it: a string contains its substrings, an array whatever each of the
 * other's elements is contained by one of its own, an object by key, and a scalar what it equals.
 * Kinds that cannot hold one another refuse at the top; inside a container a mismatch is simply
 * not contained.
 */
export function contains(left: Value, right: Value): boolean {
	if (typeOf(left) !== typeOf(right)) {
		throw new JqError(`${describe(left)} and ${describe(right)} cannot have their containment checked`);
	}
	return containedIn(left, right);
}

function containedIn(left: Value, right: Value): boolean {
	if (isString(left) && isString(right)) {
		return left.includes(right);
	} else if (Array.isArray(left) && Array.isArray(right)) {
		return right.every(element => left.some(item => containedIn(item, element)));
	} else if (isObject(left) && isObject(right)) {
		return Object.keys(right).every(key => Object.hasOwn(left, key) && containedIn(left[key]!, right[key]!));
	} else {
		return equal(left, right);
	}
}

/**
 * Objects this language makes have no prototype, so every key — `__proto__` included — is an
 * ordinary own property that plain assignment sets. Input may still carry `Object.prototype`, which
 * is why reads go through `Object.hasOwn`.
 */
export function newObject(): ValueObject {
	return Object.create(null) as ValueObject;
}

export function copyObject(object: ValueObject): ValueObject {
	return { __proto__: null, ...object };
}
