/** The `qfil` binary: its command line, its input and output, how it ends. */
import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { invoke, launch } from './harness.js';

const qfil = (args: readonly string[], input?: string) => invoke('qfil', args, input);

describe('qfil', () => {
	it('runs a filter over each input', async () => {
		assert.deepEqual(await qfil([ '-c', '.a + 1' ], '{"a":1} {"a":2}'), { status: 0, stdout: '2\n3\n', stderr: '' });
	});
	it('binds --arg and --argjson', async () => {
		assert.deepEqual(await qfil([ '-n', '-r', '--arg', 'who', 'world', '--argjson', 'n', '[1,2]', '"hello \\($who) \\($n | length)"' ]), { status: 0, stdout: 'hello world 2\n', stderr: '' });
	});
	it('slurps, reads raw lines, and pretty prints', async () => {
		assert.equal((await qfil([ '-s', '-c', 'add' ], '1 2 3')).stdout, '6\n');
		assert.equal((await qfil([ '-R', '-c', '.' ], 'a\nb\n')).stdout, '"a"\n"b"\n');
		assert.equal((await qfil([ '-n', '-c', '[inputs]' ], '1 2 3')).stdout, '[1,2,3]\n');
		assert.equal((await qfil([ '-S', '--tab', '.' ], '{"b":1,"a":[1]}')).stdout, '{\n\t"a": [\n\t\t1\n\t],\n\t"b": 1\n}\n');
		assert.equal((await qfil([ '-j', '.[]' ], '["a","b"]')).stdout, 'ab');
		assert.equal((await qfil([ '-c', '., (. + 0)' ], '1.000')).stdout, '1.000\n1\n');
		assert.equal((await qfil([ '--runtime', 'js', '-c', '.' ], '1.000')).stdout, '1\n');
	});
	it('reads concatenated values under jq, and JSON Lines under js', async () => {
		assert.deepEqual(await qfil([ '-c', '.' ], '"foo""bar"'), { status: 0, stdout: '"foo"\n"bar"\n', stderr: '' });
		assert.equal((await qfil([ '-c', '.' ], '{"a":1}{"a":2}[3]4"x"')).stdout, '{"a":1}\n{"a":2}\n[3]\n4\n"x"\n');
		assert.equal((await qfil([ '--runtime', 'js', '-c', '.a' ], '{"a":1}\n\n{"a":2}')).stdout, '1\n2\n');
		assert.equal((await qfil([ '--runtime', 'js', '.' ], '"foo""bar"')).status, 5);
	});
	it('yields each output before the input ends', async () => {
		const child = launch('qfil', [ '-c', '.' ]);
		const outputs = child.stdout.setEncoding('utf8')[Symbol.asyncIterator]();
		child.stdin.write('"first"');
		assert.deepEqual(await outputs.next(), { done: false, value: '"first"\n' });
		child.stdin.write('{"half":');
		child.stdin.write('1}');
		assert.deepEqual(await outputs.next(), { done: false, value: '{"half":1}\n' });
		child.stdin.end();
		assert.deepEqual(await outputs.next(), { done: true, value: undefined });
	});
	it('goes on to the next input after an error, and exits as the last input went', async () => {
		const filter = 'if . == "b" then error("wow") else . end';
		assert.deepEqual(await qfil([ '-R', filter ], 'a\nb\nc\n'), { status: 0, stdout: '"a"\n"c"\n', stderr: 'qfil: error: wow\n' });
		assert.deepEqual(await qfil([ '-R', filter ], 'a\nb\n'), { status: 5, stdout: '"a"\n', stderr: 'qfil: error: wow\n' });
		assert.equal((await qfil([ '-R', '-e', filter ], 'a\nb\n')).status, 5);
	});
	it('ends at a halt, with input still to come', async () => {
		const child = launch('qfil', [ '-R', 'halt' ]);
		// Stdin is never ended: the exit is the run's own
		child.stdin.write('line\n');
		const [ status ] = await once(child, 'exit') as [ number | null ];
		assert.equal(status, 0);
	});
	it('exits as jq does', async () => {
		assert.equal((await qfil([ '-n', '1 +' ])).status, 3);
		assert.deepEqual(await qfil([ '-n', 'error("boom")' ]), { status: 5, stdout: '', stderr: 'qfil: error: boom\n' });
		assert.deepEqual(await qfil([ '-n', '"bye" | halt_error(3)' ]), { status: 3, stdout: '', stderr: 'bye' });
		assert.equal((await qfil([ '-n', '-e', 'null' ])).status, 1);
		assert.equal((await qfil([ '-n', '-e', 'empty' ])).status, 4);
		assert.equal((await qfil([ '-n', '-e', '1' ])).status, 0);
	});
});
