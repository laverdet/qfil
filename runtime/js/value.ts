/**
 * What a value is to this runtime: jq's ordering, equality and JSON conversions over the plain
 * JSON values the contract declares. Nothing here mutates a value it was given; a result that
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
	}
	return Array.isArray(value) ? 'array' : 'object';
}

export function isObject(value: Value): value is ValueObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function fromjson(text: string): Value {
	try {
		return JSON.parse(text) as Value;
	} catch (error) {
		throw new JqError(`${(error as Error).message} (while parsing '${text}')`);
	}
}

/** Strings are themselves; anything else is its JSON. */
export function tostring(value: Value): string {
	return typeof value === 'string' ? value : tojson(value);
}

const numberRegex = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const specialNumberRegex = /^-?(?:nan|infinity)$/i;

export function tonumber(value: Value): number {
	if (typeof value === 'number') {
		return value;
	} else if (typeof value === 'string' && (numberRegex.test(value) || specialNumberRegex.test(value))) {
		return Number(value.replace(/nan$/i, 'NaN'));
	}
	throw new JqError(`${describe(value)} cannot be parsed as a number`);
}

const typeOrder: Readonly<Record<ValueType, number>> = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };

/**
 * jq's total order: null < false < true < numbers < strings < arrays < objects. Strings compare by
 * UTF-16 code unit, arrays lexicographically, objects first by their sorted key sets then value by value.
 * NaN sorts below every number, including itself.
 */
export function compare(left: Value, right: Value): number {
	if (left === right) {
		return 0;
	}
	const leftType = typeOf(left);
	const rightType = typeOf(right);
	if (leftType !== rightType) {
		return typeOrder[leftType] - typeOrder[rightType];
	}
	switch (leftType) {
		case 'null':
			return 0;
		case 'boolean':
			return left === true ? 1 : -1;
		case 'number': {
			const lhs = left as number;
			const rhs = right as number;
			if (Number.isNaN(lhs)) {
				return -1;
			} else if (Number.isNaN(rhs) || lhs > rhs) {
				return 1;
			}
			return lhs < rhs ? -1 : 0;
		}
		case 'string':
			return compareStrings(left as string, right as string);
		case 'array': {
			const lhs = left as Value[];
			const rhs = right as Value[];
			const length = Math.min(lhs.length, rhs.length);
			for (let ii = 0; ii < length; ++ii) {
				const order = compare(lhs[ii]!, rhs[ii]!);
				if (order !== 0) {
					return order;
				}
			}
			return lhs.length - rhs.length;
		}
		case 'object': {
			const lhs = left as ValueObject;
			const rhs = right as ValueObject;
			const lhsKeys = Object.keys(lhs).sort(compareStrings);
			const rhsKeys = Object.keys(rhs).sort(compareStrings);
			const order = compare(lhsKeys, rhsKeys);
			if (order !== 0) {
				return order;
			}
			for (const key of lhsKeys) {
				const order = compare(lhs[key]!, rhs[key]!);
				if (order !== 0) {
					return order;
				}
			}
			return 0;
		}
	}
}

export function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0;
	} else {
		return left < right ? -1 : 1;
	}
}

/** Deep equality. Numbers compare as numbers, so `nan == nan` is false and `-0 == 0` is true. */
export function equal(left: Value, right: Value): boolean {
	if (left === right) {
		return true;
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
