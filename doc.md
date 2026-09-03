# jssq

A jq-compatible query language, run as JavaScript. A filter is parsed once and assembled into a
JavaScript function of its input from the functions a runtime gives each piece of its syntax.

```ts
import { compile, run } from 'jssq';

const filter = compile('.items[] | select(.price > 10) | .name');
[ ...filter({ items: [ { name: 'a', price: 5 }, { name: 'b', price: 20 } ] }) ]; // [ 'b' ]

run('[.[] | . * 2]', [ 1, 2, 3 ]); // [ [ 2, 4, 6 ] ]
```

At a shell, `jssq` takes jq's common flags: `jssq -c '.[] | .name' data.json`, `-n`, `-r`, `-s`, `-R`,
`-S`, `--arg`, `--argjson`, `--tab`, `--indent` and `-e`.

## Compatibility

The aim is jq's language — its evaluation model, operators, paths and the bulk of its builtins —
not byte-for-byte parity with the `jq` binary. The test suite (`pnpm test`) runs every case through
both and compares outputs as JSON values, and a handful of cases document where this
implementation deliberately differs:

- Numbers are JavaScript doubles, written as JSON writes them: `1e-7` not `1E-7`, and a literal like
  `100000000000000000000000` does not survive unchanged as jq 1.7's decNumber support lets it.
  Infinity is written as the largest finite number, as jq does; NaN as `null`.
- Objects are plain JavaScript objects, so integer-like keys iterate first (`{"b":1,"1":2}` writes as
  `{"1":2,"b":1}`). Every object the language makes has a null prototype, so `__proto__` is an
  ordinary key.
- Error messages approximate jq's; `try … catch .` sees a message of the same general form.
- Numbers are doubles, printed as JavaScript prints them (`1e+20` comes out as
  `100000000000000000000`). The jq runtime (`runtime/jq`) keeps a literal's spelling as jq 1.7
  does — `1.000`, `1E+2`, `11.0` for `1.10e1` — through variables, containers, `tostring`,
  `tonumber`, `fromjson`, `sort` and negation, until arithmetic touches it.
- Order, in the default runtime, is JavaScript's: strings compare by code unit, containers are
  NaN, and anything else subtracts, so `[] < {}` is false, objects do not sort, and
  `sort_by`/`group_by` compare their keys element by element. The jq runtime has jq's total order:
  null < false < true < numbers < strings < arrays < objects.
- `repeat(f)` keeps its documented meaning (`., (f | repeat(f))`); jq 1.8.2 yields `f` of the same
  input forever.
- `reduce` and `foreach` are path expressions whose state is a path and the value at it, so
  `path(reduce ("a","b") as $k (.; .[$k]))` is `["a","b"]` whatever the input. jq's own tracking
  through a fold is accidental: the path resets when the fold is backtracked into, and any non-null
  value along the way is an invalid path expression.
- `?//` inside `reduce` or `foreach` keeps the state accumulated before the pattern that failed;
  jq 1.8.2 loses it.
- A definition that recurses does so on the JavaScript stack, a few thousand levels deep. jq
  itself turns tail calls into loops; `until`, `while`, `repeat` and `recurse` here run on the
  heap, but a user-written `def cnt: … | cnt` does not yet.
- Strings are JavaScript strings: `length`, slices, `match` offsets and ordering all work in UTF-16
  code units where jq uses code points.
- Regular expressions are JavaScript's `RegExp` (`u` and `d` are always on), rather than
  Oniguruma's. The default runtime reads flags as JavaScript's too; the jq runtime reads jq's:
  `x` (extended), `m`/`p` (dot matches newline), `s` (the default anchoring), `n` (ignore empty
  matches) — and refuses `l`, the longest match, which JavaScript cannot spell.
- The library is a proof-of-concept subset — the core of jq's builtins (`map`, `select`, `paths`,
  `del`, `to_entries`, `sort_by`, `group_by`, `split`, `join`, `test`, `sub`, …) and the `@text`,
  `@json` and `@base64` formats — written in JavaScript rather than jq. Dates, `@csv`/`@sh`/`@uri`,
  `tostream`, `combinations`, `min_by`, `indices`, `contains`, `map_values`, `any(f)`/`all(f)` and
  the rest of the long tail are not there yet.
- Modules (`import`, `include`) are not supported. `$__prog_args`, `get_search_list` and the like do
  not exist.

## Design

### Everything is a filter, and a filter is a function

Every jq expression is a generator of zero or more values. Here a filter is a JavaScript function
of an input and an environment: written as a generator function it yields a stream, otherwise it
returns exactly one value. That is the whole of a filter's declaration — `isStream` reads it off the
function itself — and the fact every construct is pure and every binding is constant is what lets
each piece be built once and reused for every input.

Nothing is turned into source text. A program is *instantiated*: the compiler walks the syntax tree
and asks, for each node, for the function that gives it meaning. It keeps only what binds names for
itself — variables, definitions and their parameters, `as`, `reduce`, `foreach`, `label` — and hands
every other construct, as syntax, to the runtime's handler for it. A handler (`runtime/js/runtime.ts`)
receives the node and a `Render`, asks back for whatever it needs of the node's children — as a
value, as a stream, as a path — and returns the filter. The runtime is therefore the semantics of
the language, one handler per kind of node, and another object of the same shape is another meaning
for the same syntax.

### Library functions receive syntax

A library function (`runtime/js/index.ts`, keyed by name) is called the same way, with a `Render` and the
syntax of its arguments, and returns the filter of the call. Its parameters are `render` and then one
per argument, so a call is checked against its `length`; one name serves every arity, and `range`
is an `overload` of three implementations, told apart by how many parameters each declares. What an argument *is* is the
function's decision, as it is in jq where `def has($k)` is sugar for a filter parameter bound with
`as`: `values` evaluates arguments as `$` parameters, once per combination of their outputs;
`render.generator` takes one as a filter to run itself, as `map` and `select` do; `render.path` takes
one as a path expression, as `path` and `del` do; and a function may read a literal straight off the
syntax — `test("^a")` compiles its pattern once, at instantiation, and never again. There are no
annotations saying which parameters are which, because nothing decides that ahead of the function.

The one thing a body cannot say is that it is also a path expression, since that is a second
implementation: `runtimePathFunction(value, path)` declares both forms for `select`, `first`,
`limit`, `getpath` and `empty`, which is what `del(.[] | select(.a))` runs. A function without a
path form, reached in path mode, raises jq's "Invalid path expression" with its value.

### Environments

Bindings live in an environment threaded through every filter: a linked list, innermost first, of
values, closures and label tokens. A reference is resolved at instantiation to a distance along it,
so the body of `. as $x | …` runs with `$x` one frame away. A definition is a closure over the
environment it was evaluated in, pushed as a frame when the `def` is reached; a call pushes that
frame (so the body may recurse) and then a frame per parameter — a value for `$name`, a closure over
the caller's environment for a filter parameter — and calls with several value-argument outputs
run once per combination, as jq's do. Whether a definition's call is a stream is read off its body;
a self-call inside that body assumes a single value and the body is rendered again if that turns
out wrong.

Destructuring is indexing: `. as [$a, {b: $c}]` is rewritten to `$t[0] as $a | $t[1].b as $c`
before rendering, and `?//` to a `try` that restores the input and moves to the next pattern. The
binding forms the compiler keeps are, in the end, just `as` and a variable.

### Errors and paths

Errors are exceptions (`JqError`). `try` catches around the body's iteration only: the consumer
runs outside that frame, so its errors pass through untouched. `label`/`break` is an exception of
its own class that `try` lets pass.

`|=`, `=`, `path(f)`, `del` and their kin need the left side as paths rather than values, so every
construct that is path-transparent in jq has a second form, `path`, yielding `[path, value]` pairs
for a path and the value at it; the runtime supplies it for indexing, iteration, `|`, `,`, `if`,
`//`, `try`, `..`, the compiler for its binding forms (`as`, `def`, `label`, and `reduce`/`foreach`,
whose state is then a path and its value), and the library for `select` and the rest. Updates go
through an `Editor` that
copies each container the first time a path passes through it and writes in place thereafter, so
`.[] |= f` over an array is linear.

### Another runtime

`runtime/jq` is the JavaScript runtime with what differs laid over it: a `literal` handler that
keeps a number's spelling, a `negate` that keeps it too, `binary` over jq's total order, and the
library with `sort` and its kin over that order (`ordered`) and `tonumber`/`fromjson` keeping
spellings. `fromjson` — which also reads the jq flavour's input — is parsed by hand: numbers are
scanned as leniently as jq's own scanner reads C doubles (`01`, `+1`, `5.`, `nan`, `Infinity` in
any case), and a number that is already spelled canonically is never boxed. A spelled number is a
boxed `Number` that remembers its text, so JavaScript itself does
the unwrapping — arithmetic, comparison and indexing coerce it — and `JSON.stringify` writes the
spelling through the box's own `toJSON`. The JavaScript runtime counts a boxed `Number` as a
number (`isNumber`, `typeOf`, `equal`), a JavaScript-native courtesy; it never makes one.

### Filters that await

An extension — jq has nothing to await. A library function may settle a promise per call:
`promises(render, args, body)` is `values` with an async body. The filter it returns is a task: a
plain sync generator that yields an `Await` holding the promise among its values. `driven` at the
very top is the only async frame there is — an async generator over the task's values that
settles what the stream awaits and resumes the generator with the result, throwing a rejection
back in (as a `JqError` when the body meant it to be caught) where the program's own `try` can
catch it. A filter that awaits therefore compiles to an async generator function — `awaits` is
true, and `for await` iterates its outputs as they settle — while everything else keeps its sync
shape; `run` still returns an array when nothing awaited and a promise of one once something has.

Whether a filter is a task is read off the function at instantiation, as `isStream` is: a
construct over a task builds an `Await`-forwarding loop (`each`), everything else keeps its plain
loop, and a single value keeps its plain call — a program with nothing to await compiles exactly
as before. That covers the whole language: path expressions and assignment build forwarding loops
when something under them awaits (`.a = later(1)`, `del(.[later(1)])`, `path(… as $x | …)`), and
a definition passes tasks through its filter parameters — the body is rendered once per set of
awaiting arguments, a flag per filter parameter, so `def f(g): g` forwards `f(later(1))` while
`f(1)` compiles exactly as it always did. `render.value` and `render.generator` refuse a task,
so a library function that runs a stream itself — `limit`, `first`, `map`, `sort_by` — rejects
an awaiting argument at compile time rather than mistaking an `Await` for a value at runtime;
`render.filter` is the opt-in the task-aware constructs use.

Awaits run abreast. Where a stream's values each feed a body that awaits — a pipe, `as`, the
sides of a comma, the branches of an `if` over its condition's values — the pump begins the next
value's body as soon as the ones before it park on an `Await`, and one wait settles every parked
promise together. Outputs still come in the source's order: a body ahead of its turn holds what it
yields, and even what it throws, until its turn, so `[.[] | fetch(.)]` starts its fetches
together and still collects them in order. The argument streams of an operator or a function call
are likewise each read once, all abreast, rather than re-run per combination. At most sixteen
bodies run beyond the one whose turn it is, so a consumer that stops early leaves an endless
source unread. What a body ahead of its turn does, it does ahead of where a serial run would have
it — the promises it starts, the inputs it reads — which is the point.

### The filesystem runtime

A proof that a runtime really is just a meaning for the syntax: `runtime/fs` queries the
filesystem. An entry — a file, a directory — is a plain value of its stat (`path`, `name`,
`type`, `size`, `mtime`) with a brand the types cannot spell, so indexing, `select`, `sort_by`
and printing need nothing new; only traversal is overridden — `.[]` of a directory is its
entries, in name order, and `..` is the entry and everything beneath it, links not followed. A
failure down there is a `JqError`, so the program's own `try` applies. `--runtime fs` takes each
file argument as a root path (`.` when none):

    jssq --runtime fs '[.[] | select(.type == "file") | .size] | add'
    jssq --runtime fs '[.. | select(.name | test("\\.ts$")) | .path]' src
    jssq --runtime fs '[.. | select(.type == "file")] | sort_by(.mtime) | last | .path'

### Tail calls

A recursive call in tail position takes no stack frame: it comes to a `Bounce` (one value) or
yields a `Tail` (a stream) — the next call, handed to whoever consumes the caller — and the
non-tail call site that entered the recursion follows the chain on its one frame (`settle`,
`unrolled`). Tail position threads through rendering as `render.last`: a handler grants it to the
one child whose outputs are its own last, with the shape knowledge only it has — the right of `|`
when the left is one value, both branches of `if` when the condition is, the right of `,` and
`//` always, the body of `as` when the source is one value. The compiler grants it to a
definition's body and to nothing else; `try`, `label`, the folds and call arguments keep their
frames, so a `Bounce` travels only along a pass-through chain. A definition is bouncy once a tail
call compiles in its body — settled through the same assumed-shape re-render as streams — and
only calls into a recursion pay for any of this; everything else compiles as before.

### Files

- `compiler/parser.ts`, `compiler/ast.ts` — scannerless recursive descent to a plain syntax tree,
  with jq's precedence.
- `compiler/compiler.ts` — instantiation: environments, definitions, calls, binding forms, and the
  dispatch of everything else to the runtime.
- `compiler/filter.ts` — the contract: `Value`, `Filter`, `Env`, `Render`, `Context`, `Runtime`,
  `LibFunction`, the combinators (`values`, `combine`, `promises`) a runtime or library is written
  with, the task machinery (`Await`, `each`, `driven`), and the tail-call machinery (`Bounce`,
  `Tail`, `settle`, `unrolled`).
  Nothing under `compiler/` depends on a particular runtime.
- `runtime/js/runtime.ts` — the default runtime: a handler per kind of node, jq's semantics in
  JavaScript, and `invalidPath`, what a value is where a path expression was needed.
- `runtime/js/index.ts` — the default library, keyed by name.
- `runtime/js/intrinsics.ts` — the operations on values: indexing, arithmetic, paths, the
  `Editor`, formats.
- `runtime/js/value.ts` — comparison, equality and JSON conversion over the contract's values.
- `runtime/jq/` — jq's numbers and order: spelled numbers as boxed `Number`s, canonical spelling,
  jq's total order, and the runtime and library laid over the JavaScript ones.
- `runtime/fs/` — the filesystem as values: branded stat objects, and traversal (`.[]`, `..`)
  laid over the JavaScript runtime.
- `index.ts` — `compile`, `run`, `parse`; `bin/jssq.ts` — the `jssq` binary.
- `jssq.test.ts` — the differential suite against the `jq` binary.
