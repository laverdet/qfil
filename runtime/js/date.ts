/**
 * Time, natively: the epoch second, and ISO-8601 UTC as `Date` speaks it — milliseconds written,
 * fractional seconds read. The broken-down dialect — `gmtime`, `mktime`, `strftime`, `strptime` —
 * and the iso8601 aliases are the jq flavour's, in runtime/jq/date.ts.
 */
import type { LibFunction } from '#/compiler/filter.js';
import { assertNumber, assertString, unary } from '#/runtime/lang/library.js';
import { JqError } from '#/runtime/lang/value.js';

export const now: LibFunction = _render => () => Date.now() / 1000;

/** The epoch second as `Date` writes ISO-8601 UTC, milliseconds included. */
export const todate = unary(input => {
	const date = new Date(assertNumber(input, 'todate') * 1000);
	if (Number.isNaN(date.getTime())) {
		throw new JqError(`${Number(input)} is not a valid time`);
	}
	return date.toISOString();
});

/** A date as `Date` reads one, ISO-8601 first among them, as an epoch second. */
export const fromdate = unary(input => {
	const text = assertString(input, 'fromdate');
	const parsed = Date.parse(text);
	if (Number.isNaN(parsed)) {
		throw new JqError(`${text} cannot be parsed as a date`);
	}
	return parsed / 1000;
});
