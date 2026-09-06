/**
 * Numbers: the mathematical functions JavaScript itself speaks — the `Math` namespace, with C's
 * rounding kept for `round` — and the number predicates. The C library's extended tail (`frexp`,
 * `ldexp`, the gamma family, `nearbyint` and kin) is the jq flavour's own, in `runtime/jq/math.ts`.
 */
import type { LibFunction } from '#/compiler/filter.js';
import { assertNumber, tabled, tabled2, unary } from '#/runtime/lang/library.js';

/** The functions of the input alone that `Math` speaks. */
const unaryOf = {
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
	round: Math.round,
	sin: Math.sin,
	sinh: Math.sinh,
	sqrt: Math.sqrt,
	tan: Math.tan,
	tanh: Math.tanh,
	trunc: Math.trunc,
};

/** The functions of two arguments that `Math` speaks. */
const binaryOf = {
	atan2: Math.atan2,
	hypot: Math.hypot,
	pow: (base: number, exponent: number) => base ** exponent,
};

export const { abs, acos, acosh, asin, asinh, atan, atanh, cbrt, ceil, cos, cosh, exp, expm1, fabs, floor, log, log10, log1p, log2, round, sin, sinh, sqrt, tan, tanh, trunc } = tabled(unaryOf);
export const { atan2, hypot, pow } = tabled2(binaryOf);

export const infinite: LibFunction = _render => () => Infinity;
export const nan: LibFunction = _render => () => NaN;
export const isnan = unary(input => Number.isNaN(assertNumber(input, 'isnan')));
export const isinfinite = unary(input => {
	const value = assertNumber(input, 'isinfinite');
	return !Number.isFinite(value) && !Number.isNaN(value);
});
export const isfinite = unary(input => Number.isFinite(assertNumber(input, 'isfinite')));
export const isnormal = unary(input => {
	const value = assertNumber(input, 'isnormal');
	return value !== 0 && Number.isFinite(value) && Math.abs(value) >= 2 ** -1022;
});
