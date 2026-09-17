/**
 * The suite's harness. `launch` and `invoke` run the package's binaries. Differential tests: every case runs through both this compiler and the
 * `jq` binary, and the outputs must agree as JSON values. A case where both raise an error passes
 * without comparing the messages; `divergent` holds the cases where this implementation is meant
 * to differ. `differential` binds a flavor's run options — each test file makes the suite for
 * the runtime it speaks about.
 */
import type { Filter, RunOptions, Value } from '#/index.js';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import { text } from 'node:stream/consumers';
import { describe, it } from 'node:test';
import { compile as compileWith, run as runWith } from '#/index.js';
import { tojson } from '#/runtime/lang/value.js';

export type Case = readonly [ filter: string, input?: Value, inputs?: readonly Value[] ];

/** The differential suite over one flavor, bound to its run options. */
export interface Suite {
	readonly compile: (source: string, options?: Partial<RunOptions>) => Filter;
	readonly run: (source: string, input: Value, options?: Partial<RunOptions>) => Value[] | Promise<Value[]>;
	/** Cases where this implementation and the binary agree. */
	readonly agree: (name: string, cases: readonly Case[]) => void;
	/** Cases compared as text, from JSON text: where how a number is spelled is the point. */
	readonly agreeText: (name: string, cases: readonly (readonly [ filter: string, input?: string ])[]) => void;
	/** Cases where this implementation deliberately differs from jq 1.8. */
	readonly divergent: (name: string, cases: readonly (readonly [ filter: string, input: Value, expected: Value[] | 'error' ])[]) => void;
}

/** A whole run of a binary: its exit status, and what it wrote. */
export interface Invocation {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

const piped = (child: ChildProcess): child is ChildProcessWithoutNullStreams =>
	child.stdin !== null && child.stdout !== null && child.stderr !== null;

/** One of the package's binaries, forked off the running node with its streams piped back. */
export function launch(bin: string, args: readonly string[]): ChildProcessWithoutNullStreams {
	const child = fork(path.join(import.meta.dirname, '..', 'bin', `${bin}.js`), args, { stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ] });
	assert.ok(piped(child));
	return child;
}

/** Runs a binary to its exit, over `input` as the whole of its standard input. */
export async function invoke(bin: string, args: readonly string[], input = ''): Promise<Invocation> {
	const child = launch(bin, args);
	child.stdin.end(input);
	const [ stdout, stderr, [ status ] ] = await Promise.all([ text(child.stdout), text(child.stderr), once(child, 'exit') as Promise<[ number | null ]> ]);
	return { status, stdout, stderr };
}

/** jq's output for a filter over some JSON text: one line of text per output. */
function jqOutput(filter: string, stdin: string): string[] | 'error' {
	try {
		const text = execFileSync('jq', [ '-c', filter ], { input: stdin, stdio: [ 'pipe', 'pipe', 'pipe' ] }).toString();
		return text.trim().split('\n').filter(line => line !== '');
	} catch {
		return 'error';
	}
}

function expected(filter: string, input: Value, inputs: readonly Value[] = []): Value[] | 'error' {
	const output = jqOutput(filter, [ input, ...inputs ].map(value => JSON.stringify(value)).join('\n'));
	return output === 'error' ? output : output.map(line => JSON.parse(line) as Value);
}

/** The suite over one flavor's run options; `parse` reads a case's input text as the flavor does. */
export function differential(base: RunOptions, parse: (text: string) => Value = text => JSON.parse(text) as Value): Suite {
	const compile: Suite['compile'] = (source, options) => compileWith(source, { ...base, ...options });
	const run: Suite['run'] = (source, input, options) => runWith(source, input, { ...base, ...options });

	/** Runs as the command line does: once per input, the rest being what `input` reads; each output as JSON text. */
	const oursOutput = (filter: string, values: readonly Value[]): string[] | 'error' => {
		const iterator = values[Symbol.iterator]();
		const shared = { [Symbol.iterator]: () => iterator };
		try {
			const compiled = compile(filter, { inputs: shared, debug: () => {} });
			if (compiled.awaits) {
				throw new Error('an awaiting filter in a differential case');
			}
			const outputs: Value[] = [];
			for (const value of shared) {
				outputs.push(...compiled.stream ? compiled(value) : [ compiled(value) ]);
			}
			return outputs.map(output => tojson(output));
		} catch {
			return 'error';
		}
	};

	/** Through JSON, since that is how jq's output reaches us: NaN and infinities have no other form. */
	const ours = (filter: string, input: Value, inputs: readonly Value[] = []): Value[] | 'error' => {
		const output = oursOutput(filter, [ input, ...inputs ]);
		return output === 'error' ? output : output.map(line => JSON.parse(line) as Value);
	};

	const agree: Suite['agree'] = (name, cases) => {
		describe(name, () => {
			for (const [ filter, input = null, inputs = [] ] of cases) {
				it(filter, () => {
					const wanted = expected(filter, input, inputs);
					const actual = ours(filter, input, inputs);
					if (wanted === 'error') {
						assert.equal(actual, 'error', `jq raised an error but we produced ${JSON.stringify(actual)}`);
					} else {
						assert.deepEqual(actual, wanted);
					}
				});
			}
		});
	};

	const agreeText: Suite['agreeText'] = (name, cases) => {
		describe(name, () => {
			for (const [ filter, input = 'null' ] of cases) {
				it(filter, () => {
					const wanted = jqOutput(filter, input);
					const actual = oursOutput(filter, [ parse(input) ]);
					if (wanted === 'error') {
						assert.equal(actual, 'error', `jq raised an error but we produced ${JSON.stringify(actual)}`);
					} else {
						assert.deepEqual(actual, wanted);
					}
				});
			}
		});
	};

	const divergent: Suite['divergent'] = (name, cases) => {
		describe(name, () => {
			for (const [ filter, input, wanted ] of cases) {
				it(filter, () => {
					assert.deepEqual(ours(filter, input), wanted);
					// A divergence must diverge: were the binary to agree, the case belongs in `agree`
					assert.notDeepEqual(expected(filter, input), wanted, 'jq produces the same output; this case is not divergent');
				});
			}
		});
	};

	return { compile, run, agree, agreeText, divergent };
}
