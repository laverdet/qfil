/**
 * Time: the epoch, broken-down time, and the C strftime/strptime dialect over them. A broken-down
 * time is jq's: `[year, month (0-based), day, hour, minute, second, weekday, yearday]`, the
 * seconds carrying any fraction. `gmtime`, `mktime` and `strftime` speak UTC; `localtime` and
 * `strflocaltime` ask the host. `%s` reads the array as UTC, where C would consult the timezone.
 */
import type { LibFunction, Value } from '#/compiler/filter.js';
import { values } from '#/compiler/filter.js';
import { assertNumber, assertString, unary } from '#/runtime/lang/library.js';
import { JqError, describe, isNumber } from '#/runtime/lang/value.js';

const days = [ 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday' ];
const months = [ 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December' ];

/** jq's broken-down time of an epoch second. */
function broken(epoch: number, local: boolean): number[] {
	const date = new Date(epoch * 1000);
	if (Number.isNaN(date.getTime())) {
		throw new JqError(`${epoch} is not a valid time`);
	}
	const fraction = epoch - Math.floor(epoch);
	if (local) {
		const yday = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86400000);
		return [ date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds() + fraction, date.getDay(), yday ];
	} else {
		const yday = Math.round((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000);
		return [ date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds() + fraction, date.getUTCDay(), yday ];
	}
}

/** `mktime`: a broken-down array, missing fields zero, as a UTC epoch second. */
function epochOf(value: Value): number {
	if (!Array.isArray(value)) {
		throw new JqError(`${describe(value)} cannot be parsed as a broken-down time`);
	}
	const fields = [ 0, 1, 2, 3, 4, 5 ].map(ii => {
		const field: Value = value[ii] ?? 0;
		if (!isNumber(field)) {
			throw new JqError(`${describe(field)} cannot be a field of a broken-down time`);
		}
		return Number(field);
	});
	const date = new Date(0);
	date.setUTCFullYear(fields[0]!, fields[1], fields[2]);
	date.setUTCHours(fields[3]!, fields[4], Math.floor(fields[5]!), 0);
	return date.getTime() / 1000;
}

function pad(value: number, width: number, fill = '0'): string {
	return String(value).padStart(width, fill);
}

/** The strftime directives spoken here; an unknown one passes through as C leaves it. */
function directive(spec: string, tm: readonly number[], local: boolean): string {
	const [ year = 0, mon = 0, day = 0, hh = 0, mm = 0, ss = 0, wday = 0, yday = 0 ] = tm;
	const seconds = Math.floor(ss);
	switch (spec) {
		case 'a': return days[wday]?.slice(0, 3) ?? '?';
		case 'A': return days[wday] ?? '?';
		case 'b': case 'h': return months[mon]?.slice(0, 3) ?? '?';
		case 'B': return months[mon] ?? '?';
		case 'C': return pad(Math.floor(year / 100), 2);
		case 'd': return pad(day, 2);
		case 'D': return `${pad(mon + 1, 2)}/${pad(day, 2)}/${pad(year % 100, 2)}`;
		case 'e': return pad(day, 2, ' ');
		case 'F': return `${year}-${pad(mon + 1, 2)}-${pad(day, 2)}`;
		case 'H': return pad(hh, 2);
		case 'I': return pad(hh % 12 === 0 ? 12 : hh % 12, 2);
		case 'j': return pad(yday + 1, 3);
		case 'm': return pad(mon + 1, 2);
		case 'M': return pad(mm, 2);
		case 'n': return '\n';
		case 'p': return hh < 12 ? 'AM' : 'PM';
		case 'R': return `${pad(hh, 2)}:${pad(mm, 2)}`;
		case 's': return String(epochOf(tm));
		case 'S': return pad(seconds, 2);
		case 't': return '\t';
		case 'T': return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(seconds, 2)}`;
		case 'u': return String(wday === 0 ? 7 : wday);
		case 'w': return String(wday);
		case 'y': return pad(year % 100, 2);
		case 'Y': return String(year);
		case 'z': return local ? '' : '+0000';
		case 'Z': return local ? '' : 'UTC';
		case '%': return '%';
		default: return `%${spec}`;
	}
}

function strftimeOf(format: string, tm: readonly number[], local: boolean): string {
	let out = '';
	for (let ii = 0; ii < format.length; ++ii) {
		const char = format[ii]!;
		if (char === '%' && ii + 1 < format.length) {
			out += directive(format[++ii]!, tm, local);
		} else {
			out += char;
		}
	}
	return out;
}

/** A name from a table, matched at `text[at]` without case: the longest of full name or 3-letter abbreviation. */
function named(text: string, at: number, table: readonly string[]): { index: number; length: number } | undefined {
	const lower = text.slice(at).toLowerCase();
	for (let index = 0; index < table.length; ++index) {
		const name = table[index]!.toLowerCase();
		if (lower.startsWith(name)) {
			return { index, length: name.length };
		}
	}
	for (let index = 0; index < table.length; ++index) {
		const name = table[index]!.toLowerCase().slice(0, 3);
		if (lower.startsWith(name)) {
			return { index, length: 3 };
		}
	}
	return undefined;
}

/** The composite directives, spelled out before parsing. */
const composites: Readonly<Record<string, string>> = {
	'%T': '%H:%M:%S',
	'%R': '%H:%M',
	'%D': '%m/%d/%y',
	'%F': '%Y-%m-%d',
};

/** `strptime`: the text against the format, to a broken-down array with the weekday and yearday computed. */
function strptimeOf(text: string, spelled: string): number[] {
	const format = spelled.replace(/%[TRDF]/g, name => composites[name]!);
	const fail = (): never => {
		throw new JqError(`date "${text}" does not match format "${spelled}"`);
	};
	const tm = { year: 1900, mon: 0, day: 1, hh: 0, mm: 0, ss: 0, pm: undefined as boolean | undefined };
	let at = 0;
	// A run of digits, up to `width`, skipping the leading whitespace C's numeric conversions do
	const numeric = (width: number): number => {
		while (text[at] === ' ') {
			++at;
		}
		const start = at;
		while (at - start < width && at < text.length && text[at]! >= '0' && text[at]! <= '9') {
			++at;
		}
		if (at === start) {
			fail();
		}
		return Number(text.slice(start, at));
	};
	for (let ii = 0; ii < format.length; ++ii) {
		const char = format[ii]!;
		if (char !== '%') {
			if (/\s/.test(char)) {
				while (at < text.length && /\s/.test(text[at]!)) {
					++at;
				}
			} else if (text[at] === char) {
				++at;
			} else {
				fail();
			}
			continue;
		}
		const spec = format[++ii] ?? fail();
		switch (spec) {
			case 'Y': tm.year = numeric(4); break;
			case 'y': {
				const year = numeric(2);
				tm.year = year < 69 ? year + 2000 : year + 1900;
				break;
			}
			case 'C': tm.year = numeric(2) * 100 + tm.year % 100; break;
			case 'm': tm.mon = numeric(2) - 1; break;
			case 'd': case 'e': tm.day = numeric(2); break;
			case 'H': tm.hh = numeric(2); break;
			case 'I': tm.hh = numeric(2); break;
			case 'M': tm.mm = numeric(2); break;
			case 'S': tm.ss = numeric(2); break;
			case 'j': tm.mon = 0; tm.day = numeric(3); break;
			case 'b': case 'B': case 'h': {
				const month = named(text, at, months) ?? fail();
				tm.mon = month.index;
				at += month.length;
				break;
			}
			case 'a': case 'A': {
				const day = named(text, at, days) ?? fail();
				at += day.length;
				break;
			}
			case 'p': case 'P': {
				const half = text.slice(at, at + 2).toUpperCase();
				if (half !== 'AM' && half !== 'PM') {
					fail();
				}
				tm.pm = half === 'PM';
				at += 2;
				break;
			}
			case 'n': case 't':
				while (at < text.length && /\s/.test(text[at]!)) {
					++at;
				}
				break;
			case '%':
				if (text[at] !== '%') {
					fail();
				}
				++at;
				break;
			default: fail();
		}
	}
	return finish(tm);
}

function finish(tm: { year: number; mon: number; day: number; hh: number; mm: number; ss: number; pm: boolean | undefined }): number[] {
	const hh = function() {
		if (tm.pm === true && tm.hh < 12) {
			return tm.hh + 12;
		} else if (tm.pm === false && tm.hh === 12) {
			return 0;
		}
		return tm.hh;
	}();
	const stamp = new Date(0);
	stamp.setUTCFullYear(tm.year, tm.mon, tm.day);
	const wday = stamp.getUTCDay();
	const yday = Math.round((Date.UTC(tm.year, tm.mon, tm.day) - Date.UTC(tm.year, 0, 1)) / 86400000);
	return [ tm.year, tm.mon, tm.day, hh, tm.mm, tm.ss, wday, yday ];
}

/** `strftime` and `strflocaltime`: an epoch second is broken down first; an array is taken as one. */
function formatter(local: boolean): LibFunction {
	return values((input, spec) => {
		const text = assertString(spec, 'strftime');
		const tm = isNumber(input) ? broken(Number(input), local) : brokenOf(input);
		return strftimeOf(text, tm, local);
	});
}

function brokenOf(value: Value): number[] {
	if (!Array.isArray(value) || !value.every(isNumber)) {
		throw new JqError('strftime/1 requires parsed datetime inputs');
	}
	return value.map(Number);
}

export const mktime = unary(epochOf);
export const gmtime = unary(input => broken(assertNumber(input, 'gmtime'), false));
export const localtime = unary(input => broken(assertNumber(input, 'localtime'), true));
export const strftime = formatter(false);
export const strflocaltime = formatter(true);
export const strptime = values((input, spec) =>
	strptimeOf(assertString(input, 'strptime'), assertString(spec, 'strptime')));
