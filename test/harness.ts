/**
 * The suite's harness. Differential tests: every case runs through both this compiler and the
 * `jq` binary, and the outputs must agree as JSON values. A case where both raise an error passes
 * without comparing the messages; `divergent` holds the cases where this implementation is meant
 * to differ. `compile` and `run` carry the JavaScript runtime; a case opts into another with its
 * options.
 */
import type { Filter, RunOptions, Value } from '#/index.js';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { compile as compileWith, run as runWith } from '#/index.js';
import { lib } from '#/runtime/js/index.js';
import { runtime } from '#/runtime/js/runtime.js';
import { tojson } from '#/runtime/js/value.js';

export const compile = (source: string, options?: Partial<RunOptions>): Filter => compileWith(source, { runtime, lib, ...options });
export const run = (source: string, input: Value, options?: Partial<RunOptions>): Value[] | Promise<Value[]> => runWith(source, input, { runtime, lib, ...options });

export type Case = readonly [ filter: string, input?: Value, inputs?: readonly Value[] ];

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

/** Runs as the command line does: once per input, the rest being what `input` reads; each output as JSON text. */
function oursOutput(filter: string, values: readonly Value[], options: Partial<RunOptions> = {}): string[] | 'error' {
	const iterator = values[Symbol.iterator]();
	const shared = { [Symbol.iterator]: () => iterator };
	try {
		const compiled = compile(filter, { inputs: shared, debug: () => {}, ...options });
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
}

/** Through JSON, since that is how jq's output reaches us: NaN and infinities have no other form. */
function ours(filter: string, input: Value, inputs: readonly Value[] = [], options?: Partial<RunOptions>): Value[] | 'error' {
	const output = oursOutput(filter, [ input, ...inputs ], options);
	return output === 'error' ? output : output.map(line => JSON.parse(line) as Value);
}

/** Cases where this implementation deliberately differs from jq 1.8. */
export function divergent(name: string, cases: readonly (readonly [ filter: string, input: Value, expected: Value[] | 'error' ])[], options?: Partial<RunOptions>): void {
	describe(name, () => {
		for (const [ filter, input, expected ] of cases) {
			it(filter, () => {
				assert.deepEqual(ours(filter, input, [], options), expected);
			});
		}
	});
}

export function agree(name: string, cases: readonly Case[], options?: Partial<RunOptions>): void {
	describe(name, () => {
		for (const [ filter, input = null, inputs = [] ] of cases) {
			it(filter, () => {
				const wanted = expected(filter, input, inputs);
				const actual = ours(filter, input, inputs, options);
				if (wanted === 'error') {
					assert.equal(actual, 'error', `jq raised an error but we produced ${JSON.stringify(actual)}`);
				} else {
					assert.deepEqual(actual, wanted);
				}
			});
		}
	});
}

/** Cases compared as text, from JSON text: where how a number is spelled is the point. */
export function agreeText(name: string, cases: readonly (readonly [ filter: string, input?: string ])[], options: RunOptions, parse: (text: string) => Value): void {
	describe(name, () => {
		for (const [ filter, input = 'null' ] of cases) {
			it(filter, () => {
				const wanted = jqOutput(filter, input);
				const actual = oursOutput(filter, [ parse(input) ], options);
				if (wanted === 'error') {
					assert.equal(actual, 'error', `jq raised an error but we produced ${JSON.stringify(actual)}`);
				} else {
					assert.deepEqual(actual, wanted);
				}
			});
		}
	});
}
