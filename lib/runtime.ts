/**
 * What a compiled program is built from. The program's factory calls these once, up front, with
 * whatever it knows statically — a field name, an operator, a format — and keeps the functions they
 * return; nothing here runs per value except those. That is the seam for a different runtime: one
 * that skips jq's checks for speed, or that counts, traces or instruments, is another object of the
 * same shape handed to `compile`.
 */
import type { Closure, Context, Editor, LibFunction, Path } from './intrinsics.js';
import type { Value } from './value.js';
import * as intrinsics from './intrinsics.js';
import { Break, JqError, compare, equal, tostring, truthy } from './value.js';

export type BinaryOperator = '+' | '-' | '*' | '/' | '%';
export type Comparison = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface Runtime {
	/** `.name` */
	readonly field: (name: string) => (value: Value) => Value;
	/** `.[n]` for a literal `n` */
	readonly element: (index: number) => (value: Value) => Value;
	/** `.[key]` for any key */
	readonly index: () => (value: Value, key: Value) => Value;
	/** `.[from:to]` */
	readonly slice: () => (value: Value, from: Value, to: Value) => Value;
	/** `.[]`, and `.[]?` which yields nothing rather than failing */
	readonly iterate: () => (value: Value) => Iterable<Value>;
	readonly iterateOptional: () => (value: Value) => Iterable<Value>;
	/** The keys `.[]` visits, for walking a value alongside its paths */
	readonly keysOf: () => (value: Value) => Iterable<number | string>;
	readonly keysOfOptional: () => (value: Value) => Iterable<number | string>;
	/** `..`, as values and as paths */
	readonly recurse: () => (value: Value) => Iterable<Value>;
	readonly recursePaths: () => (path: Path, value: Value) => Iterable<[ Path, Value ]>;
	readonly binary: (op: BinaryOperator) => (left: Value, right: Value) => Value;
	readonly compare: (op: Comparison) => (left: Value, right: Value) => boolean;
	readonly negate: () => (value: Value) => Value;
	/** jq's truth: everything but `null` and `false` */
	readonly truthy: () => (value: Value) => boolean;
	/** An object construction key, which must be a string */
	readonly toKey: () => (value: Value) => string;
	/** String interpolation, and `@format` interpolation */
	readonly tostring: () => (value: Value) => string;
	readonly format: (name: string) => (value: Value) => string;
	readonly getpath: () => (value: Value, path: Value) => Value;
	readonly delpaths: () => (value: Value, paths: Value) => Value;
	/** The updater behind `|=`, `=` and their kin */
	readonly editor: () => (value: Value) => Editor;
	/** `try`: errors of the body go to the handler, errors of the consumer pass through */
	readonly tryCatch: () => <Type>(body: Iterable<Type>, handler: ((error: Value) => Iterable<Type>) | null) => Iterable<Type>;
	readonly isError: () => (error: unknown) => error is JqError;
	/** A filter argument: its value form carrying its path form */
	readonly closure: () => (value: (input: Value) => Iterable<Value>, path: Closure['path']) => Closure;
	/** A value where a path was needed */
	readonly invalidPath: () => (value: Value) => never;
	/** `label $name | … break $name` */
	readonly breakOut: () => (label: object) => never;
	readonly isBreak: () => (error: unknown, label: object) => boolean;
	/** A library function as a path expression */
	readonly pathCall: (fn: LibFunction, ctx: Context) => (path: Path, value: Value, ...args: unknown[]) => Iterable<[ Path, Value ]>;
	/** A library function applied to constant arguments, once: the filter of an input that results, in each mode */
	readonly apply: (fn: LibFunction, ctx: Context, ...args: unknown[]) => (input: Value) => Value | Iterable<Value>;
	readonly applyPath: (fn: LibFunction, ctx: Context, ...args: unknown[]) => (path: Path, value: Value) => Iterable<[ Path, Value ]>;
	/** A named argument, `$name` */
	readonly argument: (args: Readonly<Record<string, Value>>, name: string) => Value;
}

const binaries: Readonly<Record<BinaryOperator, (left: Value, right: Value) => Value>> = {
	'+': intrinsics.add,
	'-': intrinsics.subtract,
	'*': intrinsics.multiply,
	'/': intrinsics.divide,
	'%': intrinsics.modulo,
};

const comparisons: Readonly<Record<Comparison, (left: Value, right: Value) => boolean>> = {
	'==': equal,
	'!=': (left, right) => !equal(left, right),
	'<': (left, right) => compare(left, right) < 0,
	'<=': (left, right) => compare(left, right) <= 0,
	'>': (left, right) => compare(left, right) > 0,
	'>=': (left, right) => compare(left, right) >= 0,
};

/** jq's semantics, checks and all. */
export const runtime: Runtime = {
	field: name => value => intrinsics.field(value, name),
	element: index => value => intrinsics.element(value, index),
	index: () => intrinsics.index,
	slice: () => intrinsics.slice,
	iterate: () => intrinsics.iterate,
	iterateOptional: () => intrinsics.iterateOptional,
	keysOf: () => intrinsics.keysOf,
	keysOfOptional: () => intrinsics.keysOfOptional,
	recurse: () => intrinsics.recurse,
	recursePaths: () => intrinsics.recursePaths,
	binary: op => binaries[op],
	compare: op => comparisons[op],
	negate: () => intrinsics.negate,
	truthy: () => truthy,
	toKey: () => intrinsics.toKey,
	tostring: () => tostring,
	format: name => value => intrinsics.format(name, value),
	getpath: () => intrinsics.getpath,
	delpaths: () => intrinsics.delpaths,
	editor: () => value => new intrinsics.Editor(value),
	tryCatch: () => intrinsics.tryCatch,
	isError: () => (error): error is JqError => error instanceof JqError,
	closure: () => intrinsics.closure,
	invalidPath: () => intrinsics.invalidPath,
	breakOut: () => label => {
		throw new Break(label);
	},
	isBreak: () => (error, label) => error instanceof Break && error.label === label,
	pathCall: (fn, ctx) => (path, value, ...args) => intrinsics.pathCall(fn, ctx, path, value, ...args),
	apply: (fn, ctx, ...args) => input => fn.call(ctx, input, ...args),
	applyPath: (fn, ctx, ...args) => (path, value) => intrinsics.pathCall(fn, ctx, path, value, ...args),
	argument: intrinsics.argument,
};
