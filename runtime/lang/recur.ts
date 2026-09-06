/**
 * Recursion as data, so that a recursive stream runs on the heap rather than the call stack: a
 * step yields outputs and `Recur`s, each of which is a step to run to completion before going on.
 */
import type { Env, Stream, Value } from '#/compiler/filter.js';

export class Recur {
	readonly step: Iterable<Value | Recur>;

	constructor(step: Iterable<Value | Recur>) {
		this.step = step;
	}
}

export function *unroll(step: Iterable<Value | Recur>): Generator<Value> {
	const stack = [ step[Symbol.iterator]() ];
	while (stack.length > 0) {
		const next = stack[stack.length - 1]!.next();
		if (next.done === true) {
			stack.pop();
		} else if (next.value instanceof Recur) {
			stack.push(next.value.step[Symbol.iterator]());
		} else {
			yield next.value;
		}
	}
}

/** `def repeat(f): ., (f | repeat(f));` — which is also `recurse(f)`. */
export function *repeating(state: Value, env: Env, update: Stream): Generator<Value | Recur> {
	yield state;
	for (const next of update(state, env)) {
		yield new Recur(repeating(next, env, update));
	}
}
