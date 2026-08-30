#!/usr/bin/env node
/**
 * `jssq` — jq at a shell prompt, compiled to JavaScript: `jssq [options] <filter> [file...]`.
 */
import type { Value } from './lib/value.js';
import * as fs from 'node:fs';
import process from 'node:process';
import * as util from 'node:util';
import { CompileError } from './lib/filter.js';
import { Halt, JqError, compareStrings, isObject, newObject, tojson } from './lib/value.js';
import { ParseError } from './parser.js';
import { compile } from './index.js';

const USAGE = `usage: jssq [options] <filter> [file...]

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
  -h, --help
`;

/** Splits a text holding any number of JSON values, whitespace-separated, into the values. */
export function parseJsonStream(text: string): Value[] {
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
		values.push(JSON.parse(text.slice(at, end)) as Value);
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

function sortKeys(value: Value): Value {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	} else if (isObject(value)) {
		const sorted = newObject();
		for (const key of Object.keys(value).sort(compareStrings)) {
			sorted[key] = sortKeys(value[key]!);
		}
		return sorted;
	}
	return value;
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

function escapeNonAscii(text: string): string {
	return text.replace(/[-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Takes `--arg name value` and `--argjson name json` out of the arguments, since `parseArgs` gives
 * an option one value, and returns the bindings with what is left.
 */
function namedArguments(argv: readonly string[]): { args: Record<string, Value>; rest: string[] } {
	const args: Record<string, Value> = {};
	const rest: string[] = [];
	for (let ii = 0; ii < argv.length; ++ii) {
		const flag = argv[ii]!;
		if (flag === '--arg' || flag === '--argjson') {
			const name = argv[ii + 1];
			const value = argv[ii + 2];
			if (name === undefined || value === undefined) {
				throw new Error(`${flag} takes a name and a value`);
			}
			args[name] = flag === '--arg' ? value : JSON.parse(value) as Value;
			ii += 2;
		} else {
			rest.push(flag);
		}
	}
	return { args, rest };
}

export function main(argv: readonly string[]): number {
	const { args, rest } = namedArguments(argv);
	const { values: flags, positionals } = util.parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			'null-input': { type: 'boolean', short: 'n' },
			'raw-input': { type: 'boolean', short: 'R' },
			slurp: { type: 'boolean', short: 's' },
			'raw-output': { type: 'boolean', short: 'r' },
			'join-output': { type: 'boolean', short: 'j' },
			'ascii-output': { type: 'boolean', short: 'a' },
			'compact-output': { type: 'boolean', short: 'c' },
			'sort-keys': { type: 'boolean', short: 'S' },
			tab: { type: 'boolean' },
			indent: { type: 'string' },
			'exit-status': { type: 'boolean', short: 'e' },
			help: { type: 'boolean', short: 'h' },
		},
	});
	if (flags.help === true) {
		process.stdout.write(USAGE);
		return 0;
	}
	const [ source, ...files ] = positionals;
	if (source === undefined) {
		process.stderr.write(USAGE);
		return 2;
	}
	// Inputs are read when something first asks for one, so that `-n` without `input` reads nothing
	const inputs = function*(): Iterable<Value> {
		const text = files.length === 0 ? readStdin() : files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
		if (flags['raw-input'] === true) {
			if (flags.slurp === true) {
				yield text;
				return;
			}
			const lines = text.split('\n');
			yield* text.endsWith('\n') ? lines.slice(0, -1) : lines;
			return;
		}
		const parsed = parseJsonStream(text);
		if (flags.slurp === true) {
			yield parsed;
		} else {
			yield* parsed;
		}
	}();
	const remaining = inputs[Symbol.iterator]();
	const filter = compile(source, { args, inputs: { [Symbol.iterator]: () => remaining } });
	const indent = function() {
		if (flags.tab === true) {
			return '\t';
		} else if (flags['compact-output'] === true) {
			return undefined;
		}
		return Number(flags.indent ?? 2);
	}();
	const raw = flags['raw-output'] === true || flags['join-output'] === true;
	const separator = flags['join-output'] === true ? '' : '\n';
	let last: Value | undefined;
	const write = (value: Value) => {
		last = value;
		const sorted = flags['sort-keys'] === true ? sortKeys(value) : value;
		const line = raw && typeof sorted === 'string' ? sorted : tojson(sorted, indent);
		process.stdout.write(`${flags['ascii-output'] === true ? escapeNonAscii(line) : line}${separator}`);
	};
	const run = (input: Value) => {
		if (filter.stream) {
			for (const output of filter(input)) {
				write(output);
			}
		} else {
			write(filter(input));
		}
	};
	if (flags['null-input'] === true) {
		run(null);
	} else {
		for (const input of { [Symbol.iterator]: () => remaining }) {
			run(input);
		}
	}
	if (flags['exit-status'] !== true) {
		return 0;
	} else if (last === undefined) {
		return 4;
	}
	return last === null || last === false ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		if (error instanceof Halt) {
			if (error.value !== undefined) {
				process.stderr.write(typeof error.value === 'string' ? error.value : `${tojson(error.value)}\n`);
			}
			process.exitCode = error.code;
		} else if (error instanceof JqError) {
			process.stderr.write(`jssq: error: ${error.message}\n`);
			process.exitCode = 5;
		} else if (error instanceof ParseError || error instanceof CompileError) {
			process.stderr.write(`jssq: error: ${error.message}\njssq: 1 compile error\n`);
			process.exitCode = 3;
		} else {
			throw error;
		}
	}
}
