/**
 * Numbers: the mathematical functions.
 */
import type { Lib } from '#/compiler/filter.js';
import { assertNumber, unary } from './library.js';
import { values } from '#/compiler/filter.js';

export const math: Lib = {
	floor: unary(input => Math.floor(assertNumber(input, 'floor'))),
	sqrt: unary(input => Math.sqrt(assertNumber(input, 'sqrt'))),
	pow: (render, base, exponent) => values(render, [ base, exponent ], (_input, left, right) => assertNumber(left, 'pow') ** assertNumber(right, 'pow')),
};
