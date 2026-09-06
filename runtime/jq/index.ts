/**
 * The library over jq's values: everything the JavaScript flavour exports, with what differs
 * declared over it — `sort` and its kin in jq's order, `tonumber` and `fromjson` keeping a
 * number's spelling, and the matching functions reading a regex's flags as jq does. A local
 * export shadows what `export *` would re-export, which is all the laying-over there is.
 */
import type { LibFunction } from '#/compiler/filter.js';
import { oniguruma } from './regexp.js';
import { compare, fromjson as fromjsonOf, tonumber as tonumberOf, truthy } from './value.js';
import { assertString, unary } from '#/runtime/lang/library.js';
import { ordered } from '#/runtime/lang/order.js';
import { matching } from '#/runtime/lang/regexp.js';
import { conditionals } from '#/runtime/lang/truth.js';

export * from '#/runtime/js/index.js';
export * from './date.js';
export * from './math.js';
export { round } from './math.js';
export { match } from './regexp.js';

/** The whitespace jq's trims strip: JavaScript's own set, and U+0085 (NEL), which C's `iswspace` counts too. */
const leading = /^[\s\u0085]+/;
const trailing = /[\s\u0085]+$/;

const conds = conditionals(truthy);
export const { not, select, until, any, all } = conds;
const { while: whileOf } = conds;
export { whileOf as while };
export const { sort, sort_by, group_by, unique, unique_by, min, max, min_by, max_by, bsearch } = ordered(compare);
export const { test, sub, gsub, split } = matching(oniguruma);
export const ltrim = unary(input => assertString(input, 'ltrim').replace(leading, ''));
export const rtrim = unary(input => assertString(input, 'rtrim').replace(trailing, ''));
export const trim = unary(input => assertString(input, 'trim').replace(leading, '').replace(trailing, ''));
export const tonumber = unary(tonumberOf);
export const have_literal_numbers: LibFunction = _render => () => true;
export const have_decnum: LibFunction = _render => () => true;
export const fromjson = unary(input => fromjsonOf(assertString(input, 'fromjson')));
