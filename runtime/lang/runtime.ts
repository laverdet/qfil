/**
 * Handler makers shared by the runtimes: the binary operators over an ordering, and the slice
 * handler over a reading of its bounds — what `<` means and what a NaN bound is are a flavour's
 * to say; arithmetic, equality and the shape of a path are not.
 */
import type * as ast from '#/compiler/ast.js';
import type { Handler, Path, Value } from '#/compiler/filter.js';
import * as intrinsics from './intrinsics.js';
import { equal } from './value.js';
import { combine, combineStreams, each, isTask, task } from '#/compiler/filter.js';

export type Operators = Readonly<Record<ast.BinaryOperator, (left: Value, right: Value) => Value>>;

/** The binary operators over an ordering: what `<` and its kin mean is the ordering's to say; arithmetic and equality are fixed. */
export function operators(compareValues: (left: Value, right: Value) => number): Operators {
	return {
		'+': intrinsics.add,
		'-': intrinsics.subtract,
		'*': intrinsics.multiply,
		'/': intrinsics.divide,
		'%': intrinsics.modulo,
		'==': equal,
		'!=': (left, right) => !equal(left, right),
		'<': (left, right) => compareValues(left, right) < 0,
		'<=': (left, right) => compareValues(left, right) <= 0,
		'>': (left, right) => compareValues(left, right) > 0,
		'>=': (left, right) => compareValues(left, right) >= 0,
	};
}

/** The handler of a binary expression over a table of operators. */
export function binaryOver(ops: Operators): Handler<ast.Binary> {
	return {
		// The right operand varies slowest, as jq has it
		value: (node, render) => {
			const op = ops[node.op];
			return combine([ render.filter(node.left), render.filter(node.right) ], ([ left, right ]) => op(left!, right!), 'last');
		},
	};
}

export function extend(path: Path, key: Value): Path {
	return [ ...path, key ];
}

const nullLiteral: ast.Literal = { type: 'literal', value: null };

/** The slice handler over a reading of its bounds — identity in the JavaScript runtime; the jq runtime reads NaN as no bound at all. */
export function sliceOver(bound: (value: Value) => Value): Handler<ast.Slice> {
	return {
		// `from` varies slowest, then `to`, then the target, as jq has it
		value: (node, render) => combine(
			[
				render.filter(node.target),
				render.filter(node.to ?? nullLiteral),
				render.filter(node.from ?? nullLiteral),
			],
			([ value, to, from ]) => intrinsics.slice(value!, bound(from!), bound(to!)),
			'last',
		),
		path: (node, render) => {
			const bounds = combineStreams([
				render.filter(node.to ?? nullLiteral),
				render.filter(node.from ?? nullLiteral),
			], function*([ to, from ]) {
				yield { __proto__: null, start: bound(from!), end: bound(to!) };
			}, 'last');
			const targets = render.path(node.target);
			if (isTask(bounds) || isTask(targets)) {
				return task(function*(path, value, env) {
					yield* each(bounds(value, env), function*(bound) {
						const { start, end } = bound as { start: Value; end: Value };
						yield* each(targets(path, value, env), function*(pair) {
							yield [ extend(pair[0], bound), intrinsics.slice(pair[1], start, end) ] as [ Path, Value ];
						});
					});
				});
			} else {
				return function*(path, value, env) {
					for (const bound of bounds(value, env)) {
						const { start, end } = bound as { start: Value; end: Value };
						for (const [ pp, vv ] of targets(path, value, env)) {
							yield [ extend(pp, bound), intrinsics.slice(vv, start, end) ];
						}
					}
				};
			}
		},
	};
}
