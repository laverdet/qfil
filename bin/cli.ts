/**
 * What the binaries share of the command line: flags, output, the run loop, and exit codes. A
 * binary supplies its name and usage, its flags beyond the shared set, and how a parsed command
 * line becomes a runtime, a library and the inputs of a run.
 */
import type { Value } from 'qfil/compiler/filter.js';
import type { RunOptions } from 'qfil/index.js';
import process from 'node:process';
import * as util from 'node:util';
import { CompileError } from 'qfil/compiler/filter.js';
import { ParseError } from 'qfil/compiler/parser.js';
import { compile } from 'qfil/index.js';
import { Halt, JqError, compareStrings, isObject, isString, newObject, tojson } from 'qfil/runtime/lang/value.js';

export type Flags = Readonly<Record<string, string | boolean | undefined>>;

/** A command line the binary cannot read; `execute` answers with the message and the usage. */
class UsageError extends Error {
	override name = 'UsageError';
}

export interface Command {
	/** The binary's name: its error prefix. */
	readonly name: string;
	readonly usage: string;
	/** Flags of the binary's own, beyond the shared set. */
	readonly options: Readonly<Record<string, { readonly type: 'boolean' | 'string'; readonly short?: string }>>;
	/** A parsed command line, as what a run needs: the runtime and library, and the inputs. */
	readonly session: (flags: Flags, files: readonly string[]) => {
		readonly options: Pick<RunOptions, 'lib' | 'runtime'>;
		readonly inputs: Iterable<Value> | AsyncIterable<Value>;
	};
}

/** The flags every binary takes: the input policy, the output shape, bindings and exit status. */
const sharedOptions = {
	'null-input': { type: 'boolean', short: 'n' },
	'raw-output': { type: 'boolean', short: 'r' },
	'join-output': { type: 'boolean', short: 'j' },
	'ascii-output': { type: 'boolean', short: 'a' },
	'compact-output': { type: 'boolean', short: 'c' },
	'sort-keys': { type: 'boolean', short: 'S' },
	tab: { type: 'boolean' },
	indent: { type: 'string' },
	'exit-status': { type: 'boolean', short: 'e' },
	help: { type: 'boolean', short: 'h' },
} as const;

function sortKeys(value: Value): Value {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	} else if (isObject(value)) {
		const sorted = newObject();
		for (const key of Object.keys(value).sort(compareStrings)) {
			sorted[key] = sortKeys(value[key]!);
		}
		return sorted;
	} else {
		return value;
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

/**
 * The command line, read leniently off `parseArgs`'s tokens: a known option is a flag, and an
 * unknown one beginning like a number — `-1`, `-.5` — is the filter it spells, as jq reads it;
 * anything else unknown refuses with its name.
 */
function parsed(argv: readonly string[], options: Readonly<Record<string, { readonly type: 'boolean' | 'string' }>>): { flags: Flags; positionals: string[] } {
	const { tokens } = util.parseArgs({ args: [ ...argv ], allowPositionals: true, strict: false, tokens: true, options });
	const flags: Record<string, string | boolean | undefined> = {};
	const positionals: string[] = [];
	const lifted = new Set<number>();
	for (const token of tokens) {
		if (token.kind === 'positional') {
			positionals.push(token.value);
		} else if (token.kind === 'option') {
			if (Object.hasOwn(options, token.name)) {
				flags[token.name] = options[token.name]!.type === 'boolean' ? true : token.value;
			} else if (lifted.has(token.index)) {
				// Another piece of an argument already taken whole as a positional
			} else if (/^-(?:\d|\.\d)/.test(argv[token.index]!)) {
				lifted.add(token.index);
				positionals.push(argv[token.index]!);
			} else {
				throw new UsageError(`Unknown option ${token.rawName}`);
			}
		}
	}
	return { flags, positionals };
}

async function main(command: Command, argv: readonly string[]): Promise<number> {
	const { args, rest } = namedArguments(argv);
	const { flags, positionals } = parsed(rest, { ...sharedOptions, ...command.options });
	if (flags.help === true) {
		process.stdout.write(command.usage);
		return 0;
	}
	const [ source, ...files ] = positionals;
	if (source === undefined) {
		process.stderr.write(command.usage);
		return 2;
	}
	const { options, inputs } = command.session(flags, files);
	// One iterator, shared between the run loop below and what `input` and `inputs` read
	const shared = function(): Iterable<Value> | AsyncIterable<Value> {
		if (Symbol.asyncIterator in inputs) {
			const remaining = inputs[Symbol.asyncIterator]();
			return { [Symbol.asyncIterator]: () => remaining };
		} else {
			const remaining = inputs[Symbol.iterator]();
			return { [Symbol.iterator]: () => remaining };
		}
	}();
	const filter = compile(source, { ...options, args, inputs: shared });
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
		const line = raw && isString(sorted) ? String(sorted) : tojson(sorted, indent);
		process.stdout.write(`${flags['ascii-output'] === true ? escapeNonAscii(line) : line}${separator}`);
	};
	const run = async (input: Value) => {
		if (filter.awaits) {
			for await (const output of filter(input)) {
				write(output);
			}
		} else if (filter.stream) {
			for (const output of filter(input)) {
				write(output);
			}
		} else {
			write(filter(input));
		}
	};
	if (flags['null-input'] === true) {
		await run(null);
	} else {
		for await (const input of shared) {
			await run(input);
		}
	}
	if (flags['exit-status'] !== true) {
		return 0;
	} else if (last === undefined) {
		return 4;
	} else {
		return last === null || last === false ? 1 : 0;
	}
}

/** A binary's whole run: `main`, with errors written under its name and turned into jq's exit codes. */
export async function execute(command: Command, argv: readonly string[]): Promise<number> {
	try {
		return await main(command, argv);
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${command.name}: ${error.message}\n${command.usage}`);
			return 2;
		} else if (error instanceof Halt) {
			if (error.value !== undefined) {
				process.stderr.write(typeof error.value === 'string' ? error.value : `${tojson(error.value)}\n`);
			}
			return error.code;
		} else if (error instanceof JqError) {
			process.stderr.write(`${command.name}: error: ${error.message}\n`);
			return 5;
		} else if (error instanceof ParseError || error instanceof CompileError) {
			process.stderr.write(`${command.name}: error: ${error.message}\n${command.name}: 1 compile error\n`);
			return 3;
		}
		throw error;
	}
}
