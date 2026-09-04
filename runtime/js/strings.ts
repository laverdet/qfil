/**
 * Strings: the predicates, the trims, ASCII case, codepoints, byte lengths, `join`, and the
 * searches — `indices` and `contains` — which reach over to arrays as jq's do.
 */
import type { Lib, Value } from '#/compiler/filter.js';
import { add, iterate } from './intrinsics.js';
import { assertArray, assertString, unary } from './library.js';
import { JqError, contains, describe, equal, isNumber, isObject, tojson } from './value.js';
import { values } from '#/compiler/filter.js';

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

function imploded(value: Value): string {
	const points = assertArray(value, 'implode');
	let text = '';
	for (const point of points) {
		if (!isNumber(point) || !Number.isInteger(Number(point)) || point < 0 || point > 0x10ffff) {
			throw new JqError(`${describe(point)} is not a valid codepoint`);
		}
		text += String.fromCodePoint(Number(point));
	}
	return text;
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

export const strings: Lib = {
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
	join: (render, separator) => values(render, [ separator ], (input, value) => join(input, value)),
	explode: unary(input => [ ...assertString(input, 'explode') ].map(char => char.codePointAt(0)!)),
	implode: unary(imploded),
	utf8bytelength: unary(input => utf8Bytes(assertString(input, 'utf8bytelength'))),
	ltrim: unary(input => assertString(input, 'ltrim').trimStart()),
	rtrim: unary(input => assertString(input, 'rtrim').trimEnd()),
	trim: unary(input => assertString(input, 'trim').trim()),
	indices: (render, needle) => values(render, [ needle ], indicesOf),
	contains: (render, other) => values(render, [ other ], (input, value) => contains(input, value)),
	ascii_downcase: unary(input => assertString(input, 'ascii_downcase').replace(/[A-Z]+/g, text => text.toLowerCase())),
	ascii_upcase: unary(input => assertString(input, 'ascii_upcase').replace(/[a-z]+/g, text => text.toUpperCase())),
};
