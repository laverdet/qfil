#!/usr/bin/env node
/**
 * `jsjq` — jq at a shell prompt, compiled to JavaScript: `jsjq [options] <filter> [file...]`.
 * The jq runtime — spelled numbers, jq's total order — unless `--runtime js` asks for
 * JavaScript's.
 */
import type { Command } from './cli.js';
import type { Value } from 'qfil/compiler/filter.js';
import type { RunOptions } from 'qfil/index.js';
import * as fs from 'node:fs';
import process from 'node:process';
import { lib as jqLib } from 'qfil/runtime/jq/index.js';
import { runtime as jqRuntime } from 'qfil/runtime/jq/runtime.js';
import { fromjson as jqFromjson } from 'qfil/runtime/jq/value.js';
import { lib as jsLib } from 'qfil/runtime/js/index.js';
import { runtime as jsRuntime } from 'qfil/runtime/js/runtime.js';
import { execute } from './cli.js';

const USAGE = `usage: jsjq [options] <filter> [file...]

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
      --runtime <jq|js>  jq's numbers and order (default), or JavaScript's
  -h, --help
`;

/** The runtimes a filter can run with, each with how it reads JSON. */
const flavours: Readonly<Record<string, { readonly options: Pick<RunOptions, 'lib' | 'runtime'>; readonly parse: (text: string) => Value }>> = {
	jq: { options: { runtime: jqRuntime, lib: jqLib }, parse: jqFromjson },
	js: { options: { runtime: jsRuntime, lib: jsLib }, parse: text => JSON.parse(text) as Value },
};

/** Splits a text holding any number of JSON values, whitespace-separated, into the values. */
function parseJsonStream(text: string, parse: (text: string) => Value): Value[] {
	const values: Value[] = [];
	let at = 0;
	while (true) {
		while (at < text.length && /\s/.test(text[at]!)) {
			++at;
		}
		if (at >= text.length) {
			return values;
		}
		const end = scanValue(text, at);
		values.push(parse(text.slice(at, end)));
		at = end;
	}
}

/** The end of the JSON value beginning at `start`. */
function scanValue(text: string, start: number): number {
	let depth = 0;
	let at = start;
	while (at < text.length) {
		const char = text[at]!;
		if (char === '"') {
			at = scanString(text, at);
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
		} else if (depth === 0 && /[\s,\]}]/.test(char)) {
			return at;
		}
		++at;
	}
	return at;
}

function scanString(text: string, start: number): number {
	for (let at = start + 1; at < text.length; ++at) {
		if (text[at] === '\\') {
			++at;
		} else if (text[at] === '"') {
			return at + 1;
		}
	}
	throw new SyntaxError('Unterminated string in input');
}

/**
 * All of standard input. `readFileSync(0)` would do, except that a non-blocking stdin — a terminal,
 * some pipes — answers `EAGAIN` rather than waiting, so this reads a chunk at a time and waits out
 * those itself.
 */
function readStdin(): string {
	const chunks: Buffer[] = [];
	const buffer = Buffer.alloc(1 << 16);
	while (true) {
		const read = function() {
			try {
				return fs.readSync(0, buffer);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					return -1;
				} else if ((error as NodeJS.ErrnoException).code === 'EOF') {
					return 0;
				}
				throw error;
			}
		}();
		if (read === 0) {
			return Buffer.concat(chunks).toString('utf8');
		} else if (read > 0) {
			chunks.push(Buffer.from(buffer.subarray(0, read)));
		}
	}
}

const jsjq: Command = {
	name: 'jsjq',
	usage: USAGE,
	options: {
		'raw-input': { type: 'boolean', short: 'R' },
		slurp: { type: 'boolean', short: 's' },
		runtime: { type: 'string' },
	},
	session: (flags, files) => {
		const flavour = flavours[typeof flags.runtime === 'string' ? flags.runtime : 'jq'] ?? function() {
			throw new Error(`--runtime must be one of ${Object.keys(flavours).join(', ')}`);
		}();
		// Inputs are read when something first asks for one, so that `-n` without `input` reads nothing
		const inputs = function*(): Iterable<Value> {
			const text = files.length === 0 ? readStdin() : files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
			if (flags['raw-input'] === true) {
				if (flags.slurp === true) {
					yield text;
				} else {
					const lines = text.split('\n');
					yield* text.endsWith('\n') ? lines.slice(0, -1) : lines;
				}
			} else {
				const parsed = parseJsonStream(text, flavour.parse);
				if (flags.slurp === true) {
					yield parsed;
				} else {
					yield* parsed;
				}
			}
		}();
		return { options: flavour.options, inputs };
	},
};

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = await execute(jsjq, process.argv.slice(2));
}
