/**
 * The semantics of the language's constructs, one handler per kind of syntax node: given the node
 * and a `Render` for its children, a handler returns the filter — and, for a construct that is
 * also a path expression, the path filter. The compiler keeps only what binds names; everything
 * else is here, which is what makes a runtime swappable: another object of this shape is another
 * meaning for the same syntax.
 */
import type * as ast from '#/compiler/ast.js';
import type { Filter, Handler, Path, PathFilter, Render, Runtime, Stream, Value } from '#/compiler/filter.js';
import * as intrinsics from './intrinsics.js';
import { JqError, compare, equal, newObject, tostring, truthy } from './value.js';
import { CompileError, combine, combineStreams, each, feed, generator, isStream, isTask, over, task } from '#/compiler/filter.js';

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
export function binary(ops: Operators): Handler<ast.Binary> {
	return {
		// The right operand varies slowest, as jq has it
		value: (node, render) => {
			const op = ops[node.op];
			return combine([ render.filter(node.left), render.filter(node.right) ], ([ left, right ]) => op(left!, right!), 'last');
		},
	};
}

const binaries = operators(compare);

const nullLiteral: ast.Literal = { type: 'literal', value: null };
const identity: ast.Identity = { type: 'identity' };
const identityFilter: Filter = input => input;

function extend(path: Path, key: Value): Path {
	return [ ...path, key ];
}

/** One key of a path expression: the key evaluated against the input, then the target's paths each extended by it. */
function pathThrough(render: Render, target: ast.Node, key: ast.Node, read: (value: Value, key: Value) => Value, extension: (key: Value) => Value): PathFilter {
	const keys = render.generator(key);
	const targets = render.path(target);
	return function*(path, value, env) {
		for (const kk of keys(value, env)) {
			for (const [ pp, vv ] of targets(path, value, env)) {
				yield [ extend(pp, extension(kk)), read(vv, kk) ];
			}
		}
	};
}

function formatter(name: string): (value: Value) => string {
	if (!intrinsics.isFormat(name)) {
		throw new CompileError(`${name} is not a valid format`);
	}
	return value => intrinsics.format(name, value);
}

/** jq's semantics over JavaScript's values: doubles, and JavaScript's order. */
export const runtime: Runtime = {
	invalidPath: intrinsics.invalidPath,
	identity: {
		value: () => input => input,
		path: () => function*(path, value) {
			yield [ path, value ];
		},
	},
	recurse: {
		value: () => function*(input) {
			yield* intrinsics.recurse(input);
		},
		path: () => function*(path, value) {
			yield* intrinsics.recursePaths(path, value);
		},
	},
	literal: {
		value: node => () => node.value,
	},
	loc: {
		value: node => {
			const loc = { __proto__: null, file: '<top-level>', line: node.line };
			return () => loc;
		},
	},
	format: {
		value: node => {
			const format = formatter(node.name);
			return input => format(input);
		},
	},
	string: {
		// The last interpolation varies slowest, as jq has it
		value: (node, render) => {
			const convert = node.format === null ? tostring : formatter(node.format);
			const parts = node.parts.map(part => typeof part === 'string' ? part : render.filter(part));
			const filters = parts.filter(part => typeof part !== 'string');
			return combine(filters, values => {
				let next = 0;
				return parts.map(part => typeof part === 'string' ? part : convert(values[next++]!)).join('');
			}, 'last');
		},
	},
	index: {
		// The key is evaluated first and varies slowest, as jq has it
		value: (node, render) => {
			const target = render.filter(node.target);
			if (node.key.type === 'literal' && typeof node.key.value === 'string') {
				const name = node.key.value;
				return combine([ target ], ([ value ]) => intrinsics.field(value!, name));
			} else if (node.key.type === 'literal' && typeof node.key.value === 'number') {
				const index = node.key.value;
				return combine([ target ], ([ value ]) => intrinsics.element(value!, index));
			}
			return combine([ target, render.filter(node.key) ], ([ value, key ]) => intrinsics.index(value!, key!), 'last');
		},
		path: (node, render) => pathThrough(render, node.target, node.key, intrinsics.index, key => key),
	},
	slice: {
		// `from` varies slowest, then `to`, then the target, as jq has it
		value: (node, render) => combine(
			[ render.filter(node.target), render.filter(node.to ?? nullLiteral), render.filter(node.from ?? nullLiteral) ],
			([ value, to, from ]) => intrinsics.slice(value!, from!, to!),
			'last',
		),
		path: (node, render) => {
			const bounds = combineStreams([
				render.value(node.to ?? nullLiteral),
				render.value(node.from ?? nullLiteral),
			], function*([ to, from ]) {
				yield { __proto__: null, start: from!, end: to! };
			}, 'last');
			const targets = render.path(node.target);
			return function*(path, value, env) {
				for (const bound of bounds(value, env)) {
					const { start, end } = bound as { start: Value; end: Value };
					for (const [ pp, vv ] of targets(path, value, env)) {
						yield [ extend(pp, bound), intrinsics.slice(vv, start, end) ];
					}
				}
			};
		},
	},
	iterate: {
		value: (node, render) => combineStreams([ render.filter(node.target) ], ([ value ]) => intrinsics.iterate(value!)),
		path: (node, render) => {
			const targets = render.path(node.target);
			return function*(path, value, env) {
				for (const [ pp, vv ] of targets(path, value, env)) {
					for (const key of intrinsics.keysOf(vv)) {
						yield [ extend(pp, key), intrinsics.index(vv, key) ];
					}
				}
			};
		},
	},
	try: {
		value: (node, render) => {
			if (node.handler === null && node.body.type === 'iterate') {
				// `.[]?`: the only error is the iteration's own
				return combineStreams([ render.filter(node.body.target) ], ([ value ]) => intrinsics.iterateOptional(value!));
			}
			const body = render.filter(node.body);
			const handler = node.handler === null ? null : render.filter(node.handler);
			if (!isStream(body) && handler !== null && !isStream(handler)) {
				return (input, env) => {
					try {
						return body(input, env);
					} catch (error) {
						if (error instanceof JqError) {
							return handler(error.value, env);
						}
						throw error;
					}
				};
			}
			// Errors of the body, and only those: the consumer runs outside this frame
			const stream = generator(body);
			const recover = handler === null ? null : generator(handler);
			const tried: Stream = function*(input, env) {
				try {
					yield* stream(input, env);
				} catch (error) {
					if (!(error instanceof JqError)) {
						throw error;
					} else if (recover !== null) {
						yield* recover(error.value, env);
					}
				}
			};
			return isTask(stream) || (recover !== null && isTask(recover)) ? task(tried) : tried;
		},
		path: (node, render) => {
			if (node.handler === null && node.body.type === 'iterate') {
				const targets = render.path(node.body.target);
				return function*(path, value, env) {
					for (const [ pp, vv ] of targets(path, value, env)) {
						for (const key of intrinsics.keysOfOptional(vv)) {
							yield [ extend(pp, key), intrinsics.index(vv, key) ];
						}
					}
				};
			}
			const body = render.path(node.body);
			const handler = node.handler === null ? null : render.path(node.handler);
			return function*(path, value, env) {
				try {
					yield* body(path, value, env);
				} catch (error) {
					if (!(error instanceof JqError)) {
						throw error;
					} else if (handler !== null) {
						yield* handler(path, error.value, env);
					}
				}
			};
		},
	},
	pipe: {
		value: (node, render) => {
			const left = render.filter(node.left);
			const right = render.filter(node.right);
			if (!isStream(left)) {
				if (!isStream(right)) {
					return (input, env) => right(left(input, env), env);
				}
				const piped: Stream = function*(input, env) {
					yield* right(left(input, env), env);
				};
				return isTask(right) ? task(piped) : piped;
			}
			const rights = generator(right);
			const piped = over(left, function*(value, _input, env) {
				yield* rights(value, env);
			});
			return isTask(right) ? task(piped) : piped;
		},
		path: (node, render) => {
			const left = render.path(node.left);
			const right = render.path(node.right);
			return function*(path, value, env) {
				for (const [ pp, vv ] of left(path, value, env)) {
					yield* right(pp, vv, env);
				}
			};
		},
	},
	comma: {
		value: (node, render) => {
			const left = generator(render.filter(node.left));
			const right = generator(render.filter(node.right));
			const both: Stream = function*(input, env) {
				yield* left(input, env);
				yield* right(input, env);
			};
			return isTask(left) || isTask(right) ? task(both) : both;
		},
		path: (node, render) => {
			const left = render.path(node.left);
			const right = render.path(node.right);
			return function*(path, value, env) {
				yield* left(path, value, env);
				yield* right(path, value, env);
			};
		},
	},
	binary: binary(binaries),
	and: {
		value: (node, render) => logical(node, render, false),
	},
	or: {
		value: (node, render) => logical(node, render, true),
	},
	alternative: {
		// The truthy outputs of the left, or those of the right when there are none; errors are errors
		value: (node, render) => {
			const left = generator(render.filter(node.left));
			const right = generator(render.filter(node.right));
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
			}
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
		},
		path: (node, render) => {
			const left = render.path(node.left);
			const right = render.path(node.right);
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
		},
	},
	negate: {
		value: (node, render) => combine([ render.filter(node.operand) ], ([ value ]) => intrinsics.negate(value!)),
	},
	assign: {
		value: (node, render) => {
			const paths = render.path(node.left);
			const right = render.value(node.right);
			if (node.op === '|=') {
				// Each path is updated to the first output of the right, or deleted when there is none
				const update = generator(right);
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
			const combineWith = function(): (current: Value, value: Value) => Value {
				if (node.op === '=') {
					return (_current, value) => value;
				} else if (node.op === '//=') {
					return (current, value) => truthy(current) ? current : value;
				}
				return binaries[node.op.slice(0, -1) as ast.BinaryOperator];
			}();
			return combine([ right ], ([ value ], input, env) => {
				const editor = new intrinsics.Editor(input);
				for (const [ path ] of paths([], input, env)) {
					editor.set(path, combineWith(editor.get(path), value!));
				}
				return editor.result();
			});
		},
	},
	if: {
		value: (node, render) => {
			const condition = render.filter(node.condition);
			const then = render.filter(node.then);
			const otherwise = node.else === null ? identityFilter : render.filter(node.else);
			if (!isStream(condition) && !isStream(then) && !isStream(otherwise)) {
				return (input, env) => truthy(condition(input, env)) ? then(input, env) : otherwise(input, env);
			}
			const thens = generator(then);
			const otherwises = generator(otherwise);
			const branched = over(generator(condition), function*(test, input, env) {
				yield* truthy(test) ? thens(input, env) : otherwises(input, env);
			});
			return isTask(thens) || isTask(otherwises) ? task(branched) : branched;
		},
		path: (node, render) => {
			const conditions = render.generator(node.condition);
			const then = render.path(node.then);
			const otherwise = render.path(node.else ?? identity);
			return function*(path, value, env) {
				for (const test of conditions(value, env)) {
					yield* truthy(test) ? then(path, value, env) : otherwise(path, value, env);
				}
			};
		},
	},
	array: {
		value: (node, render) => {
			if (node.body === null) {
				return () => [];
			}
			const body = generator(render.filter(node.body));
			if (isTask(body)) {
				return task(function*(input, env) {
					const elements: Value[] = [];
					yield* feed(body(input, env), value => elements.push(value));
					yield elements;
				});
			}
			return (input, env) => [ ...body(input, env) ];
		},
	},
	object: {
		// Entries in order, the first varying slowest, each key before its value
		value: (node, render) => {
			const filters = node.entries.flatMap(entry => {
				const key = render.filter(entry.key);
				if (entry.value !== null) {
					return [ key, render.filter(entry.value) ];
				}
				// `{a}` is `{a: .a}`; `{$x}` is `{x: $x}`, which the parser spells with a variable value
				return [ key, combine([ key ], ([ name ], input) => intrinsics.index(input, name!)) ];
			});
			return combine(filters, values => {
				const object = newObject();
				for (let ii = 0; ii < values.length; ii += 2) {
					object[intrinsics.toKey(values[ii]!)] = values[ii + 1]!;
				}
				return object;
			});
		},
	},
};

/** `and` / `or`: the left short-circuits, and each output of the right is a boolean. */
function logical(node: ast.Logical, render: Render, short: boolean): Filter {
	const left = render.filter(node.left);
	const right = render.filter(node.right);
	if (!isStream(left) && !isStream(right)) {
		return (input, env) => truthy(left(input, env)) === short ? short : truthy(right(input, env));
	}
	const rights = over(generator(right), function*(other) {
		yield truthy(other);
	});
	const boths = over(generator(left), function*(value, input, env) {
		if (truthy(value) === short) {
			yield short;
		} else {
			yield* rights(input, env);
		}
	});
	return isTask(rights) ? task(boths) : boths;
}
