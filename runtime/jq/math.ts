/**
 * The C library's extended mathematics, the jq flavour's own: rounding to even, the bits of a
 * double, the gamma family by Lanczos, and the scaling functions. What has no reasonable
 * JavaScript telling — the Bessel functions, `erf` — refuses by name. A transcendental's last
 * digit may differ from a libm's; that is within the aim.
 */
import type { LibFunction } from '#/compiler/filter.js';
import { values } from '#/compiler/filter.js';
import { assertNumber, tabled, tabled2, unary } from '#/runtime/lang/library.js';
import { JqError } from '#/runtime/lang/value.js';

const view = new DataView(new ArrayBuffer(8));

/** The nearest integer, ties to even: C's default rounding, `nearbyint` and `rint`. */
function halfEven(value: number): number {
	const low = Math.floor(value);
	const diff = value - low;
	if (diff < 0.5) {
		return low;
	} else if (diff > 0.5) {
		return low + 1;
	} else {
		return low % 2 === 0 ? low : low + 1;
	}
}

/** The fraction in [0.5, 1) and the exponent, read off the bits so nothing rounds. */
function frexpOf(value: number): [ number, number ] {
	if (value === 0 || !Number.isFinite(value)) {
		return [ value, 0 ];
	}
	view.setFloat64(0, value);
	const raw = (view.getUint16(0) >> 4) & 0x7ff;
	const exponent = function() {
		if (raw !== 0) {
			return raw;
		}
		// Subnormal: normalize first, and step the exponent back down
		view.setFloat64(0, value * 2 ** 64);
		return ((view.getUint16(0) >> 4) & 0x7ff) - 64;
	}();
	view.setUint16(0, (view.getUint16(0) & 0x800f) | (1022 << 4));
	return [ view.getFloat64(0), exponent - 1022 ];
}

function logbOf(value: number): number {
	if (value === 0) {
		return -Infinity;
	} else if (Number.isFinite(value)) {
		return frexpOf(value)[1] - 1;
	} else {
		return Math.abs(value);
	}
}

/** n!, by the loop: exact through 18! and correctly rounded for a while after. */
function factorial(count: number): number {
	let result = 1;
	for (let ii = 2; ii <= count; ++ii) {
		result *= ii;
	}
	return result;
}

/** Lanczos coefficients, g = 7. */
const lanczos = [
	0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
	-176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
	1.5056327351493116e-7,
];

/** The Lanczos series and its tail, for arguments of at least 0.5. */
function lanczosParts(value: number): { readonly sum: number; readonly tail: number } {
	const shifted = value - 1;
	let sum = lanczos[0]!;
	for (let ii = 1; ii < lanczos.length; ++ii) {
		sum += lanczos[ii]! / (shifted + ii);
	}
	return { sum, tail: shifted + 7.5 };
}

function tgammaOf(value: number): number {
	if (Number.isInteger(value)) {
		if (value > 0) {
			return value <= 171 ? factorial(value - 1) : Infinity;
		} else {
			return value === 0 ? Infinity : NaN;
		}
	} else if (value < 0.5) {
		// Reflection: Γ(x)Γ(1-x) = π / sin(πx)
		return Math.PI / (Math.sin(Math.PI * value) * tgammaOf(1 - value));
	}
	const { sum, tail } = lanczosParts(value);
	return Math.sqrt(2 * Math.PI) * tail ** (value - 0.5) * Math.exp(-tail) * sum;
}

function lgammaOf(value: number): number {
	if (Number.isInteger(value) && value > 0 && value <= 171) {
		return Math.log(factorial(value - 1));
	} else if (value < 0.5) {
		return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * value))) - lgammaOf(1 - value);
	}
	const { sum, tail } = lanczosParts(value);
	return 0.5 * Math.log(2 * Math.PI) + (value - 0.5) * Math.log(tail) - tail + Math.log(sum);
}

/** The sign of Γ(x): negative only between even and odd negative integers. */
function gammaSign(value: number): number {
	if (value > 0 || Number.isInteger(value)) {
		return 1;
	} else {
		return Math.floor(value) % 2 === 0 ? 1 : -1;
	}
}

/** fmax and fmin pass over a NaN, where Math.max and Math.min would return it. */
function extremum(left: number, right: number, pick: (left: number, right: number) => number): number {
	if (Number.isNaN(left)) {
		return right;
	} else if (Number.isNaN(right)) {
		return left;
	} else {
		return pick(left, right);
	}
}

/** IEEE remainder: the quotient rounds to the nearest integer, ties to even. */
function remainderOf(left: number, right: number): number {
	return left - halfEven(left / right) * right;
}

/** A value scaled by 2^e without overflowing the scale itself: `ldexp` and `scalb`. */
function scale(value: number, exponent: number): number {
	const whole = Math.trunc(exponent);
	const half = Math.trunc(whole / 2);
	return value * 2 ** half * 2 ** (whole - half);
}

/** The next double after the value toward the target, one bit away. */
function nextafterOf(value: number, target: number): number {
	if (Number.isNaN(value) || Number.isNaN(target)) {
		return NaN;
	} else if (value === target) {
		return target;
	} else if (value === 0) {
		return target > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
	}
	view.setFloat64(0, value);
	const bits = view.getBigUint64(0);
	view.setBigUint64(0, (target > value) === (value > 0) ? bits + 1n : bits - 1n);
	return view.getFloat64(0);
}

/** The functions of the input alone. */
const unaryOf = {
	exp2: value => 2 ** value,
	exp10: value => 10 ** value,
	// jq's `gamma` is the log-gamma, as C's historical one was
	gamma: lgammaOf,
	lgamma: lgammaOf,
	logb: logbOf,
	nearbyint: halfEven,
	rint: halfEven,
	significand: value => frexpOf(value)[0] * 2,
	tgamma: tgammaOf,
} satisfies Readonly<Record<string, (value: number) => number>>;

/** The functions of two arguments; the input plays no part, as jq has it. */
const binaryOf = {
	copysign: (value, sign) => sign < 0 || Object.is(sign, -0) ? -Math.abs(value) : Math.abs(value),
	drem: remainderOf,
	fdim: (left, right) => Math.max(left - right, 0),
	fmax: (left, right) => extremum(left, right, Math.max),
	fmin: (left, right) => extremum(left, right, Math.min),
	fmod: (left, right) => left % right,
	ldexp: scale,
	nextafter: nextafterOf,
	nexttoward: nextafterOf,
	remainder: remainderOf,
	scalb: scale,
	scalbln: scale,
} satisfies Readonly<Record<string, (left: number, right: number) => number>>;

/** The functions with no reasonable JavaScript telling refuse by name. */
function unsupported(name: string): () => never {
	return () => {
		throw new JqError(`${name} is not supported`);
	};
}

export const { exp2, exp10, gamma, lgamma, logb, nearbyint, rint, significand, tgamma } = tabled(unaryOf);
export const { copysign, drem, fdim, fmax, fmin, fmod, ldexp, nextafter, nexttoward, remainder, scalb, scalbln } = tabled2(binaryOf);
export const frexp = unary(input => frexpOf(assertNumber(input, 'frexp')));
export const modf = unary(input => {
	const value = assertNumber(input, 'modf');
	const whole = Math.trunc(value);
	return [ value - whole, whole ];
});
export const lgamma_r = unary(input => {
	const value = assertNumber(input, 'lgamma_r');
	return [ lgammaOf(value), gammaSign(value) ];
});
export const fma = values((_input, factor, multiplier, addend) =>
	assertNumber(factor, 'fma') * assertNumber(multiplier, 'fma') + assertNumber(addend, 'fma'));
export const j0 = unary(unsupported('j0'));
export const j1 = unary(unsupported('j1'));
export const y0 = unary(unsupported('y0'));
export const y1 = unary(unsupported('y1'));
export const erf = unary(unsupported('erf'));
export const erfc = unary(unsupported('erfc'));
export const jn: LibFunction = (_render, _n, _x) => unsupported('jn');
export const yn: LibFunction = (_render, _n, _x) => unsupported('yn');
