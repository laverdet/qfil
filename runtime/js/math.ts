/**
 * Numbers: the mathematical functions JavaScript itself speaks — the `Math` namespace, with C's
 * rounding kept for `round` — and the number predicates. The C library's extended tail (`frexp`,
 * `ldexp`, the gamma family, `nearbyint` and kin) is the jq flavour's own, in `runtime/jq/math.ts`.
 */
import type { Lib, LibFunction } from '#/compiler/filter.js';
import { assertNumber, unary } from './library.js';
import { values } from '#/compiler/filter.js';

/** A library of functions of the input alone, each named for its error messages. */
export function tabled(fns: Readonly<Record<string, (value: number) => number>>): Lib {
	return Object.fromEntries(Object.entries(fns).map(([ name, fn ]): [ string, LibFunction ] =>
		[ name, unary(input => fn(assertNumber(input, name))) ]));
}

/** As `tabled`, of two arguments; the input plays no part, as jq has it. */
export function tabled2(fns: Readonly<Record<string, (left: number, right: number) => number>>): Lib {
	return Object.fromEntries(Object.entries(fns).map(([ name, fn ]): [ string, LibFunction ] =>
		[ name, (render, left, right) => values(render, [ left, right ], (_input, first, second) => fn(assertNumber(first, name), assertNumber(second, name))) ]));
}

/** The functions of the input alone that `Math` speaks. */
const unaryOf: Readonly<Record<string, (value: number) => number>> = {
	abs: Math.abs,
	acos: Math.acos,
	acosh: Math.acosh,
	asin: Math.asin,
	asinh: Math.asinh,
	atan: Math.atan,
	atanh: Math.atanh,
	cbrt: Math.cbrt,
	ceil: Math.ceil,
	cos: Math.cos,
	cosh: Math.cosh,
	exp: Math.exp,
	expm1: Math.expm1,
	fabs: Math.abs,
	floor: Math.floor,
	log: Math.log,
	log10: Math.log10,
	log1p: Math.log1p,
	log2: Math.log2,
	// C rounds halves away from zero, where JavaScript rounds them up
	round: value => Math.sign(value) * Math.round(Math.abs(value)),
	sin: Math.sin,
	sinh: Math.sinh,
	sqrt: Math.sqrt,
	tan: Math.tan,
	tanh: Math.tanh,
	trunc: Math.trunc,
};

/** The functions of two arguments that `Math` speaks. */
const binaryOf: Readonly<Record<string, (left: number, right: number) => number>> = {
	atan2: Math.atan2,
	hypot: Math.hypot,
	pow: (base, exponent) => base ** exponent,
};

export const math: Lib = {
	...tabled(unaryOf),
	...tabled2(binaryOf),
	infinite: _render => () => Infinity,
	nan: _render => () => NaN,
	isnan: unary(input => Number.isNaN(assertNumber(input, 'isnan'))),
	isinfinite: unary(input => {
		const value = assertNumber(input, 'isinfinite');
		return !Number.isFinite(value) && !Number.isNaN(value);
	}),
	isfinite: unary(input => Number.isFinite(assertNumber(input, 'isfinite'))),
	isnormal: unary(input => {
		const value = assertNumber(input, 'isnormal');
		return value !== 0 && Number.isFinite(value) && Math.abs(value) >= 2 ** -1022;
	}),
};
