/**
 * The library over jq's values: `sort` and its kin in jq's order, `tonumber` and `fromjson`
 * keeping a number's spelling, and the matching functions reading a regex's flags as jq does.
 */
import type { Lib } from '#/compiler/filter.js';
import { dates } from './date.js';
import { math } from './math.js';
import { match, oniguruma } from './regexp.js';
import { compare, fromjson, tonumber } from './value.js';
import { lib as js, ordered } from '#/runtime/js/index.js';
import { assertString, unary } from '#/runtime/js/library.js';
import { matching } from '#/runtime/js/regexp.js';

/** The whitespace jq's trims strip: JavaScript's own set, and U+0085 (NEL), which C's `iswspace` counts too. */
const leading = /^[\s\u0085]+/;
const trailing = /[\s\u0085]+$/;

export const lib: Lib = {
	...js,
	...ordered(compare),
	...matching(oniguruma),
	match,
	...math,
	...dates,
	ltrim: unary(input => assertString(input, 'ltrim').replace(leading, '')),
	rtrim: unary(input => assertString(input, 'rtrim').replace(trailing, '')),
	trim: unary(input => assertString(input, 'trim').replace(leading, '').replace(trailing, '')),
	tonumber: unary(tonumber),
	have_literal_numbers: _render => () => true,
	have_decnum: _render => () => true,
	fromjson: unary(input => fromjson(assertString(input, 'fromjson'))),
};
