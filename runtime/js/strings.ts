/**
 * Strings: the predicates, the trims, ASCII case, and `join`.
 */
import type { Lib, Value } from '#/compiler/filter.js';
import { add, iterate } from './intrinsics.js';
import { assertString, unary } from './library.js';
import { JqError, describe, isObject, tojson } from './value.js';
import { values } from '#/compiler/filter.js';

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
	ascii_downcase: unary(input => assertString(input, 'ascii_downcase').replace(/[A-Z]+/g, text => text.toLowerCase())),
	ascii_upcase: unary(input => assertString(input, 'ascii_upcase').replace(/[a-z]+/g, text => text.toUpperCase())),
};
