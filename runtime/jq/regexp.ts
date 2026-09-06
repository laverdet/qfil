/**
 * jq's reading of a regex, over JavaScript's engine: Oniguruma's flags translated, the `x`
 * extended dialect rewritten, and group names read off the pattern source so an unmatched
 * capture still carries its name.
 */
import type { RegexCompiler } from '#/runtime/lang/regexp.js';
import { execAll, ignoringEmpty, matchObject, regex, regexFunction } from '#/runtime/lang/regexp.js';
import { JqError } from '#/runtime/lang/value.js';

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

/** The name of each capturing group in a pattern, by number — read off the source, so an unmatched group still carries its name. */
function groupNames(source: string): (string | null)[] {
	const names: (string | null)[] = [];
	let inClass = false;
	for (let ii = 0; ii < source.length; ++ii) {
		const char = source[ii]!;
		if (char === '\\') {
			++ii;
		} else if (inClass) {
			inClass = char !== ']';
		} else if (char === '[') {
			inClass = true;
		} else if (char === '(') {
			if (source[ii + 1] !== '?') {
				names.push(null);
			} else if (source[ii + 2] === '<' && source[ii + 3] !== '=' && source[ii + 3] !== '!') {
				const end = source.indexOf('>', ii + 3);
				names.push(source.slice(ii + 3, end));
				ii = end;
			}
		}
	}
	return names;
}

/**
 * jq's regex flags over JavaScript's engine: `m` and `p` put `.` across newlines, which is
 * JavaScript's `s`; jq's `s` anchors as JavaScript already does; `x` rewrites the pattern and `n`
 * discards empty matches. `l`, the longest match, has no JavaScript spelling.
 */
export const oniguruma: RegexCompiler = (pattern, flags, extra) => {
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

/** jq's `match/2`: capture names are read off the pattern source, so an unmatched group still carries its name. */
export const match = regexFunction(oniguruma, '', (compiled, input) => {
	const names = groupNames(compiled.source);
	return execAll(compiled, input).map(found => matchObject(found, names));
});
