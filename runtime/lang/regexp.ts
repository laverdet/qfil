/**
 * The functions that match a regex — `test`, `match`, `capture`, `scan`, `split`, `splits`, `sub`,
 * `gsub` — over a `RegexCompiler`, since what a pattern and its flags mean is a flavor's to say:
 * `regex` is JavaScript's reading, flags included, and the jq flavor translates jq's onto it. `u`
 * is always set, so patterns are Unicode-aware; `d` is `match`'s to ask for, whose captures carry
 * offsets, in UTF-16 code units.
 */
import type * as ast from '#/compiler/ast.js';
import type { Env, LibFunction, Render, Stream, Value, ValueObject } from '#/compiler/filter.js';
import { split } from './intrinsics.js';
import { assertString } from './library.js';
import { JqError, describe, isArray, isString, newObject, typeOf } from './value.js';
import { constant, once, overload, streams, values } from '#/compiler/filter.js';

/** Builds the RegExp of a match call: what the pattern and flags mean is the library's to say — JavaScript's reading here, jq's in the jq library. */
export type RegexCompiler = (pattern: Value, flags: Value, extra: string) => RegExp;

export function regex(pattern: Value, flags: Value, extra = ''): RegExp {
	if (!isString(pattern)) {
		throw new JqError(`${describe(pattern)} cannot be matched, as it is not a string`);
	} else if (flags !== null && !isString(flags)) {
		throw new JqError(`${describe(flags)} is not a string`);
	}
	try {
		return new RegExp(pattern, [ ...new Set(`u${flags ?? ''}${extra}`) ].join(''));
	} catch (error) {
		throw new JqError((error as Error).message);
	}
}

/** Runs `body` with a regex for each combination of the pattern and flag arguments' outputs. */
type WithRegex = (input: Value, env: Env, body: (regex: RegExp, input: Value) => Iterable<Value>) => Iterable<Value>;

/** What the regex arguments of a call say: the pattern, and the flags. */
type Reading = (...args: Value[]) => readonly [ pattern: Value, flags: Value ];

/** The pattern, and the flags when they are given. */
const plain: Reading = (pattern, flags) => [ pattern, flags ?? null ];

/** jq's sugar for one argument: the pattern alone, or `[pattern, flags]`. */
const sugar: Reading = value => {
	if (isString(value)) {
		return [ value, null ];
	} else if (isArray(value) && value.length > 0) {
		return [ value[0], value[1] ?? null ];
	} else {
		throw new JqError(`${typeOf(value)} not a string or array`);
	}
};

/**
 * A regex from its arguments — compiled once, on the first call, when they are all literals,
 * otherwise whenever they change from one call to the next: the syntax is there to be read.
 */
function regexOf(compile: RegexCompiler, render: Render, args: readonly ast.Node[], read: Reading, extra: string): WithRegex {
	const literals = args.map(constant);
	if (literals.every(literal => literal !== undefined)) {
		const compiled = once(() => {
			const [ pattern, flags ] = read(...literals);
			return compile(pattern, flags, extra);
		});
		return (input, _env, body) => body(compiled(), input);
	} else {
		const readings = streams(render, args, function*(_input, ...vals) {
			yield read(...vals);
		});
		let last: { readonly pattern: Value; readonly flags: Value; readonly compiled: RegExp } | null = null;
		return function*(input, env, body) {
			for (const reading of readings(input, env)) {
				const [ pattern, flags ] = reading as ReturnType<Reading>;
				if (last === null || last.pattern !== pattern || last.flags !== flags) {
					last = { pattern, flags, compiled: compile(pattern, flags, extra) };
				}
				yield* body(last.compiled, input);
			}
		};
	}
}

const skipsEmpty: unique symbol = Symbol('qfil.skipsEmpty');

/** Marks a regex whose empty matches do not count, as jq's `n` flag has it. */
export function ignoringEmpty(regex: RegExp): RegExp {
	return Object.assign(regex, { [skipsEmpty]: true });
}

function ignoresEmpty(regex: RegExp): boolean {
	return (regex as { readonly [skipsEmpty]?: boolean })[skipsEmpty] === true;
}

/** Every match when the pattern is global, otherwise the first; a regex marked by `ignoringEmpty` counts only the nonempty ones. */
export function execAll(regex: RegExp, input: Value): RegExpExecArray[] {
	const text = assertString(input, 'match');
	if (regex.global) {
		const all = [ ...text.matchAll(regex) ];
		return ignoresEmpty(regex) ? all.filter(match => match[0] !== '') : all;
	} else if (ignoresEmpty(regex)) {
		// The first nonempty match: an empty one at an earlier offset does not count
		for (const match of text.matchAll(new RegExp(regex.source, `${regex.flags}g`))) {
			if (match[0] !== '') {
				return [ match ];
			}
		}
		return [];
	} else {
		const match = regex.exec(text);
		return match === null ? [] : [ match ];
	}
}

/** A match as jq's `match` object; where each group's name comes from is the flavor's to say. */
export function matchObject(match: RegExpExecArray, names: readonly (string | null)[]): ValueObject {
	const indices: readonly ([ number, number ] | undefined)[] = match.indices!;
	const captures = indices.slice(1).map((range, ii) => range === undefined
		? { __proto__: null, offset: -1, length: 0, string: null, name: names[ii] ?? null }
		: { __proto__: null, offset: range[0], length: range[1] - range[0], string: match[ii + 1]!, name: names[ii] ?? null });
	return { __proto__: null, offset: match.index, length: match[0].length, string: match[0], captures };
}

/** The named groups of a match as an object; one that did not participate is null, or left out when only the `participating` are asked for. */
export function namedGroups(match: RegExpExecArray, participating = false): ValueObject {
	const result = newObject();
	for (const [ name, string ] of Object.entries<string | undefined>(match.groups ?? {})) {
		if (string !== undefined) {
			result[name] = string;
		} else if (!participating) {
			result[name] = null;
		}
	}
	return result;
}

/**
 * `sub` and `gsub`. The replacement filter runs once per match with the named groups as its input;
 * when it yields several strings, the k-th result replaces every match with its k-th one.
 */
function *substitute(regex: RegExp, input: Value, replacement: (groups: Value) => Iterable<Value>): Generator<string> {
	const text = assertString(input, 'sub');
	const edits = execAll(regex, text).map(match => ({
		start: match.index,
		end: match.index + match[0].length,
		outputs: [ ...replacement(namedGroups(match)) ].map(output => isString(output) ? String(output) : function() {
			throw new JqError(`${describe(output)} cannot be added to a string`);
		}()),
	}));
	if (edits.length === 0) {
		yield text;
		return;
	}
	const count = Math.min(...edits.map(edit => edit.outputs.length));
	for (let kk = 0; kk < count; ++kk) {
		let output = '';
		let previous = 0;
		for (const edit of edits) {
			output += text.slice(previous, edit.start) + edit.outputs[kk]!;
			previous = edit.end;
		}
		yield output + text.slice(previous);
	}
}

/**
 * A function of a regex and its input, of one or two arguments: the pattern and the flags, or
 * either the pattern alone or — for the ones jq gives the sugar — `[pattern, flags]`.
 */
export function regexFunction(compile: RegexCompiler, extra: string, body: (regex: RegExp, input: Value) => Iterable<Value>, one: Reading = sugar): LibFunction {
	const over = (render: Render, args: readonly ast.Node[], read: Reading): Stream => {
		const regexes = regexOf(compile, render, args, read, extra);
		return function*(input, env) {
			yield* regexes(input, env, body);
		};
	};
	return overload(
		(render, pattern) => over(render, [ pattern ], one),
		(render, pattern, flags) => over(render, [ pattern, flags ], plain),
	);
}

function subFunction(compile: RegexCompiler, extra: string): LibFunction {
	const over = (render: Render, args: readonly ast.Node[], replacementNode: ast.Node): Stream => {
		const regexes = regexOf(compile, render, args, plain, extra);
		const replacement = render.generator(replacementNode);
		return function*(input, env) {
			yield* regexes(input, env, (compiled, text) => substitute(compiled, text, groups => replacement(groups, env)));
		};
	};
	return overload(
		(render, pattern, replacement) => over(render, [ pattern ], replacement),
		(render, pattern, replacement, flags) => over(render, [ pattern, flags ], replacement),
	);
}

function *testWith(compiled: RegExp, input: Value): Generator {
	yield ignoresEmpty(compiled) ? execAll(compiled, input).length > 0 : compiled.test(assertString(input, 'test'));
}

function matchWith(compiled: RegExp, input: Value): Value[] {
	return execAll(compiled, input).map(match => matchObject(match, matchNames(match)));
}

/** The participating groups' names, by number — the JavaScript reading: an unmatched group has none. */
function matchNames(match: RegExpExecArray): (string | null)[] {
	// The indices of a named group are the same pair object as its positional entry
	const byRange = new Map(Object.entries<[ number, number ] | undefined>(match.indices!.groups ?? {})
		.filter(([ , range ]) => range !== undefined)
		.map(([ name, range ]) => [ range, name ]));
	return match.indices!.slice(1).map(range => range === undefined ? null : byRange.get(range) ?? null);
}

/** `capture` in the JavaScript reading: an unmatched group has no name, so it is left out. */
function captureWith(compiled: RegExp, input: Value): Value[] {
	return execAll(compiled, input).map(match => namedGroups(match, true));
}

/** `scan`: each match's captures when the pattern has groups — null for one that did not participate — otherwise its string. */
function scanWith(compiled: RegExp, input: Value): Value[] {
	return execAll(compiled, input).map(match => {
		const captures: readonly (string | undefined)[] = match.slice(1);
		return captures.length > 0 ? captures.map(string => string ?? null) : match[0];
	});
}

/** What is left of the input between the matches of a global regex. */
function piecesWith(compiled: RegExp, input: Value): string[] {
	const text = assertString(input, 'split');
	const pieces: string[] = [];
	let previous = 0;
	for (const match of execAll(compiled, text)) {
		pieces.push(text.slice(previous, match.index));
		previous = match.index + match[0].length;
	}
	pieces.push(text.slice(previous));
	return pieces;
}

/**
 * The functions that match a regex — `test`, `match`, `capture`, `scan`, `split`, `splits`, `sub`,
 * `gsub` — over a compiler, since what a pattern and its flags mean is the library's to say:
 * JavaScript's reading in this one, jq's in the jq library. `match` alone asks for `d`, the
 * offsets of its captures.
 */
export function matching(compile: RegexCompiler) {
	return {
		test: regexFunction(compile, '', testWith),
		match: regexFunction(compile, 'd', matchWith),
		capture: regexFunction(compile, '', captureWith),
		scan: regexFunction(compile, 'g', scanWith, plain),
		sub: subFunction(compile, ''),
		gsub: subFunction(compile, 'g'),
		split: overload(
			values((input, value) => split(assertString(input, 'split'), assertString(value, 'split'))),
			(render, pattern, flags) => {
				const regexes = regexOf(compile, render, [ pattern, flags ], plain, 'g');
				return function*(input, env) {
					yield* regexes(input, env, (compiled, text) => [ piecesWith(compiled, text) ]);
				};
			},
		),
		splits: regexFunction(compile, 'g', piecesWith, plain),
	};
}
