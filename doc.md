# jssq

A jq-compatible query language compiled to JavaScript. A filter is parsed once and rendered as a
JavaScript function of its input; the function is then as fast as the loops it turned into.

```ts
import { compile, run } from 'jssq';

const filter = compile('.items[] | select(.price > 10) | .name');
[ ...filter({ items: [ { name: 'a', price: 5 }, { name: 'b', price: 20 } ] }) ]; // [ 'b' ]

run('[.[] | . * 2]', [ 1, 2, 3 ]); // [ [ 2, 4, 6 ] ]
```

At a shell, `jssq` takes jq's common flags: `jssq -c '.[] | .name' data.json`, `-n`, `-r`, `-s`, `-R`,
`-S`, `--arg`, `--argjson`, `--tab`, `--indent`, `-e`, and `--render` to print the JavaScript instead.

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
- `repeat(f)` keeps its documented meaning (`., (f | repeat(f))`); jq 1.8.2 yields `f` of the same
  input forever.
- Strings are JavaScript strings: `length`, slices, `match` offsets and ordering all work in UTF-16
  code units where jq uses code points.
- Regular expressions are JavaScript's `RegExp`, flags and all (`u` and `d` are always on), rather
  than Oniguruma's.
- The library is a proof-of-concept subset — the core of jq's builtins (`map`, `select`, `paths`,
  `del`, `to_entries`, `sort_by`, `group_by`, `split`, `join`, `test`, `sub`, …) and the `@text`,
  `@json` and `@base64` formats — written in JavaScript rather than jq. Dates, `@csv`/`@sh`/`@uri`,
  `tostream`, `combinations`, `min_by`, `indices`, `contains`, `map_values`, `any(f)`/`all(f)` and
  the rest of the long tail are not there yet.
- Modules (`import`, `include`) are not supported. `$__prog_args`, `get_search_list` and the like do
  not exist.

## Design

### Shapes are the spec

Every jq expression is a generator of zero or more values. The naive rendering — a generator function
per node with `yield*` between them — allocates an iterator per node per value and is exactly what
`compiler.ts` avoids. Each node is instead rendered in continuation-passing style: `stream(node, input,
scope, emit)` takes an `emit` that renders whatever consumes the node's outputs, and returns statements
that run that code once per output, inline. `.[] | select(.a) | .b` becomes one `for` loop with one `if`
in it and a `yield` at the bottom.

Making that compact needs one fact per node before rendering it: how many outputs it has. That is a
node's **shape**, and it is the language's only "specification":

- `expr` — exactly one value, and renderable as a single JavaScript expression: `.a`, `1 + .b`,
  `[.x, .y]`, `length`.
- `single` — exactly one value, but needing statements: `reduce`, `try … catch` with single bodies, a
  pipe whose left side has to be bound to a name first.
- `stream` — anything else: `.[]`, `a, b`, `.a?`, `range`, `empty`.

Shapes are computed against a scope (`shape(node, scope)`), because a call has whatever shape its
definition has, and they live only for the duration of a compilation. Nothing at runtime carries a
shape explicitly: a compiled filter *is* a plain function if its shape was `expr`/`single` and a
generator function if it was `stream`, and the same holds for every function the output declares. A
library function declares its shape the same way — by being written as a generator function or not
(`lib/index.ts`, `isStream`). The one thing a body cannot say is which of its parameters are filters
rather than values, and the few functions that take one — `map`, `sort_by`, `sub` — carry that under
a symbol on the function (`runtimeFunction(fn, { closures: [ 0 ] })`); a path form, declared with
`runtimePathFunction(expr, path)`, sits under another. That is the whole of the type system:
the spec is read off the function.

### Fan-out

A node that must emit at more than one site — `a, b`, `if` with two branches, `try` with a handler —
cannot inline its consumer at each site without duplicating it. `fanOut` renders the consumer once to
measure it: a small consumer (a `yield`, an `array.push`) is simply repeated; a large one is hoisted
into a generator IIFE that the sites `yield` into and the consumer reads in one loop. A comma of
expressions gets a third form: one loop over a `switch`, which keeps the items lazy in order with no
generator at all.

### Errors and `try`

Errors are JavaScript exceptions (`JqError`), which is what makes the CPS rendering pay off — there is
no error channel to thread. The one subtlety is that `try` covers only its body, not whatever consumes
its outputs, which in a CPS rendering sits textually inside the `try`. A single-valued body is rendered
so that the consumer runs after the `try` statement; a stream body goes through `tryCatch`, a generator
that catches around each `next()` and so cannot see the consumer's errors, since those happen between
one `next()` and the following. `label`/`break` is an exception of its own class that `try` lets pass.

### Functions

A `def` is inlined at each call site, with its filter parameters bound to the argument syntax in the
caller's scope — a closure in the compile-time sense, evaluated each time it is referenced, which is
jq's semantics for a non-`$` parameter. Only a definition that refers to itself (directly, or through a
definition nested in its body) becomes a JavaScript function, declared where the `def` is so that it
closes over the surrounding variables. A recursive function is rendered once per mode it is used in —
value, or path — and only for the modes that were requested, which is why declarations are emitted
after whatever follows the definition has been rendered.

### The compiled program

The output is a factory, `(rt, lib, ctx) => filter`, over a runtime, a library and a context. The
factory's prologue resolves everything the body will need, once: a runtime function specialised to
what is known statically (`const _1 = rt.field("a")`, `rt.compare(">")`, `rt.format("base64")`), a
library function bound to the context (`lib["map/1"].bind(ctx)`), a named argument
(`rt.argument(ctx.args, "who")`, which fails at instantiation if it is missing), `ctx.env`. Two uses
of the same expression share one name. The body refers only to those names — never to `rt`, `lib` or
`ctx` — and library functions are called with the context as `this`, which is how `input` and `debug`
reach it. The same rule extends to what the program itself defines: a filter argument that refers to
nothing bound in the body — `select(.a > 1)`, `map(.b)`, `sort_by(-.n)` — is a constant, so its
closure is made once in the prologue rather than at every evaluation, and a call whose arguments
are all constants is applied once (`rt.apply(lib["select/1"], ctx, _7)`), leaving a plain filter of
the input in the body. A closure over a variable bound in the body (`.[] as $x | map(. + $x)`) is
made where it is used. The runtime (`lib/runtime.ts`) is therefore an object of small factories, and `compile`
takes a `runtime` option: one that skips jq's checks for speed, or that traces or counts, is another
object of the same shape.

There is no prelude: nothing is defined in jq and parsed at startup, and nothing is indexed either. A
call that no `def` in scope binds is looked up by `name/arity` in the library — an object of
JavaScript functions, `lib/index.ts` by default or whatever `compile` was given as its `lib` option,
so an application can carry a standard library of its own. The compiler knows no function by name:
`select`, `first`, `range`, `path`, `empty`, `input` are library functions like `length` is. A filter
argument reaches a library function as a closure carrying both of its forms — call it for values,
`.path(path, value)` for `[path, value]` pairs — and a function that means something as a path
expression (`select`, `first`, `limit`, `getpath`, `empty`) supplies that form through
`runtimePathFunction`, which is what `del(.[] | select(.a))` runs. Recursive streams — `recurse`, `repeat`,
`until`, `while` — are written as steps that yield outputs or further steps, and `unroll` runs them
on an explicit stack, so they go as deep as the data does without touching the call stack.

A recursive function whose shape is single is a plain function with `return`, and a self-call that is
its last act — a call rendered against the function's own `return` emit — is rendered as a rebinding of
the parameters and a `continue`, so that a filter may recurse as deeply as it likes. jq programs use
recursion where other languages use loops.

### Paths

`|=`, `=`, `path(f)`, `del`, `paths`, `to_entries` and their kin need the left side as paths rather than
values. The same syntax tree is rendered a second way for that: `path(node, path, value, scope, emit)`
emits `[path, value]` pairs, and each construct that is path-transparent in jq — indexing, iteration,
`|`, `,`, `if`, `//`, `try`, `as`, `first`, `limit`, `getpath`, `select` via `if`, `recurse` — has a
path rendering. Anything else evaluates its value and raises jq's "Invalid path expression" with it.
Updates go through an `Editor` that copies each container the first time a path passes through it and
writes in place thereafter, so `.[] |= f` over an array is linear rather than quadratic.

### Files

- `parser.ts`, `ast.ts` — scannerless recursive descent to a plain syntax tree, with jq's precedence.
- `compiler.ts` — shape analysis and both renderings.
- `lib/value.ts` — the value model: plain JSON values, comparison, equality, JSON conversion.
- `lib/intrinsics.ts` — what rendered code calls directly: field access, indexing, iteration, the
  operators, paths, the `Editor`, `@format`s.
- `lib/index.ts` — the default library: an object of JavaScript functions keyed `name/arity`.
- `index.ts` — `compile`, `render`, `run`, `parse`; `cli.ts` — the `jssq` binary.
- `jssq.test.ts` — the differential suite against the `jq` binary.
