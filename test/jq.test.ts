/** The jq runtime — jq's numbers, jq's order, jq's regex flags — and the `jsjq` binary. */
import type { Value } from '#/index.js';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { differential } from './harness.js';
import { lib as jqLib } from '#/runtime/jq/index.js';
import { runtime as jqRuntime } from '#/runtime/jq/runtime.js';
import { fromjson as jqFromjson } from '#/runtime/jq/value.js';

const { agree, agreeText, divergent, run } = differential({ runtime: jqRuntime, lib: jqLib }, jqFromjson);

agree('jq runtime: jq\'s order', [
	[ '([] < {}), (null < false), (true < 0), (1 < "a"), ({} > []), ([1] < [1, 0])' ],
	[ '[1, "a", null, true, [], {}] | sort' ],
	[ 'sort', [ { b: 1 }, { a: 2 }, { a: 1, b: 0 }, { a: 1 } ] ],
	[ 'sort', [ [ 1, 2 ], [ 1 ], [ 0, 5 ], [] ] ],
	[ 'unique, group_by(type)', [ 1, [ 1 ], { a: 1 }, '1', null, 1, true ] ],
	[ 'sort_by(.a)', [ { a: [ 1 ] }, { a: 'x' }, { a: null }, { a: {} } ] ],
]);

agree('jq runtime: trims strip C\'s whitespace', [
	[ '"\\u0085x\\u0085y\\u0085" | [ltrim, rtrim, trim]' ],
	[ '" \\u00a0x\\u3000 " | trim' ],
]);

agree('jq runtime: abs through the runtime\'s negate', [
	[ '-1E+1000 | abs | tojson' ],
	[ '"x" | abs' ],
	[ 'try (null | abs) catch .' ],
	[ '[nan | abs | isnan]' ],
]);

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
]);

describe('jq runtime: what JavaScript cannot match', () => {
	it('refuses the longest-match flag', () => {
		assert.throws(() => run('match("a|aa"; "l")', 'aaa'), { name: 'JqError', message: 'l (longest match) is not supported' });
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
	// The prelude's definitions run under jq's numbers and order
	[ 'map_values(.), (.a | abs)', '{"a": -1.500}' ],
	[ 'min, max, min_by(.), max_by(.)', '[3.00, 1.000, 2.0]' ],
	[ '[.[] | abs]', '[-2.000, 1.10e1]' ],
]);

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
	it('reads concatenated values under jq, and JSON Lines under js', () => {
		assert.deepEqual(cli([ '-c', '.' ], '"foo""bar"'), { status: 0, stdout: '"foo"\n"bar"\n', stderr: '' });
		assert.equal(cli([ '-c', '.' ], '{"a":1}{"a":2}[3]4"x"').stdout, '{"a":1}\n{"a":2}\n[3]\n4\n"x"\n');
		assert.equal(cli([ '--runtime', 'js', '-c', '.a' ], '{"a":1}\n\n{"a":2}').stdout, '1\n2\n');
		assert.equal(cli([ '--runtime', 'js', '.' ], '"foo""bar"').status, 5);
	});
	it('yields each output before the input ends', async () => {
		const child = spawn(process.execPath, [ path.join(import.meta.dirname, '..', 'bin', 'jsjq.js'), '-c', '.' ], { stdio: [ 'pipe', 'pipe', 'inherit' ] });
		const readOut = () => new Promise<string>(resolve => {
			child.stdout.once('data', chunk => resolve(String(chunk)));
		});
		child.stdin.write('"first"');
		assert.equal(await readOut(), '"first"\n');
		child.stdin.write('{"half":');
		child.stdin.write('1}');
		assert.equal(await readOut(), '{"half":1}\n');
		child.stdin.end();
		await new Promise(resolve => {
			child.once('close', resolve);
		});
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

agree('the extended mathematics', [
	[ '[.[] | nearbyint, rint]', [ -1.7, 2.5, 3.5, -1.5, -2.5, 2.3 ] ],
	[ '[.[] | exp2, exp10]', [ 0, 1, 2, 3, 0.1 ] ],
	[ '[.[] | frexp, modf, significand, logb]', [ 7, 1, 48, 3.25, -3.25, 0.1 ] ],
	[ '0 | logb' ],
	[ '[drem(7; 3), drem(5; 2), remainder(5; 2), remainder(7.5; 2)]' ],
	[ '[ldexp(3; 4), scalb(3; 4), scalbln(3; 4), ldexp(1; -3)]' ],
	[ '[fdim(5; 3), fdim(3; 5), fmod(7; 3), fmod(-7; 3), fma(2; 3; 4)]' ],
	[ '[copysign(3; -1), copysign(-3; 1), nextafter(1; 2), nexttoward(1; 0)]' ],
	[ '[fmax(nan; 1), fmin(1; nan), fmax(1; 2), fmin(1; 2)]' ],
	[ '[.[] | tgamma]', [ 7, 3 ] ],
	[ '[.[] | gamma, lgamma]', [ 1, 3, 4 ] ],
	[ '3 | lgamma_r' ],
]);

divergent('a ulp astray from this libm, or refused outright', [
	[ '[0.5, -0.5] | map(tgamma)', null, [ [ 1.7724538509055159, -3.5449077018110295 ] ] ],
	[ '-0.5 | nearbyint', null, [ 0 ] ],
	[ '1 | j0', null, 'error' ],
	[ '1 | erf', null, 'error' ],
	[ 'jn(2; 1)', null, 'error' ],
]);

describe('the jq builtins surface', () => {
	it('carries the extended tail', () => {
		const [ names ] = run('builtins', null) as [ Value[] ];
		assert.ok(names.includes('ldexp/2'));
		assert.ok(names.includes('tgamma/0'));
		assert.ok(names.includes('j0/0'));
	});
});

agree('the C time dialect', [
	[ 'gmtime', 1425599507 ],
	[ 'gmtime', 1425599507.123 ],
	[ 'gmtime | mktime', 1425599507 ],
	[ '[2015, 2, 5, 23, 51, 47, 4, 63] | [mktime, strftime("%Y-%m-%dT%H:%M:%SZ")]' ],
	[ '[2015, 2, 5, 23, 51, 47.5] | mktime' ],
	[ '[2015, 2] | mktime' ],
	[ '"x" | mktime' ],
	[ '[2015, 2, 5, 23, 51, 47, 4, 63] | strftime("%Y %j %a %A %b %B %e %u %w %p %I %C %y %%")' ],
	[ '[2015, 2, 5, 23, 51, 47, 4, 63] | strftime("%F %T | %D %R | %d %H %M %S %m")' ],
	[ '1425599507 | strftime("%Y-%m-%d")' ],
	[ '"2015-03-05T23:51:47Z" | strptime("%Y-%m-%dT%H:%M:%SZ")' ],
	[ '"05/03/15" | strptime("%d/%m/%y")' ],
	[ '"5 Mar 2015" | strptime("%d %b %Y")' ],
	[ '"x" | strptime("%Y")' ],
	[ '1425599507 | [todate, todateiso8601]' ],
	[ '"2015-03-05T23:51:47Z" | [fromdate, fromdateiso8601]' ],
]);
