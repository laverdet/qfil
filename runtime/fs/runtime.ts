/**
 * A runtime that reads the filesystem: the JavaScript runtime re-exported with traversal declared
 * over it. `.[]` of a directory is its entries and `..` is the entry and everything beneath it;
 * an entry is a plain value, so indexing, `select`, ordering and printing need nothing new, and
 * data that is not an entry keeps its JavaScript meaning. The input is an entry, from `entry(path)`.
 */
import type * as ast from '#/compiler/ast.js';
import type { Handler, Value } from '#/compiler/filter.js';
import { children, isEntry, walk } from './value.js';
import { combineStreams } from '#/compiler/filter.js';
import * as js from '#/runtime/js/runtime.js';
import { iterate as iterateOf, iterateOptional, recurse as recurseOf } from '#/runtime/lang/intrinsics.js';

export * from '#/runtime/js/runtime.js';

/** `.[]`: a directory's entries; anything else as JavaScript has it. */
function iterated(value: Value, otherwise: (value: Value) => Iterable<Value>): Iterable<Value> {
	return isEntry(value) && value.type === 'directory' ? children(value) : otherwise(value);
}

export const iterate: Handler<ast.Iterate> = {
	...js.iterate,
	value: (node, render) => combineStreams([ render.filter(node.target) ], ([ value ]) => iterated(value!, iterateOf)),
};
export const recurse: Handler<ast.RecurseAll> = {
	...js.recurse,
	value: () => function*(input) {
		yield* isEntry(input) ? walk(input) : recurseOf(input);
	},
};
const tryOf: Handler<ast.Try> = {
	...js.try,
	value: (node, render) => {
		if (node.handler === null && node.body.type === 'iterate') {
			// `.[]?`, as the JavaScript runtime special-cases it, over directories too
			return combineStreams([ render.filter(node.body.target) ], ([ value ]) => iterated(value!, iterateOptional));
		} else {
			return js.try.value(node, render);
		}
	},
};
export { tryOf as try };
