/**
 * The semantics of the language's constructs, one handler per kind of syntax node, each a direct
 * export, so the module's namespace object — `import * as runtime` — is the runtime itself: given
 * the node and a `Render` for its children, a handler returns the filter — and, for a construct
 * that is also a path expression, the path filter. The compiler keeps only what binds names;
 * everything else is here, which is what makes a runtime swappable: another module of this shape
 * is another meaning for the same syntax.
 */
import type * as ast from '#/compiler/ast.js';
import type { Env, Filter, Handler, Path, PathFilter, Render, Resumed, Stream, Value } from '#/compiler/filter.js';
import { compare } from './value.js';
import { CompileError, abreast, combine, combineStreams, each, feed, firstOf, generator, isStream, isTask, over, task } from '#/compiler/filter.js';
import * as intrinsics from '#/runtime/lang/intrinsics.js';
import { binaryOver, extend, operators, sliceOver } from '#/runtime/lang/runtime.js';
import { JqError, newObject, tostring, truthy } from '#/runtime/lang/value.js';

export { prelude } from './prelude.js';
/** Raised where a path expression was needed and a value came out instead: `path(1)`, `del(. + 1)`. */
export { invalidPath } from '#/runtime/lang/intrinsics.js';

const binaries = operators(compare);

const identityNode: ast.Identity = { type: 'identity' };
const identityFilter: Filter = input => input;

/** One key of a path expression: the key evaluated against the input, then the target's paths each extended by it. */
function pathThrough(render: Render, target: ast.Node, key: ast.Node, read: (value: Value, key: Value) => Value, extension: (key: Value) => Value): PathFilter {
	const keys = generator(render.filter(key));
	const targets = render.path(target);
	if (isTask(keys) || isTask(targets)) {
		return task(function*(path, value, env) {
			yield* each(keys(value, env), function*(kk) {
				yield* each(targets(path, value, env), function*(pair) {
					yield [ extend(pair[0], extension(kk)), read(pair[1], kk) ] as [ Path, Value ];
				});
			});
		});
	} else {
		return function*(path, value, env) {
			for (const kk of keys(value, env)) {
				for (const [ pp, vv ] of targets(path, value, env)) {
					yield [ extend(pp, extension(kk)), read(vv, kk) ];
				}
			}
		};
	}
}

function formatter(name: string): (value: Value) => string {
	if (!intrinsics.isFormat(name)) {
		throw new CompileError(`${name} is not a valid format`);
	}
	return value => intrinsics.format(name, value);
}

export const identity: Handler<ast.Identity> = {
	value: () => input => input,
	path: () => function*(path, value) {
		yield [ path, value ];
	},
};
export const recurse: Handler<ast.RecurseAll> = {
	value: () => function*(input) {
		yield* intrinsics.recurse(input);
	},
	path: () => function*(path, value) {
		yield* intrinsics.recursePaths(path, value);
	},
};
export const literal: Handler<ast.Literal> = {
	value: node => () => node.value,
};
export const loc: Handler<ast.Loc> = {
	value: node => {
		const loc = { __proto__: null, file: '<top-level>', line: node.line };
		return () => loc;
	},
};
export const format: Handler<ast.Format> = {
	value: node => {
		const format = formatter(node.name);
		return input => format(input);
	},
};
export const string: Handler<ast.Str> = {
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
};
export const index: Handler<ast.Index> = {
	// The key is evaluated first and varies slowest, as jq has it
	value: (node, render) => {
		const target = render.filter(node.target);
		if (node.key.type === 'literal' && typeof node.key.value === 'string') {
			const name = node.key.value;
			return combine([ target ], ([ value ]) => intrinsics.field(value!, name));
		} else if (node.key.type === 'literal' && typeof node.key.value === 'number') {
			const index = node.key.value;
			return combine([ target ], ([ value ]) => intrinsics.element(value!, index));
		} else {
			return combine([ target, render.filter(node.key) ], ([ value, key ]) => intrinsics.index(value!, key!), 'last');
		}
	},
	path: (node, render) => pathThrough(render, node.target, node.key, intrinsics.index, key => key),
};
export const slice = sliceOver(value => value);
export const iterate: Handler<ast.Iterate> = {
	value: (node, render) => combineStreams([ render.filter(node.target) ], ([ value ]) => intrinsics.iterate(value!)),
	path: (node, render) => {
		const targets = render.path(node.target);
		return over(targets, function*(pair) {
			const [ pp, vv ] = pair;
			for (const key of intrinsics.keysOf(vv)) {
				yield [ extend(pp, key), intrinsics.index(vv, key) ] as [ Path, Value ];
			}
		});
	},
};
const tryOf: Handler<ast.Try> = {
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
		} else {
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
		}
	},
	path: (node, render) => {
		if (node.handler === null && node.body.type === 'iterate') {
			const targets = render.path(node.body.target);
			return over(targets, function*(pair) {
				const [ pp, vv ] = pair;
				for (const key of intrinsics.keysOfOptional(vv)) {
					yield [ extend(pp, key), intrinsics.index(vv, key) ] as [ Path, Value ];
				}
			});
		}
		const body = render.path(node.body);
		const handler = node.handler === null ? null : render.path(node.handler);
		const tried: PathFilter = function*(path, value, env) {
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
		return isTask(body) || (handler !== null && isTask(handler)) ? task(tried) : tried;
	},
};
export { tryOf as try };
export const pipe: Handler<ast.Pipe> = {
	value: (node, render) => {
		const left = render.filter(node.left);
		// With one value on the left, the right's outputs are the pipe's last
		const right = isStream(left) ? render.filter(node.right) : render.last(node.right);
		if (isStream(left)) {
			const rights = generator(right);
			const piped = function*(value: Value, _input: Value, env: Env): Generator<Value, void, Resumed> {
				yield* rights(value, env);
			};
			return isTask(right) ? abreast(left, piped) : over(left, piped);
		} else if (isStream(right)) {
			const piped: Stream = function*(input, env) {
				yield* right(left(input, env), env);
			};
			return isTask(right) ? task(piped) : piped;
		} else {
			return (input, env) => right(left(input, env), env);
		}
	},
	path: (node, render) => {
		const left = render.path(node.left);
		const right = render.path(node.right);
		const piped = function*(pair: [ Path, Value ], _path: Path, _value: Value, env: Env): Generator<[ Path, Value ], void, Resumed> {
			yield* right(pair[0], pair[1], env);
		};
		return isTask(right) ? abreast(left, piped) : over(left, piped);
	},
};
export const comma: Handler<ast.Comma> = {
	value: (node, render) => {
		const left = generator(render.filter(node.left));
		// The left is exhausted before the right begins: the right's outputs are the comma's last
		const right = generator(render.last(node.right));
		if (isTask(left) || isTask(right)) {
			// The sides run abreast; the left's outputs still come first
			return abreast(function*(_input: Value, _env: Env): Generator<Stream, void, Resumed> {
				yield left;
				yield right;
			}, function*(side: Stream, input: Value, env: Env): Generator<Value, void, Resumed> {
				yield* side(input, env);
			});
		} else {
			return function*(input, env) {
				yield* left(input, env);
				yield* right(input, env);
			};
		}
	},
	path: (node, render) => {
		const left = render.path(node.left);
		const right = render.path(node.right);
		if (isTask(left) || isTask(right)) {
			return abreast(function*(_path: Path, _value: Value, _env: Env): Generator<PathFilter, void, Resumed> {
				yield left;
				yield right;
			}, function*(side: PathFilter, path: Path, value: Value, env: Env): Generator<[ Path, Value ], void, Resumed> {
				yield* side(path, value, env);
			});
		} else {
			return function*(path, value, env) {
				yield* left(path, value, env);
				yield* right(path, value, env);
			};
		}
	},
};
export const binary = binaryOver(binaries);
export const and: Handler<ast.Logical> = {
	value: (node, render) => logical(node, render, false),
};
export const or: Handler<ast.Logical> = {
	value: (node, render) => logical(node, render, true),
};
export const alternative: Handler<ast.Alternative> = {
	// The truthy outputs of the left, or those of the right when there are none; errors are errors
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
export const negate: Handler<ast.Negate> = {
	value: (node, render) => combine([ render.filter(node.operand) ], ([ value ]) => intrinsics.negate(value!)),
};
export const assign: Handler<ast.Assign> = {
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
					return binaries[node.op.slice(0, -1) as ast.BinaryOperator];
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
const ifOf: Handler<ast.If> = {
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
export { ifOf as if };
export const array: Handler<ast.ArrayCons> = {
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
		} else {
			return (input, env) => [ ...body(input, env) ];
		}
	},
};
export const object: Handler<ast.ObjectCons> = {
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
};

/** `and` / `or`: the left short-circuits, and each output of the right is a boolean. */
function logical(node: ast.Logical, render: Render, short: boolean): Filter {
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
}
