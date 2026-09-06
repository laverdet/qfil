/**
 * JavaScript's ordering and JavaScript's truth over the shared values. The ordering: strings
 * against strings by code unit, and everything else by subtraction — NaN for a container,
 * JavaScript's coercions otherwise. The truth: `Boolean` of the value, so the empty string, 0 and
 * NaN are false. jq's total order and jq's truth are the jq runtime's; everything else a value is
 * lives in `runtime/lang/value.ts`.
 */
import type { Value } from '#/compiler/filter.js';
import { compareStrings } from '#/runtime/lang/value.js';

export function compare(left: Value, right: Value): number {
	if (typeof left === 'string' && typeof right === 'string') {
		return compareStrings(left, right);
	} else {
		return toNumber(left) - toNumber(right);
	}
}

/** JavaScript's truth — the empty string, 0 and NaN are false — with a boxed number counting as its number, as it does everywhere else. */
export function truthy(value: Value): boolean {
	return Boolean(value instanceof Number ? Number(value) : value);
}

/** A value as subtraction would take it: a container has no number to it — and no prototype to coerce with, `Number` would throw. */
function toNumber(value: Value): number {
	if (typeof value !== 'object' || value instanceof Number) {
		return Number(value);
	} else {
		return NaN;
	}
}
