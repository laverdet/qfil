/**
 * The language both flavors speak: every differential case runs under the js and the jq flavor,
 * each against the `jq` binary — and the machinery every flavor shares: the compiled shape,
 * filters that await, asynchronous inputs, tail calls, `builtins`.
 */
import type { Lib, Value } from '#/index.js';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { differential } from './harness.js';
import { CompileError, JqError, Text, constant, overload, promises, values } from '#/index.js';
import * as jqLib from '#/runtime/jq/index.js';
import * as jqRuntime from '#/runtime/jq/runtime.js';
import { fromjson as jqFromjson } from '#/runtime/jq/value.js';
import * as lib from '#/runtime/js/index.js';
import * as runtime from '#/runtime/js/runtime.js';
import { tojson } from '#/runtime/lang/value.js';

const js = differential({ runtime, lib });
const { compile, run } = js;
const jq = differential({ runtime: jqRuntime, lib: jqLib }, jqFromjson);
const agree: typeof js.agree = (name, cases) => {
	js.agree(`${name} (js)`, cases);
	jq.agree(`${name} (jq)`, cases);
};

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
	[ '"ab" * 0, "ab" * 0.5, "ab" * -1, "ab" * 2.7, 7 % -3, -7 % 3' ],
	[ '[] - 1' ],
	[ '{} + []' ],
	[ '{a:1,b:2} == {b:2,a:1}, 1 == 1.0, [1] == [1], ("a" < "b"), (false < true), (1 < 2), (2 <= 2)' ],
	[ 'sort', [ 'b', 'a', 'é', '😀', 'B', '' ] ],
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
	[ '[1, # one\n 2] # two' ],
	[ '1 # a comment ending in a backslash continues \\\n + 2' ],
	[ '1 # two backslashes do not \\\\\n + 2' ],
	[ '1 # three do \\\\\\\n + 2 \\\n + 3' ],
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
	[ '[.[] | .a?]', [ [ 1 ], { a: 2 }, 's', null, 3 ] ],
	[ '[.[]?]', 5 ],
	[ '.a?.b, .a?[0], ..?', { a: null } ],
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
	[ 'reduce ([1],2) as [$a] ?// $a (0; . + $a)' ],
	[ 'reduce ([1],"x") as [$a] ?// $a (0; . + $a)' ],
	[ '[foreach ([1],2) as [$a] ?// $a (0; . + $a; [$a, .])]' ],
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
	[ 'path(foreach ("a","b") as $k (.; .[$k]) | select(false))' ],
	[ '[path(foreach ("a","b") as $k (.; .[$k]; empty))]' ],
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
	// The harness pipes input without a trailing newline, where the binary too says line 0
	[ 'input_line_number' ],
	[ 'modulemeta', 'x' ],
	// `recurse` is a path expression, as jq's definition makes it
	[ '[path(recurse)]', { a: [ 1 ] } ],
	[ '[path(recurse(.a?))]', { a: { a: 2 } } ],
	// `repeat(exp)` is `exp` of the same input, over and over, until `exp` raises
	[ '[limit(5; repeat(. * 2))]', 1 ],
	[ '[limit(5; repeat(. * 2, . * 3))]', 1 ],
	[ '[repeat(.*2, error)?]', 1 ],
	[ 'try repeat(error("x")) catch .' ],
	[ 'debug', [ 1 ] ],
	[ 'strftime(1)', 1425599621 ],
	[ 'strftime("%Y")', 'a' ],
	[ 'strptime("%Y-%m-%d"), strptime("%d %B %Y")', '2015-03-05' ],
	[ 'strptime("%Y")', 'abc' ],
]);

agree('a trailing comma may end an object, as jq 1.8 takes one — and only an object', [
	[ '{a: 1, b: 2,}' ],
	[ '{a: (1,2),}' ],
	[ '{,}' ],
	[ '{a: 1,,}' ],
	[ '[1, 2,]' ],
]);

agree('the prelude: builtins defined in the language', [
	[ '[.[] | values]', [ 1, null, 'a', false, null ] ],
	[ '[.[] | nulls], [.[] | booleans], [.[] | numbers], [.[] | strings]', [ null, true, 1, 'a', [ 1 ], { a: 1 } ] ],
	[ '[.[] | arrays], [.[] | objects], [.[] | iterables], [.[] | scalars]', [ null, true, 1, 'a', [ 1 ], { a: 1 } ] ],
	[ '[.[] | abs]', [ -1, 2, -3.5, 0 ] ],
	[ 'add(.[] | . * 2)', [ 1, 2, 3 ] ],
	[ '[{key: 0, value: 1}] | from_entries' ],
	[ '[{key: "", value: 1}] | from_entries' ],
	[ '[{key: false, Key: "k", value: 1}] | from_entries' ],
	[ '[{name: "n", Value: 2}] | from_entries' ],
	[ 'map_values(. + 1)', { a: 1, b: 2 } ],
	[ 'map_values(. + 1)', [ 1, 2 ] ],
	[ '[paths(type == "number")]', { a: 1, b: [ 2, 'x' ] } ],
	[ '[paths(scalars)]', { a: 1, b: [ 2, { c: null } ] } ],
	[ '[.[] | in({"a": 1, "b": 2})]', [ 'a', 'x' ] ],
	[ '[.[] | in([10, 20])]', [ 0, 5 ] ],
	[ '[limit(5; recurse(. * 2; . < 100))]', 1 ],
	[ '[recurse]', { a: [ 1, { b: 2 } ] } ],
	[ 'last(range(10))' ],
	[ 'last(empty)' ],
	[ 'nth(2)', [ 'a', 'b', 'c', 'd' ] ],
	[ 'nth(2; range(10))' ],
	[ 'try nth(-1; range(3)) catch "E"' ],
	[ '[any(range(3); . == 2), any(range(3); . == 5), any(empty; .), all(range(3); . < 5), all(range(3); . < 2), all(empty; .)]' ],
	[ '[any(. == 2), all(. > 0)]', [ 1, 2, 3 ] ],
	[ '[.[] | IN("a", "b")]', [ 'a', 'x' ] ],
	[ 'INDEX(.id)', [ { id: 'a', v: 1 }, { id: 'b', v: 2 } ] ],
	[ 'INDEX(.[]; .id)', [ { id: 'a' }, { id: 'b' } ] ],
	[ '[combinations]', [ [ 1, 2 ], [ 3, 4 ] ] ],
	[ '[limit(4; combinations(2))]', [ 0, 1 ] ],
	[ 'transpose', [ [ 1, 2 ], [ 3 ] ] ],
	[ 'transpose', [] ],
	[ 'pick(.a, .b.c)', { a: 1, b: { c: 2, d: 3 }, e: 4 } ],
	[ '[splits(", *")]', 'a, b,c' ],
	[ '[splits("a"; "i")]', 'xAyaz' ],
	[ 'capture("(?<x>[0-9]+)-(?<y>[a-z]+)")', '123-abc' ],
	[ '[scan("[0-9]+")]', 'a1b22c333' ],
	[ '[scan("([0-9])([a-z])")]', '1a 2b' ],
	// The program's own definitions shadow the prelude's
	[ 'def values: 42; values', null ],
	[ 'def abs: "mine"; [.[] | abs]', [ -1 ] ],
]);

agree('the source of `as` runs up to a comma', [
	[ '. - 1 as $n | $n + 10', 5 ],
	[ '1, 2 as $x | $x, 3' ],
	[ '1 as $x | $x, 3' ],
	[ 'true and false as $x | 5' ],
	[ 'false or true as $x | 5' ],
	[ 'true // 3 as $x | 10' ],
	[ '.[]? // 3 as $x | $x', {} ],
	[ '.a = 2 as $x | 99', {} ],
	[ '.a |= 7 as $x | 99', { a: 1 } ],
	[ '1 < 2 as $x | 5' ],
	[ '- .a as $x | 5', { a: 3 } ],
	[ '1 + 2 as $x | $x * 10' ],
	[ '2 as $x | . - $x as $y | $y', 5 ],
	[ '2 as $x | $x as $y | $y' ],
	[ 'if true then 1 else 2 end as $x | $x' ],
	[ 'def f: 2; f + 1 as $x | $x' ],
	[ '.[] as $x | $x', [ 7, 8 ] ],
	[ '. as [$a, $b] | $a + $b', [ 1, 2 ] ],
	[ 'reduce .[] + 1 as $x (0; . + $x)', [ 1, 2, 3 ] ],
	[ 'foreach .[] + 1 as $x (0; . + $x)', [ 1, 2 ] ],
	[ '{a: 2 as $x | $x}' ],
	[ '[1 as $x | $x]' ],
]);

agree('the math tail', [
	[ '[.[] | fabs, ceil, floor, trunc]', [ -1.7, 2.5, 3.5, -1.5, -2.5, 2.3, -0.4 ] ],
	// The isfinite family is false on a non-number rather than an error, and nan is finite
	[ '[1, infinite, nan, "a", null | isfinite, isinfinite, isnan, isnormal]' ],
	[ '[1, infinite, nan | finites]' ],
	[ '[0.5, 0, infinite, nan | normals]' ],
	[ '[.[] | sqrt]', [ 4, 2, 0.25 ] ],
	[ '[.[] | cbrt]', [ -8, 0.5 ] ],
	[ '[.[] | exp, expm1]', [ 0, 1, 2, 3, 0.1 ] ],
	[ '[.[] | log, log2, log10, log1p]', [ 1, 8, 100, 2, 0.5 ] ],
	[ '[.[] | sin, cos, tan, sinh, cosh, tanh]', [ 0, 1, -0.5 ] ],
	[ '[.[] | asin, atan, asinh]', [ 0, 0.5, 1 ] ],
	[ '0 | atanh' ],
	[ '[.[] | acos]', [ 1, 0.5 ] ],
	[ '1 | acosh' ],
	[ '[hypot(3; 4), atan2(1; 1), pow(2; 10)]' ],
	[ 'infinite, (nan | isnan), (nan | tojson)' ],
	[ '[.[] | isinfinite, isfinite, isnormal]', [ 1, 0 ] ],
	[ '[infinite, -infinite | isinfinite, isfinite, isnormal]' ],
	[ '1e-320 | isnormal' ],
	[ 'sqrt', 'x' ],
	[ 'pow(2; "x")' ],
]);

agree('the strings tail', [
	[ 'explode', 'abc' ],
	[ 'explode | implode', 'héllo 😀' ],
	[ '[104, 105] | implode' ],
	[ '["x"] | implode' ],
	[ 'utf8bytelength', 'héllo' ],
	[ 'utf8bytelength', 'a😀b' ],
	[ '[ltrim, rtrim, trim]', ' \tx y\n ' ],
	[ '[ltrim, rtrim, trim]', 'x' ],
	[ 'trimstr("x")', 'xxaxx' ],
	[ 'trimstr("ab")', 'abZab' ],
	[ '[index("c"), rindex("bc"), indices("bc")]', 'abcbc' ],
	[ 'indices("aa")', 'aaa' ],
	[ 'indices("")', 'abc' ],
	[ 'indices("x")', '' ],
	[ 'indices(1)', null ],
	[ 'indices([1, 2])', [ 1, 2, 1, 2, 1 ] ],
	[ 'indices(1)', [ 0, 1, 2, 1 ] ],
	[ '[index([1, 2]), rindex([1, 2])]', [ 1, 2, 1, 2 ] ],
	[ 'indices("a")', 1 ],
	[ 'contains("b"), contains("x")', 'abc' ],
	[ 'contains(["b"])', [ 'ab', 'c' ] ],
	[ 'contains({a: {}}), contains({a: {b: 2}}), contains({c: 1})', { a: { b: 1 }, c: 1 } ],
	[ 'contains(1)', 1 ],
	[ 'contains(["a"])', 'ab' ],
	[ '"b" | inside("abc"), inside("xyz")' ],
	[ '[1] | inside([[1], 2])' ],
]);

agree('the order seam tail', [
	[ 'min, max', [ 3, 1, 2 ] ],
	[ 'min, max', [] ],
	[ 'min_by(.a), max_by(.a)', [ { a: 1, i: 0 }, { a: 2 }, { a: 1, i: 1 } ] ],
	[ 'min_by(.[])', [ [ 1 ], [ 0, 9 ] ] ],
	[ 'unique_by(. % 2)', [ 1, 2, 2, 3 ] ],
	[ 'unique_by(length)', [ 'a', 'bb', 'c', 'ddd' ] ],
	[ '[bsearch(3), bsearch(4), bsearch(0)]', [ 1, 3, 5 ] ],
	[ 'bsearch(1)', [] ],
	[ 'bsearch("b")', [ 'a', 'c' ] ],
]);

agree('streams', [
	[ '[tostream]', [ 1, [ 2, 3 ] ] ],
	[ '[tostream]', [ [], {} ] ],
	[ '[tostream]', { a: { b: 1 } } ],
	[ '[tostream]', 5 ],
	[ '[tostream]', [] ],
	[ '[fromstream(tostream)]', { a: [ 1, { b: null } ], c: false } ],
	[ '[1 | truncate_stream([1, [ 2, 3 ]] | tostream)]' ],
	[ '[fromstream([[0], 1], [[1, 0], 2], [[1, 1], 3], [[1, 1]], [[1]])]' ],
]);

agree('the odds and ends', [
	[ 'env | type' ],
	[ '$ENV | type' ],
	[ '(env.PATH == $ENV.PATH)' ],
	[ 'format("json"), format("text")', [ 'a', 1 ] ],
	[ 'format("csv")', [ 1, 'a' ] ],
	[ '@csv, @tsv, format("csv"), format("tsv")', [ 1, 'a"b', null, true ] ],
	[ '@tsv', [ 'a\tb\nc\\d', 1 ] ],
	[ '@html', '<b>&\'"</b>' ],
	[ '@uri', 'a b&c=!*\'()' ],
	[ '@sh', [ 'a b', 'it\'s', 3 ] ],
	[ '@sh', 'plain' ],
	[ '@csv', [ [ 1 ] ] ],
	[ '@sh', { a: 1 } ],
	[ '@base64 | @base64d', 'hi there' ],
	[ 'format("nope")', null ],

	[ 'debug("m")', 1 ],
	[ 'now | floor | . > 1400000000' ],
	[ 'now | type' ],
	[ '"2015-03-05T23:51:47Z" | fromdate' ],
	[ '"x" | fromdate' ],
	[ '[limit(3; skip(2; range(10)))]' ],
	[ '[skip(0; 1, 2)]' ],
	[ 'skip(-1; 1)' ],
	[ '[.[] | flatten, flatten(1), flatten(0)]', [ [ 1, [ 2, [ 3 ] ] ] ] ],
	[ 'flatten(-1)', [] ],
	[ 'keys_unsorted', { b: 1, a: 2 } ],
	[ 'keys_unsorted', [ 5, 6 ] ],
	[ 'keys_unsorted', 1 ],
	[ 'JOIN({a: 1}; .k)', [ { k: 'a' }, { k: 'b' } ] ],
	[ 'null | [JOIN({a: 5}; ({k: "a"}, {k: "b"}); .k)]' ],
	[ 'null | [JOIN({a: 5}; ({k: "a"}, {k: "b"}); .k; [.[0].k, .[1]])]' ],
]);

agree('what jq\'s own suite taught', [
	[ 'del(.[1], .[-6], .[2], .[-3:9])', [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 ] ],
	[ 'del(.[nan])', [ 1, 2, 3 ] ],
	[ '[0, 1] | try (.[nan] = 9) catch .' ],
	[ 'try (.[999999999] = 0) catch .' ],
	[ '"abc" | try (. * 1000000000) catch .' ],
	[ 'try getpath([range(10001) | 0]) catch .' ],
	[ 'try setpath([range(10001) | 0]; 0) catch .' ],
	[ '[.[] | implode | explode]', [ [ -1 ], [ 1114112 ], [ 55296 ], [ 57344 ], [ 1.9 ] ] ],
	[ 'try ([nan] | implode) catch "E"' ],
	[ 'try ("hi" | ltrimstr(1)) catch "E", try ("hi" | rtrimstr(null)) catch "E"' ],
	[ '@uri, (@uri | @urid)', 'a b&c=!*\'()\u00e9' ],
	[ 'try ("%zz" | @urid) catch "E"' ],
	[ 'try join(",") catch .', [ '1', '2', { a: 1 } ] ],
	[ '[nth(0,3,4,5; range(4))]' ],
	[ 'try nth(-1; range(3)) catch .' ],
	[ '[-0, 0, -10, -1.1] | map(abs)' ],
	[ 'from_entries', [ { Name: 'd', Value: 4 }, { name: 'a', v: 2 }, { key: 'k', value: 1, v: 9 } ] ],
	[ 'try ([{}] | from_entries) catch "E"' ],
	[ 'from_entries', [ { name: 'a', value: 1 }, { k: 'b', v: 2 } ] ],
	[ 'pick(first)', [ 1, 2 ] ],
	[ 'try pick(last) catch .', [ 1, 2 ] ],
	[ '[path(first, last)]', [ 1, 2 ] ],
	[ 'capture(["(?<x>a)"])', 'ab' ],
	[ '[match(["(ba)r"])]', 'foo bar' ],
	[ 'test(["A", "i"]), test(["a"])', 'a' ],
	[ 'try test([]) catch .', 'x' ],
	[ 'try test(["a"]; "i") catch "E"', 'a' ],
	[ 'try sub(["a"]; "X") catch "E"', 'ab' ],
	[ 'try [splits([","])] catch "E"', 'a,b' ],
	[ 'try [scan(["a"])] catch "E"', 'ab' ],
	[ '[builtins[] | select(startswith("_"))] | length' ],
]);

describe('compiled shape', () => {
	it('is a plain function for a single-valued filter', () => {
		const filter = compile('.a + 1');
		assert.equal(filter.stream, false);
		assert.equal(filter.constructor, Function);
		assert.equal(filter({ a: 1 }), 2);
	});
	it('is a generator function for a stream', () => {
		const filter = compile('.[]');
		assert.ok(filter.stream);
		assert.equal(filter.constructor.name, 'GeneratorFunction');
		if (filter.awaits) {
			assert.fail('a plain stream does not await');
		}
		assert.deepEqual([ ...filter([ 1, 2 ]) ], [ 1, 2 ]);
	});
	it('makes objects without a prototype', () => {
		const filters = [ '{a: 1}', '{}', '{(.a.c | tostring): 1}', '. + {b: 2}', '.a.c = 1', '(.a.c = 1) | .a', 'to_entries[0]', 'del(.a.c) | .a', 'to_entries | from_entries', '{a: 1} * {a: {b: 2}}' ];
		for (const filter of filters) {
			const [ object ] = run(filter, { a: { c: 3 } }) as Value[];
			assert.equal(Object.getPrototypeOf(object), null, filter);
		}
	});
	it('takes a library of its own', () => {
		const custom: Lib = {
			...lib,
			double: () => (input: Value) => (input as number) * 2,
			twice: (render, arg) => {
				const filter = render.generator(arg);
				return function*(input, env) {
					yield* filter(input, env);
					yield* filter(input, env);
				};
			},
			// A function that reads its argument's syntax: a literal is folded at instantiation
			plus: overload(
				function(render, arg) {
					const amount = constant(arg);
					if (amount === undefined) {
						return values((input, added) => (input as number) + (added as number)).call(this, render, arg);
					} else {
						return input => (input as number) + (amount as number);
					}
				},
				values((input, first, second) => (input as number) + (first as number) + (second as number)),
			),
		};
		assert.deepEqual(run('double, twice(. + 1), length, plus(1), plus(. * 2), plus(1; 2)', 2, { lib: custom }), [ 4, 3, 3, 2, 3, 6, 5 ]);
		assert.throws(() => compile('plus(1; 2; 3)', { lib: custom }), { message: 'plus/3: no definition takes 3 arguments at line 1, column 1' });
		assert.throws(() => compile('1 | map(.; .)'), { message: 'map/2 is not defined at line 1, column 5' });
		assert.throws(() => compile('double', { lib: {} }), { message: 'double/0 is not defined at line 1, column 1' });
		assert.throws(() => compile('length', { lib: {} }), { message: /length\/0 is not defined/ });
	});
	it('binds named arguments', () => {
		assert.deepEqual(run('$x + $y', null, { args: { x: 1, y: 2 } }), [ 3 ]);
	});
	it('reports undefined names with a location', () => {
		assert.throws(() => compile('1 | foo'), { message: 'foo/0 is not defined at line 1, column 5' });
		assert.throws(() => compile('$nope'), { message: '$nope is not defined at line 1, column 1' });
		assert.throws(() => compile('1 +'), { message: /Unexpected end of input at line 1, column 4/ });
	});
});

/** Filters that await: promise-returning library functions, settled by the driver out of frame. */
describe('filters that await', () => {
	const slowly: Lib = {
		...lib,
		later: (render, arg) => promises(render, [ arg ], async (_input, value) => {
			await new Promise<void>(resolve => {
				setImmediate(resolve);
			});
			return value;
		}),
		broken: render => promises(render, [], async () => {
			await new Promise<void>(resolve => {
				setImmediate(resolve);
			});
			throw new JqError('broken');
		}),
		nasty: render => promises(render, [], async () => {
			await new Promise<void>(resolve => {
				setImmediate(resolve);
			});
			throw new TypeError('nope');
		}),
	};
	const eventually = async (filter: string, input: Value = null): Promise<Value[]> => run(filter, input, { lib: slowly });

	it('returns an array when nothing awaited', () => {
		const outputs = run('1, 2', null, { lib: slowly });
		assert.ok(Array.isArray(outputs));
		assert.deepEqual(outputs, [ 1, 2 ]);
	});
	it('returns a promise once something does', async () => {
		const outputs = run('later(1)', null, { lib: slowly });
		assert.ok(outputs instanceof Promise);
		assert.deepEqual(await outputs, [ 1 ]);
	});
	it('says so on the compiled filter', () => {
		assert.equal(compile('later(1)', { lib: slowly }).awaits, true);
		assert.equal(compile('.[]', { lib: slowly }).awaits, false);
	});
	it('awaits through the language', async () => {
		const cases: readonly (readonly [ string, Value, Value[] ])[] = [
			[ 'later(1)', null, [ 1 ] ],
			[ 'later(later(2))', null, [ 2 ] ],
			[ 'later(1) + later(2)', null, [ 3 ] ],
			[ '-later(3)', null, [ -3 ] ],
			[ '[.[] | later(. * 2)]', [ 1, 2, 3 ], [ [ 2, 4, 6 ] ] ],
			[ 'later(1), 2, later(3)', null, [ 1, 2, 3 ] ],
			[ '"got \\(later(42))"', null, [ 'got 42' ] ],
			[ 'later({a: 1}) | .a', null, [ 1 ] ],
			[ 'later([1, 2]) | .[]', null, [ 1, 2 ] ],
			[ '{a: later(1), b: 2}', null, [ { a: 1, b: 2 } ] ],
			[ 'later([3, 1, 2]) | sort', null, [ [ 1, 2, 3 ] ] ],
			[ 'later(5) as $x | $x + 1', null, [ 6 ] ],
			[ 'later([1, 2]) as [$x, $y] | $x + $y', null, [ 3 ] ],
			[ 'if later(true) then "y" else "n" end', null, [ 'y' ] ],
			[ 'later(false) // later(7)', null, [ 7 ] ],
			[ 'later(true) and later(false)', null, [ false ] ],
			[ 'reduce .[] as $x (0; later(. + $x))', [ 1, 2, 3 ], [ 6 ] ],
			[ 'foreach .[] as $x (0; later(. + $x))', [ 1, 2, 3 ], [ 1, 3, 6 ] ],
			[ 'foreach .[] as $x (0; . + $x; later(. * 10))', [ 1, 2 ], [ 10, 30 ] ],
			[ 'def double: later(. * 2); .[] | double', [ 1, 2 ], [ 2, 4 ] ],
			[ 'def f($x): $x + 1; f(later(1))', null, [ 2 ] ],
			[ 'def count: if . > 0 then ., (later(. - 1) | count) else empty end; count', 3, [ 3, 2, 1 ] ],
			[ 'label $out | later(1), break $out, 2', null, [ 1 ] ],
			[ 'try broken catch .', null, [ 'broken' ] ],
			[ '[(later(1), broken)?]', null, [ [ 1 ] ] ],
		];
		for (const [ filter, input, expected ] of cases) {
			// Through JSON: the language's objects have no prototype, the expectations here do
			assert.deepEqual(JSON.parse(tojson(await eventually(filter, input))), expected, filter);
		}
	});
	it('throws rejections into the program', async () => {
		await assert.rejects(eventually('broken'), JqError);
		// A rejection that is not the language's own error passes the language's `try` untouched
		await assert.rejects(eventually('try nasty catch .'), TypeError);
	});
	it('follows tail calls between awaits', async () => {
		assert.deepEqual(await eventually('def f: later(.), (if . > 0 then . - 1 | f else empty end); [f]', 2), [ [ 2, 1, 0 ] ]);
	});
	it('compiles to an async iteration', async () => {
		const filter = compile('later(1), 2', { lib: slowly });
		if (!filter.awaits) {
			assert.fail('expected an awaiting filter');
		}
		assert.equal(filter.stream, true);
		assert.equal((Object.getPrototypeOf(filter) as { constructor: { name: string } }).constructor.name, 'AsyncGeneratorFunction');
		const outputs: Value[] = [];
		for await (const output of filter(null)) {
			outputs.push(output);
		}
		assert.deepEqual(outputs, [ 1, 2 ]);
	});
	it('stops cleanly when the iteration does', async () => {
		const filter = compile('later(1), later(2), later(3)', { lib: slowly });
		if (!filter.awaits) {
			assert.fail('expected an awaiting filter');
		}
		const outputs: Value[] = [];
		for await (const output of filter(null)) {
			outputs.push(output);
			if (outputs.length === 2) {
				break;
			}
		}
		assert.deepEqual(outputs, [ 1, 2 ]);
	});
	it('refuses a task where a plain stream was compiled', () => {
		const refused = [
			'limit(1; later(1))',
			'first(later(1))',
			'map(later(.))',
			'sort_by(later(.))',
		];
		for (const filter of refused) {
			assert.throws(() => compile(filter, { lib: slowly }), CompileError, filter);
		}
	});
	it('locates the refusal', () => {
		assert.throws(() => compile('limit(1; later(1))', { lib: slowly }), { message: 'a filter that awaits is not supported here at line 1, column 10' });
		assert.throws(() => compile('sort_by(later(.))', { lib: slowly }), { message: 'a filter that awaits is not supported here at line 1, column 9' });
	});
	it('awaits on the right of an assignment', async () => {
		assert.equal(tojson(await eventually('.a = later(5)', { a: 1 })), '[{"a":5}]');
		assert.equal(tojson(await eventually('.a += later(2)', { a: 1 })), '[{"a":3}]');
		assert.equal(tojson(await eventually('(.a, .b) = later(7)', {})), '[{"a":7,"b":7}]');
		assert.equal(tojson(await eventually('.a |= later(. + 1)', { a: 1 })), '[{"a":2}]');
		assert.equal(tojson(await eventually('.[] |= later(. * 2)', [ 1, 2 ])), '[[2,4]]');
		assert.equal(tojson(await eventually('.a |= (later(.) | empty)', { a: 1, b: 2 })), '[{"b":2}]');
	});
	it('awaits in path mode', async () => {
		assert.deepEqual(await eventually('path(.[later(0)])', [ 5 ]), [ [ 0 ] ]);
		assert.deepEqual(await eventually('[path(if later(true) then .a else .b end)]'), [ [ [ 'a' ] ] ]);
		assert.equal(tojson(await eventually('del(.[later(1)])', [ 1, 2, 3 ])), '[[1,3]]');
		assert.deepEqual(await eventually('[path(later(.) as $x | .a)]'), [ [ [ 'a' ] ] ]);
		assert.deepEqual(await eventually('path(first(.[later(0)], .a))', [ 9 ]), [ [ 0 ] ]);
		assert.deepEqual(await eventually('[path(limit(2; .[later(0)], .[1], .[2]))]', [ 9 ]), [ [ [ 0 ], [ 1 ] ] ]);
		assert.deepEqual(await eventually('path(reduce (later("a"), "b") as $k (.; .[$k]))'), [ [ 'a', 'b' ] ]);
		assert.equal(tojson(await eventually('.[later(0):2] = ["x"]', [ 1, 2, 3 ])), '[["x",3]]');
		await assert.rejects(eventually('path(later(1))'), (error: Error) => error.message.includes('Invalid path expression'));
	});
	it('awaits through filter parameters', async () => {
		assert.deepEqual(await eventually('def f(g): g + 1; f(later(1))'), [ 2 ]);
		assert.deepEqual(await eventually('def f(g): [g]; f(later(1), 2)'), [ [ 1, 2 ] ]);
		assert.deepEqual(await eventually('def f(g): g + g; f(later(1), 10)'), [ 2, 11, 11, 20 ]);
		assert.deepEqual(await eventually('def f(g): g; def h(i): f(i); h(later(3))'), [ 3 ]);
		assert.deepEqual(await eventually('def f(g): g + 0; f(1) + f(later(2))'), [ 3 ]);
		assert.deepEqual(await eventually('def f(g): if . > 0 then . - 1 | f(g) else g end; f(later("x"))', 3), [ 'x' ]);
		assert.deepEqual(await eventually('def f($x): $x + 1; f(later(9))'), [ 10 ]);
		assert.deepEqual(await eventually('def sel(c): if c then . else empty end; [path(.[] | sel(later(. > 1)))]', [ 1, 2, 3 ]), [ [ [ 1 ], [ 2 ] ] ]);
	});
	it('bounces tail calls with an awaiting parameter', async () => {
		assert.deepEqual(await eventually('def f(g): if . <= 0 then g else . - 1 | f(g) end; 100000 | f(later("deep"))'), [ 'deep' ]);
	});
	it('runs a stream of awaits abreast', async () => {
		// `note` logs when its promise starts and when it settles: every start of a batch comes
		// before any of its ends, where a serial run would interleave them
		const log: string[] = [];
		const noting: Lib = {
			...lib,
			note: (render, arg) => promises(render, [ arg ], async (_input, value) => {
				log.push(`+${tojson(value)}`);
				await new Promise<void>(resolve => {
					setImmediate(resolve);
				});
				log.push(`-${tojson(value)}`);
				return value;
			}),
		};
		const cases: readonly (readonly [ string, Value, Value[], string ])[] = [
			[ '[.[] | note(.)]', [ 1, 2, 3 ], [ [ 1, 2, 3 ] ], '+1 +2 +3 -1 -2 -3' ],
			[ '[note(1), note(2)]', null, [ [ 1, 2 ] ], '+1 +2 -1 -2' ],
			[ 'note(1) + note(2)', null, [ 3 ], '+1 +2 -1 -2' ],
			[ '.[] as $x | note($x)', [ 1, 2 ], [ 1, 2 ], '+1 +2 -1 -2' ],
			[ 'if .[] then note("t") else note("f") end', [ true, false ], [ 't', 'f' ], '+"t" +"f" -"t" -"f"' ],
			[ '[path(.[note(0)], .[note(1)])]', null, [ [ [ 0 ], [ 1 ] ] ], '+0 +1 -0 -1' ],
			[ '[.[] | note(.) | note(. * 10)]', [ 1, 2 ], [ [ 10, 20 ] ], '+1 +2 -1 +10 -2 +20 -10 -20' ],
		];
		for (const [ filter, input, expected, batched ] of cases) {
			log.length = 0;
			assert.deepEqual(JSON.parse(tojson(await run(filter, input, { lib: noting }))), expected, filter);
			assert.equal(log.join(' '), batched, filter);
		}
	});
	it('keeps the source order when a later item settles first', async () => {
		const gates = new Map<string, () => void>();
		const gated: Lib = {
			...lib,
			gate: (render, arg) => promises(render, [ arg ], async (_input, value) => {
				await new Promise<void>(resolve => {
					gates.set(value as string, resolve);
				});
				return value;
			}),
		};
		const outputs = run('.[] | gate(.)', [ 'a', 'b' ], { lib: gated });
		assert.ok(outputs instanceof Promise);
		// Both gates are reached before either opens — that is the parallelism — and opening the
		// second first must not reorder the outputs
		for (let ii = 0; gates.size < 2; ++ii) {
			assert.ok(ii < 100, 'the second gate was never reached');
			await new Promise<void>(resolve => {
				setImmediate(resolve);
			});
		}
		gates.get('b')!();
		gates.get('a')!();
		assert.deepEqual(await outputs, [ 'a', 'b' ]);
	});
	it('holds an early failure to its turn', async () => {
		// The second body fails at once; the first's output still comes ahead of the error
		const filter = compile('.[] | if . == 2 then broken else later(.) end', { lib: slowly });
		if (!filter.awaits) {
			assert.fail('expected an awaiting filter');
		}
		const outputs: Value[] = [];
		await assert.rejects(async () => {
			for await (const output of filter([ 1, 2, 3 ])) {
				outputs.push(output);
			}
		}, JqError);
		assert.deepEqual(outputs, [ 1 ]);
	});
	it('stands down over an endless source', async () => {
		const filter = compile('def nats: ., (. + 1 | nats); 0 | nats | later(.)', { lib: slowly });
		if (!filter.awaits) {
			assert.fail('expected an awaiting filter');
		}
		const outputs: Value[] = [];
		for await (const output of filter(null)) {
			outputs.push(output);
			if (outputs.length === 3) {
				break;
			}
		}
		assert.deepEqual(outputs, [ 0, 1, 2 ]);
	});
});

describe('asynchronous inputs', () => {
	const feed = () => async function*(): AsyncIterable<Value> {
		await Promise.resolve();
		yield* [ 1, 2, 3 ];
	}();
	it('compiles input and inputs as tasks', () => {
		assert.equal(compile('.', { inputs: feed() }).awaits, false);
		assert.equal(compile('inputs', { inputs: feed() }).awaits, true);
	});
	it('reads them as they settle', async () => {
		assert.deepEqual(await run('[input, inputs]', null, { inputs: feed() }), [ [ 1, 2, 3 ] ]);
		assert.deepEqual(await run('try input catch "dry"', null, { inputs: async function*(): AsyncIterable<Value> { await Promise.resolve(); yield* []; }() }), [ 'dry' ]);
	});
});

/** Tail calls: a recursive call in tail position runs on one frame, not the JavaScript stack. */
describe('tail calls', () => {
	const results = (filter: string, input: Value = null): Value[] => run(filter, input) as Value[];
	it('runs deep single recursion on one frame', () => {
		assert.deepEqual(results('def f: if . > 0 then . - 1 | f else "done" end; f', 1000000), [ 'done' ]);
	});
	it('carries accumulators through value parameters', () => {
		assert.deepEqual(results('def sum($n; $acc): if $n == 0 then $acc else sum($n - 1; $acc + $n) end; sum(.; 0)', 100000), [ 5000050000 ]);
	});
	it('follows the tail calls of a stream', () => {
		assert.deepEqual(results('def count: if . > 0 then ., (. - 1 | count) else empty end; [count] | length', 100000), [ 100000 ]);
	});
	it('cycles a generator under limit', () => {
		assert.deepEqual(results('def cycle: "x", cycle; [limit(20000; cycle)] | length'), [ 20000 ]);
	});
	it('threads through nested definitions', () => {
		assert.deepEqual(results('def f: def g: . - 1 | f; if . > 0 then g else "ok" end; f', 500000), [ 'ok' ]);
	});
	it('takes the alternative\'s right as a tail', () => {
		assert.deepEqual(results('def f: if . > 0 then (empty // (. - 1 | f)) else "alt" end; f', 100000), [ 'alt' ]);
	});
	it('binds on the way down', () => {
		assert.deepEqual(results('def f: if . > 0 then ((. - 1) as $n | $n | f) else "bound" end; f', 100000), [ 'bound' ]);
	});
	it('passes a filter parameter down a deep recursion', () => {
		assert.deepEqual(results('def f(g): if . <= 0 then g else . - 1 | f(g) end; 1000000 | f(42)'), [ 42 ]);
	});
	it('leaves non-tail recursion alone', () => {
		assert.deepEqual(results('def fib: if . < 2 then . else (. - 1 | fib) + (. - 2 | fib) end; fib', 15), [ 610 ]);
	});
});

describe('builtins', () => {
	it('lists the library and the prelude', () => {
		const [ names ] = run('builtins', null) as [ Value[] ];
		assert.ok(names.length > 150);
		assert.ok(names.includes('length/0'));
		assert.ok(names.includes('map_values/1'));
		assert.ok(names.includes('atan2/2'));
	});
});

/** An embedder's boxed values: a boxed `String` or `Number` counts as its value throughout the machinery. */
describe('boxed values', () => {
	const boxed = (text: string): Value => new Text(text) as unknown as Value;
	const results = (filter: string, input: Value): Value => JSON.parse(tojson(run(filter, input) as Value[])) as Value;
	it('counts a boxed String as a string', () => {
		const abc = boxed('abc');
		assert.deepEqual(
			results('type, length, ., tostring, tojson, . == "abc", . < "abd", ltrimstr("a"), test("b"), (explode | implode)', abc),
			[ 'string', 3, 'abc', 'abc', '"abc"', true, true, 'bc', true, 'abc' ],
		);
		assert.deepEqual(results('{(.): 1}', abc), [ { abc: 1 } ]);
		assert.deepEqual(results('. + "!", ("x" + .)', abc), [ 'abc!', 'xabc' ]);
		assert.deepEqual(results('.[1:], .[]?', abc), [ 'bc' ]);
		assert.deepEqual(results('sort | unique', [ 'b', abc, 'abc', 'a' ]), [ [ 'a', 'abc', 'b' ] ]);
		assert.deepEqual(results('try .[] catch "no"', abc), [ 'no' ]);
		assert.deepEqual(results('splits("b")', abc), [ 'a', 'c' ]);
	});
	it('indexes and paths through a boxed key', () => {
		const key = boxed('a');
		assert.deepEqual(JSON.parse(tojson(run('.[$k], has($k)', { a: 1 }, { args: { k: key } }) as Value[])), [ 1, true ]);
		assert.deepEqual(JSON.parse(tojson(run('setpath([$k]; 2) | del(.b)', { a: 1, b: 2 }, { args: { k: key } }) as Value[])), [ { a: 2 } ]);
		assert.deepEqual(JSON.parse(tojson(run('.[$k] = 3', {}, { args: { k: key } }) as Value[])), [ { a: 3 } ]);
	});
	it('counts a plain boxed Number as a number', () => {
		// eslint-disable-next-line no-new-wrappers -- the box is the point: an embedder's Number counts as its number
		const five = new Number(5) as unknown as Value;
		assert.deepEqual(results('type, . + 1, -., . == 5, length', five), [ 'number', 6, -5, true, 5 ]);
		assert.deepEqual(JSON.parse(tojson(jq.run('-., 1 / .', five) as Value[])), [ -5, 0.2 ]);
	});
	it('answers each flavor\'s truth of an empty box', () => {
		const empty = boxed('');
		assert.deepEqual(results('[select(.), if . then "t" else "f" end]', empty), [ [ 'f' ] ]);
		assert.deepEqual(JSON.parse(tojson(jq.run('[select(.), if . then "t" else "f" end]', empty) as Value[])), [ [ '', 't' ] ]);
	});
});
