/**
 * What a library function is built from: the input assertions, and the smallest shapes — a
 * function of the input alone, a filter argument run over the input, a filter argument as a path
 * expression.
 */
import type * as ast from '#/compiler/ast.js';
import type { Filter, LibFunction, PathFilter, Render, Stream, Value } from '#/compiler/filter.js';
import { JqError, describe, isNumber } from './value.js';

export function assertString(value: Value, what: string): string {
	if (typeof value !== 'string') {
		throw new JqError(`${what} input must be a string`);
	}
	return value;
}

export function assertArray(value: Value, what: string): Value[] {
	if (!Array.isArray(value)) {
		throw new JqError(`${what} input must be an array`);
	}
	return value;
}

export function assertNumber(value: Value, what: string): number {
	if (!isNumber(value)) {
		throw new JqError(`${describe(value)} number required for ${what}`);
	}
	return Number(value);
}

/** A library function of the input alone. */
export function unary(fn: (input: Value) => Value): LibFunction {
	return _render => input => fn(input);
}

/** A filter argument run over the input, as `map(f)` and `select(f)` take one. */
export function withFilter(build: (filter: Stream) => Filter): (render: Render, arg: ast.Node) => Filter {
	return (render, arg) => build(render.generator(arg));
}

/** A filter argument as a path expression, as `path(f)` and `del(f)` take one. */
export function withPath(build: (paths: PathFilter) => Filter): (render: Render, arg: ast.Node) => Filter {
	return (render, arg) => build(render.path(arg));
}
