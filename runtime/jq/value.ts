/**
 * jq's numbers and jq's order. A number literal, or a number read from JSON, keeps its spelling —
 * the canonical decimal form jq gives it: `1.000`, `1E+2`, `11.0` — until arithmetic touches it;
 * and values sort in jq's total order, null < false < true < numbers < strings < arrays < objects.
 *
 * A `Numeral` is a boxed `Number` that remembers its text, so JavaScript itself does the
 * unwrapping: arithmetic, comparison and indexing coerce it, `JSON.stringify` writes the spelling
 * through the box's own `toJSON`, and the JavaScript runtime already counts a boxed `Number` as a
 * number. Nothing over there is any the wiser.
 */
import type { Value, ValueObject } from '#/compiler/filter.js';
import type { ValueType } from '#/runtime/lang/value.js';
import { JqError, compareStrings, describe, isNumber, isString, newObject, typeOf } from '#/runtime/lang/value.js';

/**
 * A number that remembers how it was spelled; a `Number` in every other respect. Only a decimal
 * literal is ever boxed, so the number is never NaN — at worst `1e1000`, an Infinity spelled `1E+1000`.
 */
export class Numeral extends Number {
	readonly text: string;

	constructor(value: number, text: string) {
		super(value);
		this.text = text;
	}

	/** Written into JSON verbatim, which is the point of remembering. */
	toJSON(): unknown {
		return JSON.rawJSON(this.text);
	}

	/** The spelling is the string of it, so `String(a boxed number)` reads the text back. */
	override toString(): string {
		return this.text;
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
		} else {
			const point = digits.length + scale;
			return point > 0
				? `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
				: `${sign}0.${'0'.repeat(-point)}${digits}`;
		}
	} else {
		const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
		return `${sign}${mantissa}E${adjusted < 0 ? '-' : '+'}${Math.abs(adjusted)}`;
	}
}

/** A number with its spelling, when that says more than the number does. */
export function spelled(value: number, text: string): Value {
	const written = canonical(text);
	// A boxed number is a `Value` in behavior; the contract's type cannot spell it
	return written === String(value) ? value : new Numeral(value, written) as unknown as Value;
}

const literalRegex = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** jq's truth: everything but `null` and `false`; 0, NaN and the empty string are true. */
export function truthy(value: Value): boolean {
	return value !== null && value !== false;
}

const numberRegex = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|nan|infinity)$/i;

/** `tonumber`: a string that is a decimal literal keeps its spelling; the rest read as C's strtod does. */
export function tonumber(value: Value): Value {
	if (isString(value)) {
		if (literalRegex.test(value)) {
			return spelled(Number(value), String(value));
		} else if (numberRegex.test(value)) {
			return Number(value);
		}
	} else if (isNumber(value)) {
		return value;
	}
	throw new JqError(`${describe(value)} cannot be parsed as a number`);
}

/** The single-character escapes of a JSON string, keyed by the character after the backslash. */
const escapes: Readonly<Record<string, string>> = {
	'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/**
 * JSON with the spelling of each number kept, parsed by hand. `JSON.parse` with source access
 * revives every value through a callback; reading the text directly costs a spelling check only
 * where a number could spell more than it is, and makes each object without a prototype, as the
 * runtime makes them.
 */
export function fromjson(text: string): Value {
	// A leading byte order mark is passed over, as jq's reader has it
	let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const result = parse();
	space();
	if (at < text.length) {
		throw failure('Unexpected trailing characters');
	}
	return result;

	function failure(reason: string): JqError {
		return new JqError(`${reason} at position ${at} (while parsing '${text}')`);
	}

	function space(): void {
		while (true) {
			const code = text.charCodeAt(at);
			if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
				++at;
			} else {
				return;
			}
		}
	}

	function parse(): Value {
		space();
		switch (text.charCodeAt(at)) {
			case 0x7b: return object(); // {
			case 0x5b: return array(); // [
			case 0x22: return string(); // "
			case 0x74: return keyword('true', true); // t
			case 0x66: return keyword('false', false); // f
			case 0x6e: return text.startsWith('null', at) ? keyword('null', null) : number(); // n
			default: return number();
		}
	}

	function keyword(name: string, value: Value): Value {
		if (text.startsWith(name, at)) {
			at += name.length;
			return value;
		}
		throw failure('Unexpected token');
	}

	function object(): Value {
		++at;
		const result = newObject();
		space();
		if (text.charCodeAt(at) === 0x7d /* } */) {
			++at;
			return result;
		}
		while (true) {
			space();
			if (text.charCodeAt(at) !== 0x22 /* " */) {
				throw failure('Expected string key');
			}
			const key = string();
			space();
			if (text.charCodeAt(at) !== 0x3a /* : */) {
				throw failure("Expected ':'");
			}
			++at;
			result[key] = parse();
			space();
			const code = text.charCodeAt(at);
			if (code === 0x7d /* } */) {
				++at;
				return result;
			} else if (code === 0x2c /* , */) {
				++at;
			} else {
				throw failure("Expected ',' or '}'");
			}
		}
	}

	function array(): Value {
		++at;
		const result: Value[] = [];
		space();
		if (text.charCodeAt(at) === 0x5d /* ] */) {
			++at;
			return result;
		}
		while (true) {
			result.push(parse());
			space();
			const code = text.charCodeAt(at);
			if (code === 0x5d /* ] */) {
				++at;
				return result;
			} else if (code === 0x2c /* , */) {
				++at;
			} else {
				throw failure("Expected ',' or ']'");
			}
		}
	}

	function string(): string {
		++at;
		let result = '';
		let chunk = at;
		while (true) {
			const code = text.charCodeAt(at);
			if (code === 0x22 /* " */) {
				result += text.slice(chunk, at);
				++at;
				return result;
			} else if (code === 0x5c /* \ */) {
				result += text.slice(chunk, at);
				result += escape();
				chunk = at;
			} else if (code >= 0x20) {
				++at;
			} else if (Number.isNaN(code)) {
				throw failure('Unterminated string');
			} else {
				throw failure('Unescaped control character');
			}
		}
	}

	function escape(): string {
		const char = text[at + 1];
		at += 2;
		const known = char === undefined ? undefined : escapes[char];
		if (known !== undefined) {
			return known;
		} else if (char === 'u') {
			const hex = text.slice(at, at + 4);
			if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
				at += 4;
				return String.fromCharCode(parseInt(hex, 16));
			}
			throw failure('Invalid \\u escape');
		} else {
			throw failure('Invalid escape');
		}
	}

	// Numbers are lenient, as jq's own scanner is: an optional `+` or `-`, then `nan`, `inf` or
	// `infinity` in any case, or digits with leading zeros allowed and a decimal point needing a
	// digit on one side only
	function number(): Value {
		const sign = text.charCodeAt(at);
		const negative = sign === 0x2d; // -
		if (negative || sign === 0x2b /* + */) {
			++at;
		}
		const start = at;
		const first = text.charCodeAt(at);
		if (first === 0x6e /* n */ || first === 0x4e /* N */) {
			return named('nan', NaN);
		} else if (first === 0x69 /* i */ || first === 0x49 /* I */) {
			const value = named('inf', negative ? -Infinity : Infinity);
			if (text.slice(at, at + 5).toLowerCase() === 'inity') {
				at += 5;
			}
			return value;
		}
		while (isDigit(text.charCodeAt(at))) {
			++at;
		}
		const integer = at - start;
		let plain = integer >= 1 && integer <= 15 && !(negative && first === 0x30);
		if (text.charCodeAt(at) === 0x2e /* . */) {
			plain = false;
			++at;
			while (isDigit(text.charCodeAt(at))) {
				++at;
			}
			if (at - start === 1) {
				// `5.` stands and `.5` stands; `.` alone does not
				throw failure('Expected digit');
			}
		} else if (integer === 0) {
			throw failure('Unexpected token');
		}
		const code = text.charCodeAt(at);
		if (code === 0x65 /* e */ || code === 0x45 /* E */) {
			plain = false;
			++at;
			const exponentSign = text.charCodeAt(at);
			if (exponentSign === 0x2b /* + */ || exponentSign === 0x2d /* - */) {
				++at;
			}
			if (!isDigit(text.charCodeAt(at))) {
				throw failure('Expected digit');
			}
			do {
				++at;
			} while (isDigit(text.charCodeAt(at)));
		}
		// The source drops a `+`, which the canonical spelling never carries
		const source = negative ? `-${text.slice(start, at)}` : text.slice(start, at);
		if (plain) {
			// An integer of no more than 15 digits is exactly its number and its canonical
			// spelling is its `String`; only `-0` spells more than the number does
			return Number(source);
		} else {
			return spelled(Number(source), source);
		}
	}

	/** A named number — `nan`, `inf` — matched without case, as jq's scanner reads C doubles. */
	function named(name: string, value: number): number {
		if (text.slice(at, at + name.length).toLowerCase() === name) {
			at += name.length;
			return value;
		}
		throw failure('Unexpected token');
	}
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
