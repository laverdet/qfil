/** The library over jq's values: `sort` and its kin in jq's order, `tonumber` and `fromjson` keeping a number's spelling. */
import type { Lib } from '#/compiler/filter.js';
import { compare, fromjson, tonumber } from './value.js';
import { assertString, lib as js, ordered, unary } from '#/runtime/js/index.js';

export const lib: Lib = {
	...js,
	...ordered(compare),
	tonumber: unary(tonumber),
	fromjson: unary(input => fromjson(assertString(input, 'fromjson'))),
};
