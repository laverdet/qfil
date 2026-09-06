/**
 * Handler makers shared by the runtimes, each over what is a flavour's to say: the binary
 * operators over an ordering, the slice handler over a reading of its bounds, and the constructs
 * that ask whether a value is true — `if`, `and`, `or`, `//`, `//=` — over a truthiness.
 * Arithmetic, equality and the shape of a path are not up for debate.
 */
import type * as ast from '#/compiler/ast.js';
import type { Env, Filter, Handler, Path, PathFilter, Render, Resumed, Value } from '#/compiler/filter.js';
import * as intrinsics from './intrinsics.js';
import { equal } from './value.js';
import { abreast, combine, combineStreams, each, feed, firstOf, generator, isStream, isTask, over, task } from '#/compiler/filter.js';

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

type Truthy = (value: Value) => boolean;

const identityNode: ast.Identity = { type: 'identity' };
const identityFilter: Filter = input => input;

/** The `and` and `or` handlers over a truthiness: the left short-circuits, and each output of the right is a boolean. */
export function logicalOver(truthy: Truthy): { readonly and: Handler<ast.Logical>; readonly or: Handler<ast.Logical> } {
	const logical = (node: ast.Logical, render: Render, short: boolean): Filter => {
		const left = render.filter(node.left);
		const right = render.filter(node.right);
		if (!isStream(left) && !isStream(right)) {
			return (input, env) => truthy(left(input, env)) === short ? short : truthy(right(input, env));
		} else {
			const rights = over(generator(right), function*(other) {
				yield truthy(other);
			});
			const both = function*(value: Value, input: Value, env: Env): Generator<Value, void, Resumed> {
				if (truthy(value) === short) {
					yield short;
				} else {
					yield* rights(input, env);
				}
			};
			const lefts = generator(left);
			return isTask(rights) ? abreast(lefts, both) : over(lefts, both);
		}
	};
	return {
		and: {
			value: (node, render) => logical(node, render, false),
		},
		or: {
			value: (node, render) => logical(node, render, true),
		},
	};
}

/** The `//` handler over a truthiness: the truthy outputs of the left, or those of the right when there are none; errors are errors. */
export function alternativeOver(truthy: Truthy): Handler<ast.Alternative> {
	return {
		value: (node, render) => {
			const left = generator(render.filter(node.left));
			// The right runs only once the left has nothing truthy left: its outputs are the last
			const right = generator(render.last(node.right));
			if (isTask(left) || isTask(right)) {
				return task(function*(input, env) {
					let found = false;
					yield* each(left(input, env), function*(value) {
						if (truthy(value)) {
							found = true;
							yield value;
						}
					});
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in the `each` body, which narrowing cannot see
					if (!found) {
						yield* right(input, env);
					}
				});
			} else {
				return function*(input, env) {
					let found = false;
					for (const value of left(input, env)) {
						if (truthy(value)) {
							found = true;
							yield value;
						}
					}
					if (!found) {
						yield* right(input, env);
					}
				};
			}
		},
		path: (node, render) => {
			const left = render.path(node.left);
			const right = render.path(node.right);
			if (isTask(left) || isTask(right)) {
				return task(function*(path, value, env) {
					let found = false;
					yield* each(left(path, value, env), function*(pair) {
						if (truthy(pair[1])) {
							found = true;
							yield pair;
						}
					});
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in the `each` body, which narrowing cannot see
					if (!found) {
						yield* right(path, value, env);
					}
				});
			} else {
				return function*(path, value, env) {
					let found = false;
					for (const pair of left(path, value, env)) {
						if (truthy(pair[1])) {
							found = true;
							yield pair;
						}
					}
					if (!found) {
						yield* right(path, value, env);
					}
				};
			}
		},
	};
}

/** The `if` handler over a truthiness. */
export function ifOver(truthy: Truthy): Handler<ast.If> {
	return {
		value: (node, render) => {
			const condition = render.filter(node.condition);
			// With one condition value, the chosen branch's outputs are the if's last
			const branch = isStream(condition) ? render.filter : render.last;
			const then = branch(node.then);
			const otherwise = node.else === null ? identityFilter : branch(node.else);
			if (!isStream(condition) && !isStream(then) && !isStream(otherwise)) {
				return (input, env) => truthy(condition(input, env)) ? then(input, env) : otherwise(input, env);
			} else {
				const thens = generator(then);
				const otherwises = generator(otherwise);
				const branched = function*(test: Value, input: Value, env: Env): Generator<Value, void, Resumed> {
					yield* truthy(test) ? thens(input, env) : otherwises(input, env);
				};
				const conditions = generator(condition);
				return isTask(thens) || isTask(otherwises) ? abreast(conditions, branched) : over(conditions, branched);
			}
		},
		path: (node, render) => {
			const conditions = generator(render.filter(node.condition));
			const then = render.path(node.then);
			const otherwise = render.path(node.else ?? identityNode);
			const branched: PathFilter = isTask(conditions)
				? task(function*(path, value, env) {
					yield* each(conditions(value, env), function*(test) {
						yield* truthy(test) ? then(path, value, env) : otherwise(path, value, env);
					});
				})
				: function*(path, value, env) {
					for (const test of conditions(value, env)) {
						yield* truthy(test) ? then(path, value, env) : otherwise(path, value, env);
					}
				};
			return isTask(then) || isTask(otherwise) ? task(branched) : branched;
		},
	};
}

/** The assignment handler over the operators — `+=` and its kin combine through them — and a truthiness, for `//=`. */
export function assignOver(ops: Operators, truthy: Truthy): Handler<ast.Assign> {
	return {
		value: (node, render) => {
			const paths = render.path(node.left);
			const right = render.filter(node.right);
			if (node.op === '|=') {
				// Each path is updated to the first output of the right, or deleted when there is none
				const update = generator(right);
				if (isTask(paths) || isTask(update)) {
					return task(function*(input, env) {
						const editor = new intrinsics.Editor(input);
						const deletions: Path[] = [];
						yield* each(paths([], input, env), function*(pair) {
							const output = yield* firstOf(update(editor.get(pair[0]), env));
							if (output === undefined) {
								deletions.push(pair[0]);
							} else {
								editor.set(pair[0], output);
							}
						});
						yield intrinsics.delpaths(editor.result(), deletions);
					});
				} else {
					return (input, env) => {
						const editor = new intrinsics.Editor(input);
						const deletions: Path[] = [];
						for (const [ path ] of paths([], input, env)) {
							const outputs = update(editor.get(path), env)[Symbol.iterator]().next();
							if (outputs.done === true) {
								deletions.push(path);
							} else {
								editor.set(path, outputs.value);
							}
						}
						return intrinsics.delpaths(editor.result(), deletions);
					};
				}
			} else {
				const combineWith = function(): (current: Value, value: Value) => Value {
					if (node.op === '=') {
						return (_current, value) => value;
					} else if (node.op === '//=') {
						return (current, value) => truthy(current) ? current : value;
					} else {
						return ops[node.op.slice(0, -1) as ast.BinaryOperator];
					}
				}();
				if (isTask(paths) || isTask(right)) {
					return abreast(generator(right), function*(value, input, env) {
						const editor = new intrinsics.Editor(input);
						yield* feed(paths([], input, env), pair => {
							editor.set(pair[0], combineWith(editor.get(pair[0]), value));
						});
						yield editor.result();
					});
				} else {
					return combine([ right ], ([ value ], input, env) => {
						const editor = new intrinsics.Editor(input);
						for (const [ path ] of paths([], input, env)) {
							editor.set(path, combineWith(editor.get(path), value!));
						}
						return editor.result();
					});
				}
			}
		},
	};
}
