/**
 * A runtime that is jq, numbers and order included: the JavaScript runtime with what differs laid
 * over it — a number literal keeps its spelling, negation keeps it too, and `<` and its kin use
 * jq's total order. Everything else is the JavaScript runtime's, which is the point: a runtime is
 * a value, and another one is a spread away.
 */
import type * as ast from '#/compiler/ast.js';
import type { Runtime, Value } from '#/compiler/filter.js';
import { Spelled, compare, spelled } from './value.js';
import { combine } from '#/compiler/filter.js';
import { negate as negateNumber } from '#/runtime/js/intrinsics.js';
import { binary, runtime as js, operators } from '#/runtime/js/runtime.js';

/** A literal's value: a number keeps how it was written. */
function literal(node: ast.Literal): Value {
	return typeof node.value === 'number' && node.text !== undefined ? spelled(node.value, node.text) : node.value;
}

/** Negation keeps the spelling, sign flipped. */
function negate(value: Value): Value {
	if (value instanceof Spelled) {
		const { text } = value;
		return spelled(-Number(value), text.startsWith('-') ? text.slice(1) : `-${text}`);
	}
	return negateNumber(value);
}

export const runtime: Runtime = {
	...js,
	literal: {
		value: node => {
			const value = literal(node);
			return () => value;
		},
	},
	negate: {
		value: (node, render) => combine([ render.filter(node.operand) ], ([ value ]) => negate(value!)),
	},
	binary: binary(operators(compare)),
};
