/**
 * Differential tests: every case runs through both this compiler and the `jq` binary, and the
 * outputs must agree as JSON values. A case where both raise an error passes without comparing
 * the messages. `divergent` holds the cases where this implementation is meant to differ.
 */
import type { Lib, Value } from './index.js';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { tojson } from './lib/value.js';
import { compile, constant, lib, run, values } from './index.js';

type Case = readonly [ filter: string, input?: Value, inputs?: readonly Value[] ];

function jq(filter: string, input: Value, inputs: readonly Value[] = []): Value[] | 'error' {
	try {
		const text = execFileSync('jq', [ '-c', filter ], {
			input: [ input, ...inputs ].map(value => JSON.stringify(value)).join('\n'),
			stdio: [ 'pipe', 'pipe', 'pipe' ],
		}).toString();
		return text.trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Value);
	} catch {
		return 'error';
	}
}

/** Runs as the command line does: once per input, the rest being what `input` reads. */
function ours(filter: string, input: Value, inputs: readonly Value[] = []): Value[] | 'error' {
	const iterator = [ input, ...inputs ][Symbol.iterator]();
	const shared = { [Symbol.iterator]: () => iterator };
	try {
		const compiled = compile(filter, { inputs: shared, debug: () => {} });
		const outputs: Value[] = [];
		for (const value of shared) {
			outputs.push(...compiled.stream ? compiled(value) : [ compiled(value) ]);
		}
		// Through JSON, since that is how jq's output reaches us: NaN and infinities have no other form
		return outputs.map(output => JSON.parse(tojson(output)) as Value);
	} catch {
		return 'error';
	}
}

/** Cases where this implementation deliberately differs from jq 1.8. */
function divergent(name: string, cases: readonly (readonly [ filter: string, input: Value, expected: Value[] | 'error' ])[]): void {
	void describe(name, () => {
		for (const [ filter, input, expected ] of cases) {
			void it(filter, () => {
				assert.deepEqual(ours(filter, input), expected);
			});
		}
	});
}

function agree(name: string, cases: readonly Case[]): void {
	void describe(name, () => {
		for (const [ filter, input = null, inputs = [] ] of cases) {
			void it(filter, () => {
				const expected = jq(filter, input, inputs);
				const actual = ours(filter, input, inputs);
				if (expected === 'error') {
					assert.equal(actual, 'error', `jq raised an error but we produced ${JSON.stringify(actual)}`);
				} else {
					assert.deepEqual(actual, expected);
				}
			});
		}
	});
}

agree('paths and literals', [
	[ '.', { a: 1 } ],
	[ '.a', { a: 1 } ],
	[ '.a.b', { a: { b: 2 } } ],
	[ '.a.b.c', { a: null } ],
	[ '.a.b.c', {} ],
	[ '.a.b', { a: 1 } ],
	[ '.a[0].b', { a: [ { b: 9 } ] } ],
	[ '.["a"]', { a: 1 } ],
	[ '."a"', { a: 1 } ],
	[ '.a."b"', { a: { b: 2 } } ],
	[ '.a.[0]', { a: [ 1 ] } ],
	[ '.a[]', { a: [ 1, 2 ] } ],
	[ '.[1.7], .[-1], .[-1.5], .[3], .[1e10]', [ 1, 2, 3, 2 ] ],
	[ '.[null:2], .[1.5:2.5], .[-10:10], .[1:]', [ 1, 2, 3, 2 ] ],
	[ '.[1:], .[:-1], .[5:]', 'abcd' ],
	[ '.a, .[0], .[1:2], .["a"]', null ],
	[ '.["a","b"]', { a: 1, b: 2 } ],
	[ '.[(0,1)]', [ 5, 6 ] ],
	[ '(.,.)[0]', [ 1 ] ],
	[ '.if, .end', { if: 1, end: 2 } ],
	[ '.xx .yy', { xx: { yy: 7 } } ],
	[ '1, 1.5, "a", true, null, [], {}' ],
	[ '.5' ],
	[ '"\\u00e9\\n\\t\\"\\\\\\/"' ],
	[ '$__loc__' ],
	[ '.[]', 1 ],
	[ '.[0]', {} ],
	[ '.["a"]', [ 1 ] ],
	[ '.[0]', 'abc' ],
	[ '.[1:2]', 1 ],
	[ '..a', {} ],
	[ '1 == 1 == true' ],
]);

agree('operators', [
	[ '(1,2) + (10,20)' ],
	[ '1 + 2 * 3 - 4 / 2 % 3' ],
	[ '-1 + 2, -(1,2) * 3, 1 - -1' ],
	[ '[-.[]]', [ 1, 2 ] ],
	[ '-"a"' ],
	[ 'null + null, [1,2,3] - [2,4], "a,b,c" / ",", "" / ",", "abc" / "", 4 / 2' ],
	[ '{"a":1} + {"b":2}, {"a":{"b":1}} * {"a":{"c":2}}, "ab" * 2, 7 % 3, 7 / 2' ],
	[ '"ab" * 0, "ab" * 0.5, "ab" * -1, "ab" * 2.7, 7 % -3, -7 % 3, 5.7 % 2.2' ],
	[ '5 % 0' ],
	[ '1 / 0' ],
	[ '[] - 1' ],
	[ '{} + []' ],
	[ '{a:1,b:2} == {b:2,a:1}, 1 == 1.0, [1] == [1], ("a" < "b"), ([] < {}), (null < false), (false < true), (true < 0)' ],
	[ '[1, "a", null, true, [], {}] | sort' ],
	[ 'sort', [ { b: 1 }, { a: 2 }, { a: 1, b: 0 }, { a: 1 } ] ],
	[ 'sort', [ [ 1, 2 ], [ 1 ], [ 0, 5 ], [] ] ],
	[ 'sort', [ 'b', 'a', 'é', '😀', 'B', '' ] ],
	[ '[.[] | not]', [ true, false, null, 0, '' ] ],
	[ '[(true, false) and (true, false)]' ],
	[ '[(true, false) or (true, false)]' ],
	[ 'true and (1,null)' ],
	[ '[false and error("x")], [true or error("x")]' ],
	[ '[(1, null, 2) // 3], [(null, false) // 3], [empty // 3], [error("x") // 3]' ],
	[ '[(1, error("x")) // 3]' ],
	[ '[false // false], [null // null]' ],
	[ '[(1,2) // (3,4)], [(null) // (3,4)]' ],
	[ 'null // 3 | . + 1' ],
	[ '1 // 2 + 3' ],
	[ '1 + 2 // 3' ],
	[ '.a? // "d"', 1 ],
	[ '(.a | error) // "d"', { a: 'm' } ],
	[ '"a\\(1,2)b\\(3,4)"' ],
	[ '"\\(.a) and \\(.b)"', { a: 1, b: [ 2 ] } ],
	[ '"x\\("y\\("z")")"' ],
]);

agree('construction', [
	[ '[.[] | . + 1]', [ 1, 2, 3 ] ],
	[ '[]' ],
	[ '{a: .b, c: 1}', { b: 5 } ],
	[ '{a: (1,2), b: (3,4)}' ],
	[ '{(("x","y")): (1,2)}' ],
	[ '{"a": (1,2)}' ],
	[ '{(.[]): 1}', [ 'a', 'b' ] ],
	[ '{"a", "b"}', { a: 1, b: 2 } ],
	[ '{$__loc__}' ],
	[ '{a: .b?}', { b: 1 } ],
	[ '{a: -1}, {a: 1 | . + 1}, {a: try 1}, {a: if . then 1 else 2 end}', true ],
	[ '{a: reduce .[] as $x (0; .+$x)}', [ 1, 2 ] ],
	[ '{a: .b.c[0]?, b: .x[]}', { b: { c: [ 9 ] }, x: [ 1, 2 ] } ],
	[ '{"a"}', { a: 1 } ],
	[ '{a: 1}.a' ],
	[ '{a: 1, a: 2}' ],
	[ '{if: 1, then: 2}' ],
	[ '{(1): 2}' ],
	[ '{"\\(.k)": 1}', { k: 'z' } ],
	[ '{"\\(.k)"}', { k: 'z', z: 5 } ],
	[ '.a as $x | {$x, y: 2, "z": 3, ("w"): 4, "i\\($x)": 6, a}', { a: 1 } ],
	[ '"a" as $k | {$k: 1}' ],
	[ '[1,2][0]', null ],
	[ '"abc"[1:]' ],
	[ '{"__proto__": 1} | .__proto__, keys, ({"__proto__": 2} + .), tojson' ],
	[ '{__proto__: 1}.__proto__' ],
	[ '.constructor, .toString', {} ],
]);

agree('control flow', [
	[ 'if . then "t" elif . == null then "n" else "f" end', false ],
	[ '[if (true,false) then 1 else 2 end]' ],
	[ 'if true then 1 end, [.[] | if . then "y" end]', [ true, false ] ],
	[ 'if (true,false) then (1,2) else (3,4) end' ],
	[ 'if . then 1 else 2 end | . + 1', true ],
	[ 'if . then 1 else 2 end + 1', true ],
	[ '[try 1 + error("x")]' ],
	[ '[try error("x") catch 2, 3]' ],
	[ '[1?, (1,error("x"))?]' ],
	[ 'try error("x") catch .' ],
	[ '[.[] | try error catch .]', [ 1, 'a', { a: 1 }, null ] ],
	[ 'error(null)' ],
	[ 'error' ],
	[ '[try (1,2,error("x"),3) catch "c"], [try (1, error("x"), 2)], [(1, error("x"))?]' ],
	[ 'try (1,2) catch "c" | error("y")' ],
	[ '[.[] | try (if . == 2 then error("e") else . end) catch "c"]', [ 1, 2, 3 ] ],
	[ 'try error("\\(1)") catch (. | ascii_upcase)' ],
	[ '(try error("x") catch .) | length' ],
	[ 'try error("x") catch . + "y"' ],
	[ 'try error("x") catch . | ascii_upcase' ],
	[ 'try 1 catch 2 + 1' ],
	[ '.a[]?', { a: 1 } ],
	[ '[.[] | tonumber?]', [ '1', 'x', '2' ] ],
	[ '[.[] | .a?]', [ [ 1 ], { a: 2 }, 's', null, 3 ] ],
	[ '[.[]?]', 5 ],
	[ '.a?.b, .a?[0], ..?', { a: null } ],
	[ '[.[] | (1 / .)?]', [ 0, 1 ] ],
	[ '[.[]|(.a,.b)?]', [ { a: 1, b: 2 }, 1 ] ],
	[ 'try error("x") catch error("y")' ],
	[ '[.[] | select(. > 1)]', [ 1, 2, 3 ] ],
	[ '[.[] | select(.a)?]', [ 1, { a: true } ] ],
	[ 'label $out | 1, 2, break $out, 3' ],
	[ '[label $f | range(10) | ., (select(. == 3) | break $f)]' ],
	[ 'break $x' ],
	[ '[try (label $out | break $out) catch "caught"]' ],
	[ 'label $x | 1, break $x | . + 1' ],
	[ 'label $a | label $b | 1, break $a, 2' ],
	[ '[label $a | (label $b | 1, break $b, 2), 3]' ],
	[ 'def f(g): label $out | g; [f(1, break $out, 2)]' ],
	[ 'label $out | def f: 1, break $out, 2; [f]' ],
]);

agree('generators', [
	[ '[range(5)], [range(0;10;3)], [range(5;0;-2)], [range(2.5)], [range(-1)], [range(1;3;0.5)]' ],
	[ '[range(0;3;-1)], [range(3;0;-1)], [limit(3; range(0;1;0))]' ],
	[ 'range("a")' ],
	[ 'range(1;null)' ],
	[ '[limit(3; range(10))], [limit(1; 1, error("x"))], first(1, error("x")), [first(range(10;0;-1))]' ],
	[ '[limit(0; error("x"))], [limit(1.5; 1,2,3)], [limit(0.5; 1,2,3)]' ],
	[ '[limit(-1; 1,2)]' ],
	[ 'isempty(empty), isempty(1, error("x"))' ],
	[ '[first, last], ([] | first, last)', [ 7, 8, 9 ] ],
	[ 'nth(-1; 1)' ],
	[ '[skip(-1; 1,2,3)]' ],
	[ 'first(empty), [first(1,2)]' ],
	[ 'until(. > 10; . * 2), [while(. < 10; . * 2)]', 1 ],
	[ '[recurse(if . < 3 then . + 1 else empty end)]', 1 ],
	[ '[..]', { a: [ { b: 1 } ] } ],
	[ '[.. | select(type == "number")]', { a: [ { b: 1 } ] } ],
	[ '[recurse(.a?)]', { a: { a: 1 } } ],
	[ '[recurse(.[]?, .[]?)]', [ [ 1 ] ] ],
	[ '.. == 1', [ 1 ] ],
	[ 'reduce range(3) as $x (0; empty)' ],
	[ '[reduce range(3) as $x ((0,10); .+$x)]' ],
	[ 'reduce range(3) as $x (0; ., 100)' ],
	[ 'reduce empty as $x (1; 2)' ],
	[ '[reduce (1,2) as $x (empty; 2)]' ],
	[ '[foreach range(3) as $x (0; (.+$x, .-$x))]' ],
	[ '[foreach range(3) as $x (0; empty; .)]' ],
	[ '[foreach (1,2) as $x ((0,10); . + $x)]' ],
	[ '[foreach (1,2) as $x (0; . + $x; (., .))]' ],
	[ '[limit(2; foreach range(10) as $x (0; . + $x))]' ],
	[ 'reduce .[] as [$a,$b] (0; . + $a * $b)', [ [ 1, 2 ], [ 3, 4 ] ] ],
	[ '[foreach .[] as $x (0; . + $x; [$x, .])]', [ 1, 2, 3 ] ],
	[ 'reduce .[] as $x (0; . + $x) | . + 1', [ 1, 2 ] ],
	[ 'reduce .[] as $x (0; . + $x) + 1', [ 1, 2 ] ],
	[ 'reduce .[] as $x (0; . + $x) as $s | $s', [ 1, 2 ] ],
	[ '[.[] | (., . * 2)]', [ 1, 2 ] ],
	[ '[(1,2) | (., . * 10) | (., . + 100)]' ],
	[ '[(1,2), (3,4) | (., . * 10) | (., . + 100) | (., . + 1000) | tostring | ascii_downcase | ltrimstr("x") | ascii_upcase]' ],
]);

agree('variables and functions', [
	[ '1 as $x | 2 as $x | $x' ],
	[ '1 as $x | 2 as $y | [$x, $y, .]', 0 ],
	[ '[.[] as [$a, $b] | {a: $a, b: $b}]', [ [ 1, 2 ], [ 3 ] ] ],
	[ '. as {a: $x, $b} | [$x, $b]', { a: 1, b: 2 } ],
	[ '. as {$a: [$b]} | [$a,$b]', { a: [ 5 ] } ],
	[ '. as {("a","b"): $x} | $x', { a: 1, b: 2 } ],
	[ '. as {"a": $x} | $x', { a: 1 } ],
	[ '. as [$a] | $a', { a: 1 } ],
	[ '.[] as [$a] ?// $a | $a', [ [ 1 ], 2 ] ],
	[ '[.[] as [$a] ?// $a | if ($a|type)=="number" then $a else error("e") end]', [ [ 1 ], 2 ] ],
	[ '[.[] as [$a] ?// [$b] | [$a, $b]]', [ [ 1 ] ] ],
	[ '[.[] as [$a] ?// $a | error("e")]', [ [ 1 ] ] ],
	[ '. as [$a] ?// $a | [$a]', 1 ],
	[ '[. as $x | $x, 1]', 5 ],
	[ '[.[] as $x | $x | . + 1, 2]', [ 10 ] ],
	[ '. as $x | . as $y | $x + $y', 1 ],
	[ '$x' ],
	[ '"abc" as $x | $x[1:]' ],
	[ 'def f: def g: 3; g; f' ],
	[ 'def f($x; $y): [$x,$y]; [f(1,2; 3,4)]' ],
	[ 'def f(x): [x]; f(1,2)' ],
	[ 'def f($x): $x; [f(1,2)]' ],
	[ 'def f: 1; def f: 2; f' ],
	[ 'def f: 1; def f(x): x; [f, f(2)]' ],
	[ 'def f(f): f; f(3)' ],
	[ 'def f: def g: f; if . > 0 then . - 1 | g else . end; 3 | f' ],
	[ 'def r: if . < 3 then . + 1 | r else . end; 0 | r' ],
	[ 'def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; fac', 5 ],
	[ 'def f(g): def h: g; h; f(. + 1)', 1 ],
	[ 'def f(g): 5 | g; . as $x | f($x + .)', 10 ],
	[ 'def f(g): [g, g]; f(1,2)' ],
	[ 'def f(g): g | g; f(. + 1)', 1 ],
	[ 'def f: reduce .[] as $x (0; . + $x); f', [ 1, 2 ] ],
	[ 'def f: 1;', 9 ],
	[ 'def f: 1; f | . + 1' ],
	[ 'def f: 1; f + 1' ],
	[ '(def f: 1; f) + 1' ],
	[ '1 as $x | def f: $x; 2 as $x | f' ],
	[ 'def f(x): x; def g: f(.); g', 3 ],
	[ 'def f($x): $x | def g: $x; g; f(1)' ],
	[ 'def f(g): def f: 3; g + f; f(1)' ],
	[ 'def f: 1; def g: f; def f: 2; g' ],
	[ 'def f($a; $a): $a; f(1;2)' ],
	[ 'def f(a; $a): a; f(1;2)' ],
	[ 'def f($x): x; f(1)' ],
	[ 'def f(x): $x; f(1)' ],
	[ 'def f(a): a; f(1; 2)' ],
	[ 'f' ],
	[ 'def f(g): if . > 3 then . else (. + 1 | f(g)) end; f(.)', 0 ],
	[ 'def f(g): g, (if . < 3 then . + 1 | f(g) else empty end); [f(. * 10)]', 0 ],
	[ 'def f($n; g): if $n == 0 then g else (f($n - 1; g) | . + 1) end; f(3; .)', 0 ],
	[ 'def f(g): [path(g)], (if .a then .a | f(g) else empty end); f(.b, .c)', { a: { a: 1, b: 2 }, b: 1 } ],
	[ '[.[] | def f: . * 2; f]', [ 1, 2 ] ],
	[ 'def r: if . > 0 then (. - 1 | r), . else . end; [3 | r]' ],
	[ 'def cnt: if . >= 1000 then . else . + 1 | cnt end; 0 | cnt' ],
	[ 'until(. >= 100000; . + 1)', 0 ],
]);

agree('assignment and paths', [
	[ 'path(.), [paths], path(..)', { a: [ 1, { b: 2 } ] } ],
	[ 'path(.a[].b)', { a: [ { b: 1 }, { b: 2 } ] } ],
	[ 'path(.a // .b)', { b: 1 } ],
	[ 'path(first(.a,.b)), path(.a | select(. == 1)), path(.a as $x | .b)', { a: 1 } ],
	[ 'path(1)' ],
	[ 'path(.a | 1)', { a: 1 } ],
	[ 'path(getpath(["x","y"]))', { x: null } ],
	[ 'path(.[1:3]), path(.a?), path(.[]?), path(empty)', 1 ],
	[ 'path(if .a then .b else .c end), path(.a?), path(.a.b?)', null ],
	[ 'path(.. | select(type=="number"))', [ 1, [ 2 ] ] ],
	[ 'path(limit(2; .[]))', [ 1, 2, 3 ] ],
	[ 'path(.a[1:2])', { a: [ 1, 2, 3 ] } ],
	[ 'path(label $x | .a, break $x, .b)', {} ],
	[ '[paths]', [ [ 1 ] ] ],
	[ '.a |= . + 1', { a: 1 } ],
	[ '.[] |= empty', [ 1, 2, 3, 4, 5 ] ],
	[ '.[] |= empty', { a: 1, b: 2 } ],
	[ '(.[] | select(. == 2)) |= empty', [ 1, 2, 3 ] ],
	[ '.a |= empty', { a: 1, b: 2 } ],
	[ '.a |= (1,2)', { a: 0 } ],
	[ '.a += (1,2)', { a: 0 } ],
	[ '.a = (.b, .c)', { a: 0, b: 1, c: 2 } ],
	[ '.[] += 1', { a: 1 } ],
	[ '.a.b.c = 1' ],
	[ '.[2] = 1', [] ],
	[ '.[-1] = 9', [ 1, 2 ] ],
	[ '.[-5] = 1', [ 1 ] ],
	[ '.[1:2] = ["x","y"]', [ 1, 2, 3 ] ],
	[ '.[1:2] |= map(.+1)', [ 1, 2, 3 ] ],
	[ '.[1:] = "x"', [ 1, 2 ] ],
	[ '.a //= 3', { a: null } ],
	[ '(.a,.b) |= .+1', { a: 1, b: 2 } ],
	[ '(.a, .a) |= . + 1', { a: 1 } ],
	[ '.a += .a', { a: 1 } ],
	[ '. |= 2' ],
	[ 'getpath(["a","b"]) = 1' ],
	[ '.a[] |= .+1', { a: [ 1, 2 ] } ],
	[ '.[] = 1', [ 0, 0 ] ],
	[ '.. |= (if type == "number" then . + 1 else . end)', [ 1, [ 2 ] ] ],
	[ '[range(3)] | .[1:] |= map(. * 10)' ],
	[ '.[] |= . + 1', Array.from({ length: 2000 }, (_value, ii) => ii) ],
	[ 'del(.a, .b), del(.[])', { a: 1, b: 2, c: 3 } ],
	[ 'del(.[1], .[0])', [ 1, 2, 3 ] ],
	[ 'del(.[0,2]), del(.[] | select(. == 2))', [ 0, 1, 2, 3 ] ],
	[ 'del(.[2:4]), del(.[0], .[2:4])', [ 0, 1, 2, 3, 4, 5 ] ],
	[ 'del(.a), del(.[0])', null ],
	[ 'delpaths([[0],[1]])', [ 1, 2, 3 ] ],
	[ 'delpaths([[5]]), delpaths([]), delpaths([[]])', [ 1 ] ],
	[ 'delpaths([["a"]])', [ 1 ] ],
	[ 'delpaths(1)', 1 ],
	[ 'getpath(["a","b"]), getpath(["a","b","c"])', { a: { b: null } } ],
	[ 'getpath(["a","b"])', { a: 1 } ],
	[ 'getpath([]), getpath(1)', 1 ],
	[ 'setpath([]; 1), setpath(["a",1]; 1), setpath([1.5]; 1)', null ],
	[ 'setpath(["a","b"]; 1)', { a: [] } ],
	[ 'setpath([0]; 1)', {} ],
	[ 'to_entries, from_entries', { b: 1, a: 2 } ],
	[ 'to_entries', [ 1 ] ],
	[ 'from_entries', [ { name: 'a', value: 1 }, { k: 'b', v: 2 }, { Key: 'c', Value: 3 }, { key: 4 }, { key: true, value: 5 } ] ],
	[ 'from_entries', [ { key: null, value: 5 } ] ],
	[ 'from_entries', [ [ 1 ] ] ],
	[ 'with_entries(.value += 1)', { b: 1, a: 2 } ],
	[ 'with_entries(empty), with_entries(.key |= ascii_upcase)', { a: 1 } ],
	[ 'walk(if type == "number" then . + 1 else . end), walk(if type == "object" then del(.a) else . end)', { b: [ 1, { a: 2 } ], a: 1 } ],
	[ 'getpath(["a"]) |= 1', {} ],
	[ 'to_entries[0] | .key', { a: 1 } ],
	[ 'if . then 1 else 2 end.a', { a: 1 } ],
	[ 'path(.a | .b?)', { a: 1 } ],
	[ 'path(try .a catch .b)', null ],
	[ '[path(.a, .b | .c)]', {} ],
	[ 'path(reduce .[] as $x (.; .[$x]))', [ 0, 1 ] ],
]);

agree('builtins', [
	[ '[.[] | length]', [ null, -5, 'héllo', { a: 1 }, [ 1, 2 ] ] ],
	[ 'true | length' ],
	[ 'keys, length', [ 3, 1 ] ],
	[ 'keys', 'a' ],
	[ 'has("a"), has("z")', { a: 1 } ],
	[ 'has(0), has(5)', [ 1 ] ],
	[ 'has("a")', [ 1 ] ],
	[ 'contains("x")', { a: [ 1, 2 ] } ],
	[ 'contains("a")', 1 ],
	[ '[.[] | type]', [ null, true, 1, 'a', [], {} ] ],
	[ '[.[] | tostring]', [ 1, '1', null, true, [ 1 ], { a: 'b' } ] ],
	[ '[.[] | try tonumber catch "E"]', [ '1', '1.50', ' 1', '1 ', '+1', '.5', '5.', '1e', '1e3', 'nan', '0x1', '', '1_0', '١' ] ],
	[ 'tonumber', true ],
	[ 'fromjson', '[1, {"a": 2}] ' ],
	[ 'fromjson', '[1,' ],
	[ 'fromjson', '1 2' ],
	[ 'tojson', { a: [ 1, 'x' ] } ],
	[ 'tojson, (" " | tojson), ("😀" | tojson), ("a\\"b\\\\c/d" | tojson)', 'x' ],
	[ '[1,{"a":"b"}] | tojson, tostring' ],
	[ 'add', [ 1, 2, 3 ] ],
	[ 'add', { a: 1, b: 2 } ],
	[ 'add', [ 'a', 'b' ] ],
	[ 'add, any, all, unique', [] ],
	[ 'any, all', [ null, true ] ],
	[ 'any, all', 'a' ],
	[ 'any, all', [] ],
	[ 'flatten', [ [ 1, [ 2 ] ], [ 3 ] ] ],
	[ 'flatten(-1)', [ 1 ] ],
	[ 'flatten', 1 ],
	[ 'sort_by(.a, .b), group_by(.a)', [ { a: 2, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 0 }, { a: 1, b: 3 } ] ],
	[ 'unique', [ 'bb', 'a', 'a', 'cc' ] ],
	[ 'ascii_downcase, ascii_upcase, ltrimstr("h"), rtrimstr("o"), startswith("hé"), endswith("o")', 'héllo' ],
	[ 'startswith(1)', 'abc' ],
	[ 'ltrimstr("ab"), ltrimstr(""), ltrimstr("x")', 'abab' ],
	[ 'ascii_downcase', 1 ],
	[ 'split("b"), split("")', 'abcb' ],
	[ 'join("-"), (["a",null,1,true] | join(",")), ([] | join(","))', [ 1, 2 ] ],
	[ 'join(",")', [ {} ] ],
	[ 'join(",")', 'a' ],
	[ 'test("A";"i"), test("a"; "g")', 'a1ba2ca3' ],
	[ 'test("a"; "q")', 'a' ],
	[ 'test("(")', 'a' ],
	[ 'split("[0-9]"; null), split("b";"g"), sub("a";"X"), gsub("a";"X"), sub("(?<l>[a-z])"; "[\\(.l)]"; "g"), [match("a";"g").offset], (match("(a)(x)?") | [.captures[].string]), [match("";"g") | .offset]', 'a1ba2ca3' ],
	[ '[match("(?<n>\\\\d)(x)?"; "g")]', 'a1b' ],
	[ '[match("\\\\p{L}+"; "g").string]', 'héllo wörld' ],
	[ '[match("(a)|(b)";"g") | .captures | map(.string)]', 'ab' ],
	[ 'sub("a";"b";"gi"), gsub("A";"b"), sub("";"-"), gsub("";"-"), gsub("^";"-"), gsub("$";"-"), [match("a*";"g") | [.offset,.length]]', 'aAa' ],
	[ 'gsub("\\\\s+";" "), gsub("\\\\d"; "\\(.)")', 'a  b 1' ],
	[ 'test("a.b"), test("A";"i")', 'a\nb' ],
	[ 'sub("(?<a>.)"; .a + "|")', 'xy' ],
	[ '[sub("a"; ("1","2"))], [gsub("a"; ("1","2"))], [sub("a"; "\\(1,2)")]', 'aa' ],
	[ '[.[] | gsub("(?<x>a)|(?<y>b)"; "<\\(.x)\\(.y)>")]', [ 'ab' ] ],
	[ 'gsub("\\\\b"; "|"), gsub("(?=a)"; "|")', 'ab aa' ],
	[ 'splits("a")', 1 ],
	[ 'sub("a";"b")', [ 'a' ] ],
	[ 'sub("a"; 1)', 'a' ],
	[ 'split(""; null), [match(""; "g")] | length', 'ab' ],
	[ '@json, @text', [ 1, 'a"b\tc\\d\n<&>\'', null, true, 1.5 ] ],
	[ '@csv', 1 ],
	[ '@csv', [ [ 1 ] ] ],
	[ '@base64, (@base64 | @base64d)', 'a b&c=d/é~!*()' ],
	[ '@text "a\\(1)", @base64 "x\\(.)y", @json "v=\\(.)"', { a: 1, b: [ 2 ] } ],
	[ '@foo', 1 ],
	[ 'tostring', ' ' ],
	[ '"a\\u0001" | tojson' ],
	[ 'map(. * 2), map(select(. > 1))', [ 1, 2, 3 ] ],
	[ 'map(.+1)', { a: 1 } ],
	[ 'map(.+1)', 1 ],
	[ 'to_entries', 1 ],
	[ '$ENV | type, ($ENV.PATH | type), ($ENV.__nonexistent__)' ],
	[ 'floor, sqrt, pow(.;2)', 5.5 ],
	[ 'getpath(["a"]) as $x | $x', { a: 1 } ],
	[ 'splits' ],
	[ 'error(1;2)' ],
	[ 'tojson(1)' ],
	[ 'ltrimstr("a";"b")', 'a' ],
	[ '[limit(5; inputs)]', 0, [ 1, 2, 3 ] ],
	[ '[., input]', 0, [ 1, 2, 3 ] ],
	[ 'input', 0 ],
	[ 'debug', [ 1 ] ],
	[ 'strftime(1)', 1425599621 ],
	[ 'strftime("%Y")', 'a' ],
	[ 'strptime("%Y-%m-%d"), strptime("%d %B %Y")', '2015-03-05' ],
	[ 'strptime("%Y")', 'abc' ],
	[ 'fromdate', '2015-03-05T23:51:47.5Z' ],
]);

divergent('regular expressions are JavaScript\'s', [
	// Flags are JavaScript's: `s` is dot-all, and Oniguruma's `x`, `n`, `l`, `p` do not exist
	[ 'test("a.b";"s")', 'a\nb', [ true ] ],
	[ 'test("a";"x")', 'a', 'error' ],
	// Offsets and lengths count UTF-16 code units
	[ '[match("😀a"; "g") | .offset, .length]', 'x😀a😀a', [ [ 1, 3, 4, 3 ] ] ],
]);

divergent('strings are UTF-16', [
	// jq counts, slices and sorts by code point; these use JavaScript's code units
	[ 'length, .[0:1], ([., "\uffff"] | sort)', '😀', [ 2, '\ud83d', [ '😀', '\uffff' ] ] ],
]);

divergent('jq 1.8 quirks not followed', [
	// jq 1.8.2's `repeat` yields `f` of the same input forever; the documented definition is kept
	[ '[limit(5; repeat(. * 2))]', 1, [ [ 1, 2, 4, 8, 16 ] ] ],
	[ '[limit(3; repeat(. * 2, . * 3))]', 1, [ [ 1, 2, 4 ] ] ],
]);

void describe('cli', () => {
	const cli = (args: readonly string[], input = '') => {
		const result = spawnSync(process.execPath, [ path.join(import.meta.dirname, 'cli.js'), ...args ], { input, encoding: 'utf8' });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
	void it('runs a filter over each input', () => {
		assert.deepEqual(cli([ '-c', '.a + 1' ], '{"a":1} {"a":2}'), { status: 0, stdout: '2\n3\n', stderr: '' });
	});
	void it('binds --arg and --argjson', () => {
		assert.deepEqual(cli([ '-n', '-r', '--arg', 'who', 'world', '--argjson', 'n', '[1,2]', '"hello \\($who) \\($n | length)"' ]), { status: 0, stdout: 'hello world 2\n', stderr: '' });
	});
	void it('slurps, reads raw lines, and pretty prints', () => {
		assert.equal(cli([ '-s', '-c', 'add' ], '1 2 3').stdout, '6\n');
		assert.equal(cli([ '-R', '-c', '.' ], 'a\nb\n').stdout, '"a"\n"b"\n');
		assert.equal(cli([ '-n', '-c', '[inputs]' ], '1 2 3').stdout, '[1,2,3]\n');
		assert.equal(cli([ '-S', '--tab', '.' ], '{"b":1,"a":[1]}').stdout, '{\n\t"a": [\n\t\t1\n\t],\n\t"b": 1\n}\n');
		assert.equal(cli([ '-j', '.[]' ], '["a","b"]').stdout, 'ab');
	});
	void it('exits as jq does', () => {
		assert.equal(cli([ '-n', '1 +' ]).status, 3);
		assert.equal(cli([ '-n', 'error("boom")' ]).status, 5);
		assert.equal(cli([ '-n', 'error("boom")' ]).stderr, 'jssq: error: boom\n');
		assert.deepEqual(cli([ '-n', '"bye" | halt_error(3)' ]), { status: 3, stdout: '', stderr: 'bye' });
		assert.equal(cli([ '-n', '-e', 'null' ]).status, 1);
		assert.equal(cli([ '-n', '-e', 'empty' ]).status, 4);
		assert.equal(cli([ '-n', '-e', '1' ]).status, 0);
	});
});

void describe('number formatting', () => {
	// JavaScript's shortest round-trip formatting; jq preserves literals and formats doubles its own way
	void it('writes doubles as JSON does', () => {
		assert.deepEqual(run('[.[] | tojson]', [ 1e-7, 1e21, 0.1, 100, 3.14 ]), [ [ '1e-7', '1e+21', '0.1', '100', '3.14' ] ]);
		assert.deepEqual(run('[.[] | tostring]', [ 1.0, 1.5, 1e100 ]), [ [ '1', '1.5', '1e+100' ] ]);
	});
});

void describe('compiled shape', () => {
	void it('is a plain function for a single-valued filter', () => {
		const filter = compile('.a + 1');
		assert.equal(filter.stream, false);
		assert.equal(filter.constructor, Function);
		assert.equal(filter({ a: 1 }), 2);
	});
	void it('is a generator function for a stream', () => {
		const filter = compile('.[]');
		assert.ok(filter.stream);
		assert.equal(filter.constructor.name, 'GeneratorFunction');
		assert.deepEqual([ ...filter([ 1, 2 ]) ], [ 1, 2 ]);
	});
	void it('makes objects without a prototype', () => {
		const filters = [ '{a: 1}', '{}', '{(.a.c | tostring): 1}', '. + {b: 2}', '.a.c = 1', '(.a.c = 1) | .a', 'to_entries[0]', 'del(.a.c) | .a', 'to_entries | from_entries', '{a: 1} * {a: {b: 2}}' ];
		for (const filter of filters) {
			const [ object ] = run(filter, { a: { c: 3 } });
			assert.equal(Object.getPrototypeOf(object), null, filter);
		}
	});
	void it('takes a library of its own', () => {
		const custom: Lib = {
			...lib,
			'double/0': () => (input: Value) => (input as number) * 2,
			'twice/1': (args, render) => {
				const filter = render.generator(args[0]!);
				return function*(input, env) {
					yield* filter(input, env);
					yield* filter(input, env);
				};
			},
			// A function that reads its argument's syntax: a literal is folded at instantiation
			'plus/1': (args, render) => {
				const amount = constant(args[0]!);
				return amount === undefined ? values(render, args, (input, added) => (input as number) + (added as number)) : (input: Value) => (input as number) + (amount as number);
			},
		};
		assert.deepEqual(run('double, twice(. + 1), length, plus(1), plus(. * 2)', 2, { lib: custom }), [ 4, 3, 3, 2, 3, 6 ]);
		assert.throws(() => compile('double', { lib: {} }), { message: 'double/0 is not defined at line 1, column 1' });
		assert.throws(() => compile('length', { lib: {} }), { message: /length\/0 is not defined/ });
	});
	void it('binds named arguments', () => {
		assert.deepEqual(run('$x + $y', null, { args: { x: 1, y: 2 } }), [ 3 ]);
	});
	void it('reports undefined names with a location', () => {
		assert.throws(() => compile('1 | foo'), { message: 'foo/0 is not defined at line 1, column 5' });
		assert.throws(() => compile('$nope'), { message: '$nope is not defined at line 1, column 1' });
		assert.throws(() => compile('1 +'), { message: /Unexpected end of input at line 1, column 4/ });
	});
});
