/**
 * The functions that match a regex — `test`, `match`, `split`, `sub`, `gsub` — over a
 * `RegexCompiler`, since what a pattern and its flags mean is the library's to say: JavaScript's
 * reading here, flags included, and jq's in the jq library. `u` and `d` are always set, so
 * patterns are Unicode-aware and captures carry offsets; offsets are UTF-16 code units.
 */
import type * as ast from '#/compiler/ast.js';
import type { Env, Lib, LibFunction, Render, Stream, Value, ValueObject } from '#/compiler/filter.js';
import { split } from './intrinsics.js';
import { assertString } from './library.js';
import { JqError, describe, newObject } from './value.js';
import { constant, overload, streams, values } from '#/compiler/filter.js';

/** Builds the RegExp of a match call: what the pattern and flags mean is the library's to say — JavaScript's reading here, jq's in the jq library. */
export type RegexCompiler = (pattern: Value, flags: Value, extra: string) => RegExp;

export function regex(pattern: Value, flags: Value, extra = ''): RegExp {
	if (typeof pattern !== 'string') {
		throw new JqError(`${describe(pattern)} cannot be matched, as it is not a string`);
	} else if (flags !== null && typeof flags !== 'string') {
		throw new JqError(`${describe(flags)} is not a string`);
	}
	try {
		return new RegExp(pattern, [ ...new Set(`du${flags ?? ''}${extra}`) ].join(''));
	} catch (error) {
		throw new JqError((error as Error).message);
	}
}

/** Runs `body` with a regex for each combination of the pattern and flag arguments' outputs. */
type WithRegex = (input: Value, env: Env, body: (regex: RegExp, input: Value) => Iterable<Value>) => Iterable<Value>;

/** A regex from its arguments — compiled once when both are literals, otherwise per call: the syntax is there to be read. */
function regexOf(compile: RegexCompiler, render: Render, pattern: ast.Node, flags: ast.Node | null, extra = ''): WithRegex {
	const literalPattern = constant(pattern);
	const literalFlags = flags === null ? null : constant(flags);
	if (literalPattern !== undefined && literalFlags !== undefined) {
		const compiled = compile(literalPattern, literalFlags, extra);
		return (input, _env, body) => body(compiled, input);
	} else {
		const args = streams(render, flags === null ? [ pattern ] : [ pattern, flags ], function*(_input, re, fl) {
			yield [ re, fl ?? null ];
		});
		let last: { readonly re: Value; readonly fl: Value; readonly compiled: RegExp } | null = null;
		return function*(input, env, body) {
			for (const pair of args(input, env)) {
				const [ re, fl ] = pair as [ Value, Value ];
				if (last?.re !== re || last.fl !== fl) {
					last = { re, fl, compiled: compile(re, fl, extra) };
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

/** A match as jq's `match` object; where each group's name comes from is the flavour's to say. */
export function matchObject(match: RegExpExecArray, names: readonly (string | null)[]): ValueObject {
	const indices: readonly ([ number, number ] | undefined)[] = match.indices!;
	const captures = indices.slice(1).map((range, ii) => range === undefined
		? { __proto__: null, offset: -1, length: 0, string: null, name: names[ii] ?? null }
		: { __proto__: null, offset: range[0], length: range[1] - range[0], string: match[ii + 1]!, name: names[ii] ?? null });
	return { __proto__: null, offset: match.index, length: match[0].length, string: match[0], captures };
}

/** The named groups of a match as an object, null for the ones that did not participate. */
function namedGroups(match: RegExpExecArray): ValueObject {
	const result = newObject();
	for (const [ name, string ] of Object.entries<string | undefined>(match.groups ?? {})) {
		result[name] = string ?? null;
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
		outputs: [ ...replacement(namedGroups(match)) ].map(output => typeof output === 'string' ? output : function() {
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

/** `match/2` and `test/2`; the 1-arity forms, and their `[re, flags]` array sugar, are the prelude's dispatch. */
export function regexFunction(compile: RegexCompiler, extra: string, body: (regex: RegExp, input: Value) => Iterable<Value>): LibFunction {
	return (render, pattern, flags) => function*(input, env) {
		yield* regexOf(compile, render, pattern, flags, extra)(input, env, body);
	};
}

function subFunction(compile: RegexCompiler, extra: string): LibFunction {
	const withRegex = (render: Render, regexes: WithRegex, replacementNode: ast.Node): Stream => {
		const replacement = render.generator(replacementNode);
		return function*(input, env) {
			yield* regexes(input, env, (compiled, text) => substitute(compiled, text, groups => replacement(groups, env)));
		};
	};
	return overload(
		(render, pattern, replacement) => withRegex(render, regexOf(compile, render, pattern, null, extra), replacement),
		(render, pattern, replacement, flags) => withRegex(render, regexOf(compile, render, pattern, flags, extra), replacement),
	);
}

function *testWith(compiled: RegExp, input: Value): Generator<Value> {
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

function *splitWith(compiled: RegExp, input: Value): Generator<Value> {
	const text = assertString(input, 'split');
	const pieces: string[] = [];
	let previous = 0;
	for (const match of text.matchAll(compiled)) {
		if (ignoresEmpty(compiled) && match[0] === '') {
			continue;
		}
		pieces.push(text.slice(previous, match.index));
		previous = match.index + match[0].length;
	}
	pieces.push(text.slice(previous));
	yield pieces;
}

/**
 * The functions that match a regex — `test`, `match`, `split`, `sub`, `gsub` — over a compiler,
 * since what a pattern and its flags mean is the library's to say: JavaScript's reading in this
 * one, jq's in the jq library.
 */
export function matching(compile: RegexCompiler): Lib {
	return {
		test: regexFunction(compile, '', testWith),
		match: regexFunction(compile, '', matchWith),
		sub: subFunction(compile, ''),
		gsub: subFunction(compile, 'g'),
		split: overload(
			(render, separator) => values(render, [ separator ], (input, value) => split(assertString(input, 'split'), assertString(value, 'split'))),
			(render, pattern, flags) => function*(input, env) {
				yield* regexOf(compile, render, pattern, flags, 'g')(input, env, splitWith);
			},
		),
	};
}
