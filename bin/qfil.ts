#!/usr/bin/env node
/**
 * `qfil` — jq at a shell prompt, compiled to JavaScript: `qfil [options] <filter> [file...]`.
 * The jq runtime — spelled numbers, jq's total order, concatenated JSON values read off the input
 * as they complete — unless `--runtime js` asks for JavaScript's, whose input is JSON Lines.
 */
import type { Command } from './cli.js';
import type { Value } from 'qfil/compiler/filter.js';
import type { RunOptions } from 'qfil/index.js';
import * as fs from 'node:fs';
import process from 'node:process';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import * as jqLib from 'qfil/runtime/jq/index.js';
import * as jqRuntime from 'qfil/runtime/jq/runtime.js';
import { fromjson as jqFromjson } from 'qfil/runtime/jq/value.js';
import * as jsLib from 'qfil/runtime/js/index.js';
import * as jsRuntime from 'qfil/runtime/js/runtime.js';
import { fromjson as jsFromjson } from 'qfil/runtime/lang/value.js';
import { execute } from './cli.js';

const USAGE = `usage: qfil [options] <filter> [file...]

  -n, --null-input       use null as the input; the inputs are read by \`input\` and \`inputs\`
  -R, --raw-input        read each line of input as a string
  -s, --slurp            read all inputs into one array
  -r, --raw-output       write strings without quotes
  -j, --join-output      raw output, without newlines
  -a, --ascii-output     escape non-ASCII characters
  -c, --compact-output   one line per output
  -S, --sort-keys        sort object keys
      --tab              indent with tabs
      --indent <n>       indent with n spaces (default 2)
  -e, --exit-status      exit 1 when the last output is false or null, 4 when there is none
      --arg <name> <value>     bind $name to a string
      --argjson <name> <json>  bind $name to a JSON value
      --runtime <jq|js>  jq's numbers and order (default), or JavaScript's; js reads JSON Lines
  -h, --help
`;

/** The stream's text, a chunk at a time. */
const texts = (source: Readable): AsyncIterable<string> => source as AsyncIterable<string>;

/** The stream's lines, CRLF or LF, each yielded as its newline arrives. */
const lines = (source: Readable): AsyncIterable<string> =>
	readline.createInterface({ input: source, crlfDelay: Infinity });

/**
 * The runtimes a filter can run with, each with how its inputs come off the input stream:
 * concatenated JSON values for the jq flavor, JSON Lines for JavaScript's.
 */
const flavors: Readonly<Record<string, { readonly options: Pick<RunOptions, 'lib' | 'runtime'>; readonly values: (source: Readable) => AsyncIterable<Value> }>> = {
	jq: { options: { runtime: jqRuntime, lib: jqLib }, values: source => concatenated(texts(source), jqFromjson) },
	js: { options: { runtime: jsRuntime, lib: jsLib }, values: source => jsonLines(lines(source)) },
};

/** JSON Lines: one value per line, blank lines passed over. */
async function *jsonLines(source: AsyncIterable<string>): AsyncIterable<Value> {
	for await (const line of source) {
		if (/\S/.test(line)) {
			yield jsFromjson(line);
		}
	}
}

/**
 * A stream of JSON values off a stream of chunks: what has arrived is scanned cumulatively, so a
 * value is yielded as soon as the text completing it is in, ahead of the rest of the input.
 */
async function *concatenated(chunks: AsyncIterable<string>, parse: (text: string) => Value): AsyncIterable<Value> {
	let buffer = '';
	const drain = function*(complete: boolean): Iterable<Value> {
		let at = 0;
		while (true) {
			while (at < buffer.length && /\s/.test(buffer[at]!)) {
				++at;
			}
			if (at >= buffer.length) {
				break;
			}
			const end = scanValue(buffer, at, complete);
			if (end === 'more') {
				break;
			}
			yield parse(buffer.slice(at, end));
			at = end;
		}
		buffer = buffer.slice(at);
	};
	for await (const chunk of chunks) {
		buffer += chunk;
		yield* drain(false);
	}
	yield* drain(true);
}

/**
 * The end of the JSON value beginning at `start`, or `'more'` when the text ran out with the value
 * possibly continuing — unless `complete`, when what there is is all there will be and the parser
 * gets the rest, and the verdict on it.
 */
function scanValue(text: string, start: number, complete: boolean): number | 'more' {
	let depth = 0;
	let at = start;
	while (at < text.length) {
		const char = text[at]!;
		if (depth === 0 && at > start && /["\s,{}[\]]/.test(char)) {
			// A top-level value that reaches here is a scalar, which any new token ends
			return at;
		} else if (char === '"') {
			const end = scanString(text, at);
			if (end === 'more') {
				break;
			}
			at = end;
			if (depth === 0) {
				return at;
			}
			continue;
		} else if (char === '{' || char === '[') {
			++depth;
		} else if (char === '}' || char === ']') {
			--depth;
			if (depth === 0) {
				return at + 1;
			}
		}
		++at;
	}
	return complete ? text.length : 'more';
}

/** Past the closing quote of the string opening at `start`, or `'more'` without one. */
function scanString(text: string, start: number): number | 'more' {
	for (let at = start + 1; at < text.length; ++at) {
		if (text[at] === '\\') {
			++at;
		} else if (text[at] === '"') {
			return at + 1;
		}
	}
	return 'more';
}

/** Standard input, or each file in turn, as one stream of text. */
function source(files: readonly string[]): Readable {
	if (files.length === 0) {
		process.stdin.setEncoding('utf8');
		return process.stdin;
	}
	return Readable.from(async function*(): AsyncIterable<string> {
		for (const [ index, file ] of files.entries()) {
			const text = await fs.promises.readFile(file, 'utf8');
			yield index === 0 ? text : `\n${text}`;
		}
	}());
}

const qfil: Command = {
	name: 'qfil',
	usage: USAGE,
	options: {
		'raw-input': { type: 'boolean', short: 'R' },
		slurp: { type: 'boolean', short: 's' },
		runtime: { type: 'string' },
	},
	session: (flags, files) => {
		const flavor = flavors[typeof flags.runtime === 'string' ? flags.runtime : 'jq'] ?? function() {
			throw new Error(`--runtime must be one of ${Object.keys(flavors).join(', ')}`);
		}();
		// Inputs are read when something first asks for one — `-n` without `input` reads nothing —
		// and stream: each is yielded as the text completing it arrives
		const inputs = async function*(): AsyncIterable<Value> {
			const input = source(files);
			if (flags['raw-input'] === true) {
				if (flags.slurp === true) {
					let text = '';
					for await (const chunk of texts(input)) {
						text += chunk;
					}
					yield text;
				} else {
					yield* lines(input);
				}
			} else if (flags.slurp === true) {
				const all: Value[] = [];
				for await (const value of flavor.values(input)) {
					all.push(value);
				}
				yield all;
			} else {
				yield* flavor.values(input);
			}
		}();
		return { options: flavor.options, inputs };
	},
};

process.exitCode = await execute(qfil, process.argv.slice(2));
