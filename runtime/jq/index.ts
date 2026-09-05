/**
 * The library over jq's values: `sort` and its kin in jq's order, `tonumber` and `fromjson`
 * keeping a number's spelling, and the matching functions reading a regex's flags as jq does.
 */
import type { Lib } from '#/compiler/filter.js';
import type { RegexCompiler } from '#/runtime/js/regex.js';
import { dates } from './date.js';
import { math } from './math.js';
import { compare, fromjson, tonumber } from './value.js';
import { lib as js, ordered } from '#/runtime/js/index.js';
import { assertString, unary } from '#/runtime/js/library.js';
import { ignoringEmpty, matching, regex } from '#/runtime/js/regex.js';
import { JqError } from '#/runtime/js/value.js';

/**
 * An extended pattern, the `x` flag: whitespace and `#` comments are ignored outside a character
 * class, and an escaped character stands as written — `\ ` is the space itself, which unicode
 * mode will not spell escaped.
 */
function extended(pattern: string): string {
	let result = '';
	let inClass = false;
	for (let ii = 0; ii < pattern.length; ++ii) {
		const char = pattern[ii]!;
		if (char === '\\' && ii + 1 < pattern.length) {
			const next = pattern[++ii]!;
			result += /\s/.test(next) ? next : char + next;
		} else if (inClass) {
			inClass = char !== ']';
			result += char;
		} else if (char === '[') {
			inClass = true;
			result += char;
		} else if (char === '#') {
			while (ii + 1 < pattern.length && pattern[ii + 1] !== '\n') {
				++ii;
			}
		} else if (!/\s/.test(char)) {
			result += char;
		}
	}
	return result;
}

/**
 * jq's regex flags over JavaScript's engine: `m` and `p` put `.` across newlines, which is
 * JavaScript's `s`; jq's `s` anchors as JavaScript already does; `x` rewrites the pattern and `n`
 * discards empty matches. `l`, the longest match, has no JavaScript spelling.
 */
const oniguruma: RegexCompiler = (pattern, flags, extra) => {
	if (typeof pattern !== 'string' || typeof flags !== 'string') {
		// Null flags, and the type errors, are as JavaScript reads them
		return regex(pattern, flags, extra);
	}
	let source = pattern;
	let translated = '';
	let skipEmpty = false;
	for (const flag of flags) {
		switch (flag) {
			case 'g': case 'i':
				translated += flag;
				break;
			case 'm': case 'p':
				translated += 's';
				break;
			case 's':
				break;
			case 'x':
				source = extended(pattern);
				break;
			case 'n':
				skipEmpty = true;
				break;
			case 'l':
				throw new JqError(`${flag} (longest match) is not supported`);
			default:
				throw new JqError(`${flag} is not a valid modifier string`);
		}
	}
	const compiled = regex(source, translated, extra);
	return skipEmpty ? ignoringEmpty(compiled) : compiled;
};

/** The whitespace jq's trims strip: JavaScript's own set, and U+0085 (NEL), which C's `iswspace` counts too. */
const leading = /^[\s\u0085]+/;
const trailing = /[\s\u0085]+$/;

export const lib: Lib = {
	...js,
	...ordered(compare),
	...matching(oniguruma),
	...math,
	...dates,
	ltrim: unary(input => assertString(input, 'ltrim').replace(leading, '')),
	rtrim: unary(input => assertString(input, 'rtrim').replace(trailing, '')),
	trim: unary(input => assertString(input, 'trim').replace(leading, '').replace(trailing, '')),
	tonumber: unary(tonumber),
	have_literal_numbers: _render => () => true,
	fromjson: unary(input => fromjson(assertString(input, 'fromjson'))),
};
