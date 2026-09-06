/**
 * The JavaScript flavour: doubles and their formatting, UTF-16 strings, and JavaScript's truth,
 * order and regex where jq's binary speaks C's.
 */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { differential } from './harness.js';
import * as lib from '#/runtime/js/index.js';
import * as runtime from '#/runtime/js/runtime.js';

const { divergent, run } = differential({ runtime, lib });

describe('number formatting', () => {
	// JavaScript's shortest round-trip formatting; jq preserves literals and formats doubles its own way
	it('writes doubles as JSON does', () => {
		assert.deepEqual(run('[.[] | tojson]', [ 1e-7, 1e21, 0.1, 100, 3.14 ]), [ [ '1e-7', '1e+21', '0.1', '100', '3.14' ] ]);
		assert.deepEqual(run('[.[] | tostring]', [ 1.0, 1.5, 1e100 ]), [ [ '1', '1.5', '1e+100' ] ]);
	});
});

divergent('strings are UTF-16', [
	// jq counts, slices and sorts by code point; these use JavaScript's code units
	[ 'length, .[0:1], ([., "\uffff"] | sort)', '😀', [ 2, '\ud83d', [ '😀', '\uffff' ] ] ],
]);

divergent('order is JavaScript\'s', [
	// Strings order among themselves; anything else subtracts, which is NaN for a container. jq's
	// total order is the jq runtime's, and agrees with the binary in jq.test.ts
	[ '[(null < false), ([] < {}), (true < 0), (1 < "2"), (false < true)]', null, [ [ false, false, false, true, true ] ] ],
	[ 'sort', [ { b: 1 }, { a: 2 } ], [ [ { b: 1 }, { a: 2 } ] ] ],
	[ 'sort', [ 3, '2', 10 ], [ [ '2', 3, 10 ] ] ],
]);

divergent('regular expressions are JavaScript\'s', [
	// Flags are JavaScript's here — the jq runtime reads jq's own — so `s` is dot-all and
	// Oniguruma's `x`, `n`, `l`, `p` do not exist
	[ 'test("a.b";"s")', 'a\nb', [ true ] ],
	[ 'test("a";"x")', 'a', 'error' ],
	// Offsets and lengths count UTF-16 code units
	[ '[match("😀a"; "g") | .offset, .length]', 'x😀a😀a', [ [ 1, 3, 4, 3 ] ] ],
	// An unmatched group has no name in the JavaScript reading, so `capture` drops it; the jq
	// flavour reads names off the pattern source and keeps it
	[ '"b" | capture("(?<x>a)?b?")', null, [ {} ] ],
	[ '"b" | capture("(?<x>a?)?b?")', null, [ {} ] ],
]);

divergent('truth and numbers are JavaScript\'s', [
	// JavaScript's truth: the empty string, 0 and NaN are false; jq's — null and false alone — is the jq runtime's
	[ '[.[] | not]', [ true, false, null, 0, '' ], [ [ false, true, true, true, true ] ] ],
	[ '[.[] | if . then "t" else "f" end]', [ 0, '', 1, [], {} ], [ [ 'f', 'f', 't', 't', 't' ] ] ],
	[ '[(.a // "d"), (.b // "d")]', { a: 0, b: 1 }, [ [ 'd', 1 ] ] ],
	[ '[.[] | toboolean]', [ 'true', 'false', true, false ], [ [ true, true, true, false ] ] ],
	[ 'try toboolean catch "E"', 'nope', [ true ] ],
	// tonumber is Number(): hex and whitespace read, and NaN (null as JSON) where nothing parses
	[ '[.[] | tonumber?]', [ '1', 'x', '2' ], [ [ 1, null, 2 ] ] ],
	[ '[.[] | try tonumber catch "E"]', [ '1', '1.50', ' 1', '1 ', '+1', '.5', '5.', '1e', '1e3', 'nan', '0x1', '', '1_0', '١' ], [ [ 1, 1.5, 1, 1, 1, 0.5, 5, null, 1000, null, 1, 0, null, null ] ] ],
	// IEEE arithmetic: a zero divisor gives an infinity (the largest finite double, as JSON) or NaN, and % is the floating-point remainder
	[ '1 / 0', null, [ 1.7976931348623157e+308 ] ],
	[ '5 % 0', null, [ null ] ],
	[ '5.7 % 2.2', null, [ 1.2999999999999998 ] ],
	[ '[.[] | (1 / .)?]', [ 0, 1 ], [ [ 1.7976931348623157e+308, 1 ] ] ],
	// Math.round rounds halves up; jq rounds them away from zero
	[ '[.[] | round]', [ 2.5, 3.5, -1.5, -2.5, -0.5 ], [ [ 3, 4, -1, -2, 0 ] ] ],
]);

divergent('what only the binary can say', [
	[ 'have_decnum', null, [ false ] ],
	[ 'have_literal_numbers', null, [ false ] ],
	[ 'get_search_list', null, 'error' ],
	[ '1 | j0', null, 'error' ],
	// A ulp astray from this machine's libm, or a -0 the JSON printer cannot spell
	[ '27 | cbrt', null, [ 3 ] ],
	[ '0.5 | atanh', null, [ 0.5493061443340548 ] ],
	[ '2 | acosh', null, [ 1.3169578969248166 ] ],
	[ 'input_filename', null, [ null ] ],
	// `todate` and `fromdate` speak ISO through `Date`: milliseconds written, fractions read
	[ '1425599507 | todate', null, [ '2015-03-05T23:51:47.000Z' ] ],
	[ '"2015-03-05T23:51:47.5Z" | fromdate', null, [ 1425599507.5 ] ],
	[ '1 | todateiso8601', null, 'error' ],
	[ '1 | erf', null, 'error' ],
	[ 'jn(2; 1)', null, 'error' ],
]);
