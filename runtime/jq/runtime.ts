/**
 * A runtime that is jq, numbers and order included: the JavaScript runtime re-exported with what
 * differs declared over it — a number literal keeps its spelling, negation keeps it too, and `<`
 * and its kin use jq's total order. Everything else is the JavaScript runtime's, which is the
 * point: a runtime is a module, and another one is an `export *` away.
 */
import type * as ast from '#/compiler/ast.js';
import type { Handler, Value } from '#/compiler/filter.js';
import { compare, spelled, truthy } from './value.js';
import { combine } from '#/compiler/filter.js';
import { divide, negate as negateNumber } from '#/runtime/lang/intrinsics.js';
import { alternativeOver, assignOver, binaryOver, ifOver, logicalOver, operators, sliceOver } from '#/runtime/lang/runtime.js';
import { JqError, describe, isNumber } from '#/runtime/lang/value.js';

export * from '#/runtime/js/runtime.js';
export { prelude } from './prelude.js';

/** A literal's value: a number keeps how it was written. */
function literalOf(node: ast.Literal): Value {
	return typeof node.value === 'number' && node.text !== undefined ? spelled(node.value, node.text) : node.value;
}

/** Negation keeps the spelling, sign flipped: the string of a boxed number is its text. */
function negated(value: Value): Value {
	if (value instanceof Number) {
		const text = String(value);
		return spelled(-Number(value), text.startsWith('-') ? text.slice(1) : `-${text}`);
	} else {
		return negateNumber(value);
	}
}

/** A slice bound as jq reads it: NaN is no bound at all, as null is. */
function unbounded(value: Value): Value {
	return isNumber(value) && Number.isNaN(Number(value)) ? null : value;
}

// C's intmax_t range, which `%` casts its operands through: [-2^63, 2^63). The top, 2^63 - 1,
// has no double spelling, so the clamp steps back inside in BigInt.
const kIntmaxBound = 2 ** 63;

/** An operand of `%`, through C's cast to intmax: truncated, the infinities clamped to the range's ends. */
function intmax(value: number): bigint {
	const whole = Math.trunc(value);
	if (whole >= kIntmaxBound) {
		return BigInt(kIntmaxBound) - 1n;
	} else if (whole <= -kIntmaxBound) {
		return BigInt(-kIntmaxBound);
	} else {
		return BigInt(whole);
	}
}

/** jq's `%`: C's integer remainder over intmax casts, so an infinite operand clamps rather than poisons. */
function modulo(left: Value, right: Value): Value {
	if (!isNumber(left) || !isNumber(right)) {
		throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided (remainder)`);
	} else if (Number.isNaN(Number(left)) || Number.isNaN(Number(right))) {
		return NaN;
	}
	const divisor = intmax(right);
	if (divisor === 0n) {
		throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided (remainder) because the divisor is zero`);
	}
	return Number(intmax(left) % divisor);
}

export const literal: Handler<ast.Literal> = {
	value: node => {
		const value = literalOf(node);
		return () => value;
	},
};
export const negate: Handler<ast.Negate> = {
	value: (node, render) => combine([ render.filter(node.operand) ], ([ value ]) => negated(value!)),
};
/** jq's `/`: dividing by zero is an error, where JavaScript's gives an infinity. */
function divided(left: Value, right: Value): Value {
	if (isNumber(left) && isNumber(right) && Number(right) === 0) {
		throw new JqError(`${describe(left)} and ${describe(right)} cannot be divided because the divisor is zero`);
	}
	return divide(left, right);
}

const ops = { ...operators(compare), '/': divided, '%': modulo };

export const binary = binaryOver(ops);
export const assign = assignOver(ops, truthy);
export const { and, or } = logicalOver(truthy);
export const alternative = alternativeOver(truthy);
const ifOf = ifOver(truthy);
export { ifOf as if };
export const slice = sliceOver(unbounded);
