/**
 * Recursion as data, so that a recursive stream runs on the heap rather than the call stack: a
 * step yields outputs and `Recur`s, each of which is a step to run to completion before going on.
 */
import type { Value } from '#/compiler/filter.js';

export class Recur {
	/** Outputs and `Recur`s alike — one type, since a value is anything. */
	readonly step: Iterable<Value>;

	constructor(step: Iterable<Value>) {
		this.step = step;
	}
}

export function *unroll(step: Iterable<Value>): Generator {
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
