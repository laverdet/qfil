/**
 * What a value is to this runtime: plain JSON as JavaScript holds it, JavaScript's order, deep
 * equality, and JSON to and from. A boxed `Number` counts as a number — JavaScript coerces one
 * wherever a number is used, and `isNumber` says so — which is what lets another runtime carry
 * more on a number than its value. Nothing here mutates a value it was given; a result that
 * differs from its input is a new value sharing whatever it can.
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
		super(typeof value === 'string' ? value : `${tojson(value)} (not a string)`);
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
	} else {
		return 'object';
	}
}

/** A number, boxed or not: a boxed `Number` behaves as its number wherever one is used, and the type says as much. */
export function isNumber(value: Value): value is number {
	return typeof value === 'number' || value instanceof Number;
}

export function isObject(value: Value): value is ValueObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Number);
}

/** jq's truth: everything but `null` and `false`. */
export function truthy(value: Value): boolean {
	return value !== null && value !== false;
}

/** A value as an error message names it: `number (1)`, `string ("abc…)`. */
export function describe(value: Value): string {
	const json = tojson(value);
	return `${typeOf(value)} (${json.length > 14 ? `${json.slice(0, 11)}...` : json})`;
}

/**
 * Writes a value as JSON, compact, and with `indent` spaces per level when asked. Infinite numbers
 * are written as the largest finite ones, as jq writes them; NaN is `null`, as JSON has nothing else.
 */
export function tojson(value: Value, indent?: number | string): string {
	return JSON.stringify(value, replacer, indent);
}

function replacer(this: unknown, _key: string, value: unknown): unknown {
	if (typeof value === 'number' && !Number.isFinite(value) && !Number.isNaN(value)) {
		return value > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
	}
	return value;
}

/** A JSON reviver that also sees the source text of each primitive, as Node's does. */
export type Reviver =
	(this: unknown, key: string, value: unknown, context: { readonly source?: string }) => unknown;

export function fromjson(text: string, reviver?: Reviver): Value {
	try {
		return JSON.parse(text, reviver) as Value;
	} catch (error) {
		throw new JqError(`${(error as Error).message} (while parsing '${text}')`);
	}
}

/** Strings are themselves; anything else is its JSON. */
export function tostring(value: Value): string {
	return typeof value === 'string' ? value : tojson(value);
}

const numberRegex = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|nan|infinity)$/i;

export function tonumber(value: Value): number {
	if (isNumber(value)) {
		return value;
	} else if (typeof value === 'string' && numberRegex.test(value)) {
		return Number(value);
	}
	throw new JqError(`${describe(value)} cannot be parsed as a number`);
}

/**
 * JavaScript's ordering: strings against strings by code unit, and everything else by subtraction
 * — NaN for a container, JavaScript's coercions otherwise. jq's total order is the jq runtime's.
 */
export function compare(left: Value, right: Value): number {
	if (typeof left === 'string' && typeof right === 'string') {
		return compareStrings(left, right);
	} else {
		return toNumber(left) - toNumber(right);
	}
}

/** A value as subtraction would take it: a container has no number to it — and no prototype to coerce with, `Number` would throw. */
function toNumber(value: Value): number {
	if (typeof value !== 'object' || value instanceof Number) {
		return Number(value);
	} else {
		return NaN;
	}
}

export function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0;
	} else {
		return left < right ? -1 : 1;
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
	} else if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
		return false;
	} else if (Array.isArray(left)) {
		return Array.isArray(right) && left.length === right.length && left.every((value, ii) => equal(value, right[ii]!));
	} else if (Array.isArray(right)) {
		return false;
	}
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length &&
		keys.every(key => Object.hasOwn(right, key) && equal(left[key]!, right[key]!));
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
