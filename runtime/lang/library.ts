/**
 * What a library function is built from: the input assertions, the smallest shapes — a function
 * of the input alone, a filter argument run over the input, a filter argument as a path
 * expression — and the numeric tables the mathematical functions are declared with.
 */
import type * as ast from '#/compiler/ast.js';
import type { Filter, LibFunction, PathFilter, Render, Stream, Value } from '#/compiler/filter.js';
import { JqError, describe, isNumber, isString } from './value.js';
import { values } from '#/compiler/filter.js';

export function assertString(value: Value, what: string): string {
	if (!isString(value)) {
		throw new JqError(`${what} input must be a string`);
	}
	return String(value);
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

/** A library function per entry of a table of numeric functions of the input alone, each named for its error messages. */
export function tabled<Table extends Readonly<Record<string, (value: number) => number>>>(fns: Table): { readonly [Name in keyof Table]: LibFunction } {
	return Object.fromEntries(Object.entries(fns).map(([ name, fn ]): [ string, LibFunction ] =>
		[ name, unary(input => fn(assertNumber(input, name))) ])) as { [Name in keyof Table]: LibFunction };
}

/** As `tabled`, of two arguments; the input plays no part, as jq has it. */
export function tabled2<Table extends Readonly<Record<string, (left: number, right: number) => number>>>(fns: Table): { readonly [Name in keyof Table]: LibFunction } {
	return Object.fromEntries(Object.entries(fns).map(([ name, fn ]): [ string, LibFunction ] =>
		[ name, values((_input, first, second) => fn(assertNumber(first, name), assertNumber(second, name))) ])) as { [Name in keyof Table]: LibFunction };
}
