/** The filesystem runtime and the `fq` binary. */
import type { Value } from '#/index.js';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { run } from './harness.js';
import { JqError } from '#/index.js';
import { runtime as fsRuntime } from '#/runtime/fs/runtime.js';
import { entry } from '#/runtime/fs/value.js';

/** The filesystem runtime, over a fixture tree with pinned sizes and mtimes. */
describe('the filesystem runtime', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qfil-fs-'));
	fs.writeFileSync(path.join(root, 'a.txt'), 'aaa');
	fs.writeFileSync(path.join(root, 'b.ts'), 'bbbbb');
	fs.mkdirSync(path.join(root, 'sub'));
	fs.writeFileSync(path.join(root, 'sub', 'c.ts'), 'ccccccc');
	fs.mkdirSync(path.join(root, 'sub', 'deep'));
	fs.writeFileSync(path.join(root, 'sub', 'deep', 'd.txt'), 'dd');
	for (const [ name, when ] of [ [ 'a.txt', 1000 ], [ 'b.ts', 2000 ], [ 'sub/c.ts', 3000 ], [ 'sub/deep/d.txt', 4000 ], [ 'sub/deep', 500 ], [ 'sub', 500 ] ] as const) {
		fs.utimesSync(path.join(root, name), when, when);
	}
	after(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	const query = (filter: string): Value[] => run(filter, entry(root), { runtime: fsRuntime }) as Value[];

	it('sums the sizes in a directory', () => {
		assert.deepEqual(query('[.[] | select(.type == "file") | .size] | add'), [ 8 ]);
	});
	it('sums every size beneath', () => {
		assert.deepEqual(query('[.. | select(.type == "file") | .size] | add'), [ 17 ]);
	});
	it('walks for names matching a pattern', () => {
		assert.deepEqual(query('[.. | select(.name | test("\\\\.ts$")) | .name]'), [ [ 'b.ts', 'c.ts' ] ]);
	});
	it('finds the most recently written file', () => {
		assert.deepEqual(query('[.. | select(.type == "file")] | sort_by(.mtime) | last | .name'), [ 'd.txt' ]);
	});
	it('lists a directory in name order', () => {
		assert.deepEqual(query('[.[] | .name]'), [ [ 'a.txt', 'b.ts', 'sub' ] ]);
	});
	it('iterates optionally over directories too', () => {
		assert.deepEqual(query('[.[]? | .name] | length'), [ 3 ]);
	});
	it('leaves plain data its JavaScript meaning', () => {
		assert.deepEqual(run('{a: 1, b: 2} | [.[]]', null, { runtime: fsRuntime }), [ [ 1, 2 ] ]);
		assert.deepEqual(run('[{a: 1} | ..] | length', null, { runtime: fsRuntime }), [ 2 ]);
	});
	it('raises a missing path as the language\'s own error', () => {
		assert.throws(() => entry(path.join(root, 'nope')), JqError);
	});
	it('is the fq binary over a root', () => {
		const result = spawnSync(process.execPath, [ path.join(import.meta.dirname, '..', 'bin', 'fq.js'), '-c', '[.[] | .name]', root ], { encoding: 'utf8' });
		assert.deepEqual({ status: result.status, stdout: result.stdout }, { status: 0, stdout: '["a.txt","b.ts","sub"]\n' });
	});
});
