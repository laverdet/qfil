/**
 * The library functions that ask whether a value is true — `not`, `select`, `until`, `while`,
 * `any`, `all` — over a truthiness, since what counts as true is a flavor's to say: JavaScript's
 * — the empty string, 0 and NaN are false — in `runtime/js`, and jq's — everything but `null`
 * and `false` is true — in `runtime/jq`. The language's constructs that ask the same question —
 * `if`, `and`, `or`, `//` — take their truthiness through the makers in `runtime.ts`.
 */
import type * as ast from '#/compiler/ast.js';
import type { Env, Render, Stream, Value } from '#/compiler/filter.js';
import { iterate } from './intrinsics.js';
import { unary, withFilter } from './library.js';
import { Recur, unroll } from './recur.js';
import { runtimePathFunction } from '#/compiler/filter.js';

export function conditionals(truthy: (value: Value) => boolean) {
	/** `def until(cond; update): if cond then . else (update | until(cond; update)) end;` */
	function *untilTruthy(state: Value, env: Env, cond: Stream, update: Stream): Generator<Value | Recur> {
		for (const test of cond(state, env)) {
			if (truthy(test)) {
				yield state;
			} else {
				for (const next of update(state, env)) {
					yield new Recur(untilTruthy(next, env, cond, update));
				}
			}
		}
	}

	/** `def while(cond; update): if cond then ., (update | while(cond; update)) else empty end;` */
	function *looping(state: Value, env: Env, cond: Stream, update: Stream): Generator<Value | Recur> {
		for (const test of cond(state, env)) {
			if (truthy(test)) {
				yield state;
				for (const next of update(state, env)) {
					yield new Recur(looping(next, env, cond, update));
				}
			}
		}
	}

	return {
		not: unary(input => !truthy(input)),
		select: runtimePathFunction(
			withFilter(condition => function*(input, env) {
				for (const test of condition(input, env)) {
					if (truthy(test)) {
						yield input;
					}
				}
			}),
			(render, arg) => {
				const condition = render.generator(arg);
				return function*(path, value, env) {
					for (const test of condition(value, env)) {
						if (truthy(test)) {
							yield [ path, value ];
						}
					}
				};
			},
		),
		until: (render: Render, cond: ast.Node, update: ast.Node) => {
			const test = render.generator(cond);
			const step = render.generator(update);
			return function*(input: Value, env: Env) {
				yield* unroll(untilTruthy(input, env, test, step));
			};
		},
		while: (render: Render, cond: ast.Node, update: ast.Node) => {
			const test = render.generator(cond);
			const step = render.generator(update);
			return function*(input: Value, env: Env) {
				yield* unroll(looping(input, env, test, step));
			};
		},
		any: unary(input => [ ...iterate(input) ].some(truthy)),
		all: unary(input => [ ...iterate(input) ].every(truthy)),
	};
}
