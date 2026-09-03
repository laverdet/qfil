/**
 * jq's numbers and jq's order. A number literal, or a number read from JSON, keeps its spelling —
 * the canonical decimal form jq gives it: `1.000`, `1E+2`, `11.0` — until arithmetic touches it;
 * and values sort in jq's total order, null < false < true < numbers < strings < arrays < objects.
 *
 * A spelled number is a boxed `Number` that remembers its text, so JavaScript itself does the
 * unwrapping: arithmetic, comparison and indexing coerce it, `JSON.stringify` writes the spelling
 * through the box's own `toJSON`, and the JavaScript runtime already counts a boxed `Number` as a
 * number. Nothing over there is any the wiser.
 */
import type { Value, ValueObject } from '#/compiler/filter.js';
import type { ValueType } from '#/runtime/js/value.js';
import { compareStrings, fromjson as parseJson, tonumber as tonumberOf, typeOf } from '#/runtime/js/value.js';

/**
 * A number that remembers how it was spelled; a `Number` in every other respect. Only a decimal
 * literal is ever boxed, so the number is never NaN — at worst `1e1000`, an Infinity spelled `1E+1000`.
 */
export class Spelled extends Number {
	readonly text: string;

	constructor(value: number, text: string) {
		super(value);
		this.text = text;
	}

	/** Written into JSON verbatim, which is the point of remembering. */
	toJSON(): unknown {
		return JSON.rawJSON(this.text);
	}
}

const decimalRegex = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * The canonical spelling of a decimal literal, as the General Decimal Arithmetic specification —
 * and so jq, through decNumber — writes it: the digits as given, and a decimal point or an
 * exponent as the magnitude calls for. `1e2` is `1E+2`, `1.10e1` is `11.0`, `0.10` is itself.
 */
function canonical(text: string): string {
	const [ , sign, whole, fraction = '', exponent = '0' ] = decimalRegex.exec(text)!;
	const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
	const scale = Number(exponent) - fraction.length;
	const adjusted = scale + digits.length - 1;
	if (scale <= 0 && adjusted >= -6) {
		if (scale === 0) {
			return `${sign}${digits}`;
		}
		const point = digits.length + scale;
		return point > 0
			? `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
			: `${sign}0.${'0'.repeat(-point)}${digits}`;
	}
	const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
	return `${sign}${mantissa}E${adjusted < 0 ? '-' : '+'}${Math.abs(adjusted)}`;
}

/** A number with its spelling, when that says more than the number does. */
export function spelled(value: number, text: string): Value {
	const written = canonical(text);
	// A boxed number is a `Value` in behaviour; the contract's type cannot spell it
	return written === String(value) ? value : new Spelled(value, written) as unknown as Value;
}

const literalRegex = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** `tonumber`: a string that is a decimal literal keeps its spelling. */
export function tonumber(value: Value): Value {
	return typeof value === 'string' && literalRegex.test(value) ? spelled(Number(value), value) : tonumberOf(value);
}

/** JSON with the spelling of each number kept. */
export function fromjson(text: string): Value {
	return parseJson(text, (_key, value, context) => typeof value === 'number' && context.source !== undefined ? spelled(value, context.source) : value);
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
			const lhs = Number(left);
			const rhs = Number(right);
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
