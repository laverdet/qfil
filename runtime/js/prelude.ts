/**
 * The prelude: builtins written in the language itself, in scope of every program the runtime
 * compiles. Each definition reads as its jq documentation does, and a runtime laid over this one
 * gets them under its own semantics — `<` in `abs` is this runtime's order here and jq's in the
 * jq runtime, with nothing rewritten. The source is parsed once per process, lazily, and a body
 * is rendered only when a program first calls it, so an unused definition costs its binding alone.
 */
import { once } from '#/compiler/filter.js';
import { definitions } from '#/compiler/parser.js';

export const prelude = once(() => definitions(`
def values: select(. != null);
def nulls: select(type == "null");
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type == "array" or type == "object");
def scalars: select(type != "array" and type != "object");
def toboolean: if type == "boolean" then . elif . == "true" then true elif . == "false" then false else error("\\(.) cannot be parsed as a boolean") end;
def abs: if . < 0 then - . else . end;
def add(f): reduce f as $x (null; . + $x);
def map_values(f): .[] |= f;
def paths(f): . as $in | paths | select(. as $p | $in | getpath($p) | f);
def in(xs): . as $x | xs | has($x);
def recurse(f; cond): def r: ., (f | select(cond) | r); r;
def last(f): reduce f as $x (null; [$x]) | if . == null then empty else .[0] end;
def nth($n): .[$n];
def nth($n; f): if $n < 0 then error("Out of bounds negative array index") else last(limit($n + 1; f)) end;
def any(generator; condition): isempty(first(generator | select(condition))) | not;
def any(condition): any(.[]; condition);
def all(generator; condition): isempty(first(generator | select(condition | not)));
def all(condition): all(.[]; condition);
def IN(s): any(s == .; .);
def IN(source; s): any(source == s; .);
def INDEX(stream; idx): reduce stream as $row ({}; .[$row | idx | tostring] |= $row);
def INDEX(idx): INDEX(.[]; idx);
def combinations: if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $w | [$x] + $w end;
def combinations(n): . as $dot | [range(n)] | map($dot) | combinations;
def transpose: if length == 0 then [] else . as $in | ([.[] | length] | sort | .[-1]) as $max | [range($max) | . as $j | [$in[] | .[$j]]] end;
def pick(pathexps): . as $top | reduce path(pathexps) as $p (null; setpath($p; $top | getpath($p)));
def splits($re; $flags): split($re; $flags) | .[];
def splits($re): splits($re; null);
def capture($re; $flags): match($re; $flags) | reduce (.captures[] | select(.name != null) | { (.name): .string }) as $pair ({}; . + $pair);
def capture($re): capture($re; null);
def scan($re; $flags): match($re; "g" + $flags) | if (.captures | length) > 0 then [.captures[] | .string] else .string end;
def scan($re): scan($re; null);
`));
