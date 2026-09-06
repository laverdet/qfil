/**
 * Strings: the predicates, the trims, ASCII case, codepoints, byte lengths, `join`, and the
 * searches — `indices` and `contains` — which reach over to arrays as jq's do.
 */
import type { Value } from '#/compiler/filter.js';
import { values } from '#/compiler/filter.js';
import { add, iterate } from '#/runtime/lang/intrinsics.js';
import { assertArray, assertString, unary } from '#/runtime/lang/library.js';
import { JqError, contains as containsOf, describe, equal, isNumber, isObject, tojson } from '#/runtime/lang/value.js';

/** Every offset of the needle — a substring, a subarray, an element — overlapping matches included. */
function indicesOf(input: Value, needle: Value): Value {
	if (input === null) {
		return null;
	} else if (typeof input === 'string' && typeof needle === 'string') {
		const found: number[] = [];
		if (needle === '') {
			return found;
		}
		for (let at = input.indexOf(needle); at !== -1; at = input.indexOf(needle, at + 1)) {
			found.push(at);
		}
		return found;
	} else if (Array.isArray(input)) {
		const found: number[] = [];
		if (Array.isArray(needle)) {
			if (needle.length === 0) {
				return found;
			}
			for (let at = 0; at + needle.length <= input.length; ++at) {
				if (needle.every((element, ii) => equal(input[at + ii]!, element))) {
					found.push(at);
				}
			}
		} else {
			for (let at = 0; at < input.length; ++at) {
				if (equal(input[at]!, needle)) {
					found.push(at);
				}
			}
		}
		return found;
	}
	throw new JqError(`Cannot search ${describe(input)} for ${describe(needle)}`);
}

/** UTF-8 bytes of a string, counted without encoding it. */
function utf8Bytes(text: string): number {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code < 0x10000) {
			bytes += 3;
		} else {
			bytes += 4;
		}
	}
	return bytes;
}

/** A codepoint as `implode` reads it: floats floor, and anything unencodable — a negative, past U+10FFFF, a surrogate half — becomes U+FFFD, as jq has it. */
function codepoint(point: Value): number {
	if (!isNumber(point) || Number.isNaN(Number(point))) {
		throw new JqError(`${describe(point)} is not a valid codepoint`);
	}
	const whole = Math.floor(point);
	return whole < 0 || whole > 0x10ffff || (whole >= 0xd800 && whole <= 0xdfff) ? 0xfffd : whole;
}

function imploded(value: Value): string {
	const points = assertArray(value, 'implode');
	let text = '';
	for (const point of points) {
		text += String.fromCodePoint(codepoint(point));
	}
	return text;
}

function joined(value: Value, separator: Value): Value {
	let result: Value = null;
	let first = true;
	for (const element of iterate(value)) {
		const piece = function(): Value {
			if (element === null) {
				return '';
			} else if (typeof element === 'string' || Array.isArray(element) || isObject(element)) {
				// A container is no string; `add` refuses it with both halves named, as jq's join does
				return element;
			} else {
				return tojson(element);
			}
		}();
		result = add(first ? '' : add(result, separator), piece);
		first = false;
	}
	return result ?? '';
}

export const startswith = values((input, value) => assertString(input, 'startswith').startsWith(assertString(value, 'startswith')));
export const endswith = values((input, value) => assertString(input, 'endswith').endsWith(assertString(value, 'endswith')));
export const ltrimstr = values((input, value) => {
	const text = assertString(input, 'ltrimstr');
	const affix = assertString(value, 'ltrimstr');
	return text.startsWith(affix) ? text.slice(affix.length) : text;
});
export const rtrimstr = values((input, value) => {
	const text = assertString(input, 'rtrimstr');
	const affix = assertString(value, 'rtrimstr');
	return affix !== '' && text.endsWith(affix) ? text.slice(0, -affix.length) : text;
});
export const join = values(joined);
export const explode = unary(input => [ ...assertString(input, 'explode') ].map(char => char.codePointAt(0)!));
export const implode = unary(imploded);
export const utf8bytelength = unary(input => utf8Bytes(assertString(input, 'utf8bytelength')));
export const ltrim = unary(input => assertString(input, 'ltrim').trimStart());
export const rtrim = unary(input => assertString(input, 'rtrim').trimEnd());
export const trim = unary(input => assertString(input, 'trim').trim());
export const indices = values(indicesOf);
export const contains = values(containsOf);
export const ascii_downcase = unary(input => assertString(input, 'ascii_downcase').replace(/[A-Z]+/g, text => text.toLowerCase()));
export const ascii_upcase = unary(input => assertString(input, 'ascii_upcase').replace(/[a-z]+/g, text => text.toUpperCase()));
