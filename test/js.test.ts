/** The package as a JavaScript library: the compiled shape, doubles, filters that await, tail calls. */
import type { Lib, Value } from '#/index.js';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compile, run } from './harness.js';
import { CompileError, JqError, constant, overload, promises, values } from '#/index.js';
import { lib } from '#/runtime/js/index.js';
import { tojson } from '#/runtime/js/value.js';

describe('number formatting', () => {
	// JavaScript's shortest round-trip formatting; jq preserves literals and formats doubles its own way
	it('writes doubles as JSON does', () => {
		assert.deepEqual(run('[.[] | tojson]', [ 1e-7, 1e21, 0.1, 100, 3.14 ]), [ [ '1e-7', '1e+21', '0.1', '100', '3.14' ] ]);
		assert.deepEqual(run('[.[] | tostring]', [ 1.0, 1.5, 1e100 ]), [ [ '1', '1.5', '1e+100' ] ]);
	});
});

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
				(render, arg) => {
					const amount = constant(arg);
					return amount === undefined ? values(render, [ arg ], (input, added) => (input as number) + (added as number)) : (input: Value) => (input as number) + (amount as number);
				},
				(render, left, right) => values(render, [ left, right ], (input, first, second) => (input as number) + (first as number) + (second as number)),
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
