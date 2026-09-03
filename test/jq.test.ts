/** The jq runtime — jq's numbers, jq's order, jq's regex flags — and the `jsjq` binary. */
import type { RunOptions } from '#/index.js';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { agree, agreeText, run } from './harness.js';
import { lib as jqLib } from '#/runtime/jq/index.js';
import { runtime as jqRuntime } from '#/runtime/jq/runtime.js';
import { fromjson as jqFromjson } from '#/runtime/jq/value.js';

const jqOptions: RunOptions = { runtime: jqRuntime, lib: jqLib };

agree('jq runtime: jq\'s order', [
	[ '([] < {}), (null < false), (true < 0), (1 < "a"), ({} > []), ([1] < [1, 0])' ],
	[ '[1, "a", null, true, [], {}] | sort' ],
	[ 'sort', [ { b: 1 }, { a: 2 }, { a: 1, b: 0 }, { a: 1 } ] ],
	[ 'sort', [ [ 1, 2 ], [ 1 ], [ 0, 5 ], [] ] ],
	[ 'unique, group_by(type)', [ 1, [ 1 ], { a: 1 }, '1', null, 1, true ] ],
	[ 'sort_by(.a)', [ { a: [ 1 ] }, { a: 'x' }, { a: null }, { a: {} } ] ],
], jqOptions);

agree('jq runtime: jq\'s regex flags', [
	// `x` ignores whitespace and comments outside a class; an escaped space is a space
	[ '[test("a b"; "x"), test("a # comment\\nb"; "x")]', 'ab' ],
	[ '[test("a b"; "x"), test("a[ ]b"; "x"), test("a\\\\ b"; "x")]', 'a b' ],
	[ 'gsub("[0-9] "; "-"; "x")', 'a1b2' ],
	// `m` and `p` put `.` across newlines; `s` anchors as the default already does
	[ '[test("a.b"; "m"), test("a.b"; "p"), test("a.b"; "s"), test("a.b"), test("^b"; "m")]', 'a\nb' ],
	// `n` discards empty matches, wherever matches are counted
	[ '[match("a*"; "gn") | .offset], (match("a*"; "n") | .offset), test("a*"; "n"), split("a*"; "n")', 'bab' ],
	[ 'test("a*"; "n")', 'b' ],
	[ 'test("a"; "q")' ],
], jqOptions);

describe('jq runtime: what JavaScript cannot match', () => {
	it('refuses the longest-match flag', () => {
		assert.throws(() => run('match("a|aa"; "l")', 'aaa', jqOptions), { name: 'JqError', message: 'l (longest match) is not supported' });
	});
});

agreeText('jq runtime: numbers keep their spelling', [
	[ '1.000, 1e2, 1E2, 0.10, 100000000000000000000, -1.000, 3.0, 0.0, 1.10e1, 1.5e300, 00, 1e-7, 0.000001' ],
	[ '[1.000], {a: 1.000}, (1.000 | tostring), (1.000 | tojson), ([1.000] | tojson), "\\(1.000)"' ],
	[ '(1.000 + 0), (1.000 * 1), -(1.000), (1.000 | floor), (1.000 == 1), ([1.000, 1] | unique), (1.000 | type)' ],
	[ '("1.000" | tonumber), ("1.000" | fromjson), ("1.000" | tonumber | tostring), ([1,2,3] | .[1.000]), ("x" * 2.000), ([1,2,3] | .[0:2.000]), [range(2.000)]' ],
	[ '1.000 as $x | $x, ([1.000] | .[0]), ({} | .a = 1.000), ([1.000] | sort), (1.000 | if . then "t" else "f" end), (1.000 | . as [$a] ?// $a | $a)' ],
	[ '., .[0], (.[0] | tojson), map(. + 0)', '[1.10, 12345678901234567890, 1E2, 1.0]' ],
	[ '(.b | tojson), keys, to_entries', '{"b": 1E2, "a": 1.0}' ],
	[ '.[] | select(. > 1.5)', '[1.10, 2.50, 3]' ],
	[ 'to_entries, (.a |= . * 2), del(.b)', '{"a": 1.50, "b": 2.0}' ],
	// The hand-rolled parser: escapes, -0, duplicate keys, and rejected texts
	[ '.', '"a\\u00e9\\n\\t\\"\\\\\\/\\ud83d\\ude00b"' ],
	[ '.', '-0' ],
	[ 'tojson', '{"a": 1, "a": 2.000}' ],
	[ '.[] | try fromjson catch "E"', '["1 2","[1,","[1,]","{\\"a\\":1,}","{a:1}","{\\"a\\"}","\\"\\\\z\\"","\\"\\\\u12\\""," 7 ","[]","{}","1E5","-0","01","00","-01","007","01.5","00.5",".5","5.","1.","+1","+.5","-.5","1.e2",".5e1","5.e3","1e05","1e1000","-1e1000","nan","NaN","NAN","-nan","+nan","inf","INF","-inf","+inf","infinity","iNfInItY","-Infinity","nanx","infx","infinit","nan(12)",".","-","+","-.",".e2","1e","1e+","0x10","tru","nul"]' ],
	[ '., . == .', 'nan' ],
	[ '.', '01.500' ],
	[ '.', '-Infinity' ],
], jqOptions, jqFromjson);

describe('cli', () => {
	const cli = (args: readonly string[], input = '', bin = 'jsjq') => {
		const result = spawnSync(process.execPath, [ path.join(import.meta.dirname, '..', 'bin', `${bin}.js`), ...args ], { input, encoding: 'utf8' });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
	it('runs a filter over each input', () => {
		assert.deepEqual(cli([ '-c', '.a + 1' ], '{"a":1} {"a":2}'), { status: 0, stdout: '2\n3\n', stderr: '' });
	});
	it('binds --arg and --argjson', () => {
		assert.deepEqual(cli([ '-n', '-r', '--arg', 'who', 'world', '--argjson', 'n', '[1,2]', '"hello \\($who) \\($n | length)"' ]), { status: 0, stdout: 'hello world 2\n', stderr: '' });
	});
	it('slurps, reads raw lines, and pretty prints', () => {
		assert.equal(cli([ '-s', '-c', 'add' ], '1 2 3').stdout, '6\n');
		assert.equal(cli([ '-R', '-c', '.' ], 'a\nb\n').stdout, '"a"\n"b"\n');
		assert.equal(cli([ '-n', '-c', '[inputs]' ], '1 2 3').stdout, '[1,2,3]\n');
		assert.equal(cli([ '-S', '--tab', '.' ], '{"b":1,"a":[1]}').stdout, '{\n\t"a": [\n\t\t1\n\t],\n\t"b": 1\n}\n');
		assert.equal(cli([ '-j', '.[]' ], '["a","b"]').stdout, 'ab');
		assert.equal(cli([ '-c', '., (. + 0)' ], '1.000').stdout, '1.000\n1\n');
		assert.equal(cli([ '--runtime', 'js', '-c', '.' ], '1.000').stdout, '1\n');
	});
	it('exits as jq does', () => {
		assert.equal(cli([ '-n', '1 +' ]).status, 3);
		assert.equal(cli([ '-n', 'error("boom")' ]).status, 5);
		assert.equal(cli([ '-n', 'error("boom")' ]).stderr, 'jsjq: error: boom\n');
		assert.deepEqual(cli([ '-n', '"bye" | halt_error(3)' ]), { status: 3, stdout: '', stderr: 'bye' });
		assert.equal(cli([ '-n', '-e', 'null' ]).status, 1);
		assert.equal(cli([ '-n', '-e', 'empty' ]).status, 4);
		assert.equal(cli([ '-n', '-e', '1' ]).status, 0);
	});
});
