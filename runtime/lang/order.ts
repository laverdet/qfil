/**
 * The functions that put values in order — `sort`, `sort_by`, `group_by`, `unique`, `min`, `max`
 * and their `_by` kin, `bsearch` — over a comparison, since what the order is depends on the
 * flavour: JavaScript's in `runtime/js`, jq's total order in `runtime/jq`. The keys of `sort_by`
 * and `group_by` are `[f]` of each value, compared element by element.
 */
import type { Env, Stream, Value } from '#/compiler/filter.js';
import { assertArray, unary, withFilter } from './library.js';
import { values } from '#/compiler/filter.js';

/** `sort_by(f)` keys: `[f]` of each element. */
function keysBy(values: Value[], filter: Stream, env: Env): Value[] {
	return values.map(value => [ ...filter(value, env) ]);
}

export function ordered(compareValues: (left: Value, right: Value) => number) {
	type Comparison = typeof compareValues;
	const compareKeys: Comparison = (left, right) => {
		const lhs = left as Value[];
		const rhs = right as Value[];
		const length = Math.min(lhs.length, rhs.length);
		for (let ii = 0; ii < length; ++ii) {
			const order = compareValues(lhs[ii]!, rhs[ii]!);
			if (order !== 0) {
				return order;
			}
		}
		return lhs.length - rhs.length;
	};
	// Indices of `items` sorted by their keys, keeping order among equal keys
	const order = (items: Value[], keys: Value[], by: Comparison): number[] =>
		items.map((_value, ii) => ii).sort((left, right) => by(keys[left]!, keys[right]!) || left - right);
	const groups = (items: Value[], keys: Value[], by: Comparison): Value[][] => {
		const result: Value[][] = [];
		let previous: Value | undefined;
		for (const ii of order(items, keys, by)) {
			const key = keys[ii]!;
			if (result.length === 0 || by(previous!, key) !== 0) {
				result.push([]);
				previous = key;
			}
			result[result.length - 1]!.push(items[ii]!);
		}
		return result;
	};
	return {
		sort: unary(input => [ ...assertArray(input, 'sort') ].sort(compareValues)),
		sort_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'sort_by');
			return order(items, keysBy(items, filter, env), compareKeys).map(ii => items[ii]!);
		}),
		group_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'group_by');
			return groups(items, keysBy(items, filter, env), compareKeys);
		}),
		unique: unary(input => {
			const items = assertArray(input, 'unique');
			return groups(items, items, compareValues).map(group => group[0]!);
		}),
		unique_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'unique_by');
			return groups(items, keysBy(items, filter, env), compareKeys).map(group => group[0]!);
		}),
		// The first of equal least elements, and the last of equal greatest, as jq picks them
		min: unary(input => least(assertArray(input, 'min'), assertArray(input, 'min'), compareValues)),
		max: unary(input => greatest(assertArray(input, 'max'), assertArray(input, 'max'), compareValues)),
		min_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'min_by');
			return least(items, keysBy(items, filter, env), compareKeys);
		}),
		max_by: withFilter(filter => (input, env) => {
			const items = assertArray(input, 'max_by');
			return greatest(items, keysBy(items, filter, env), compareKeys);
		}),
		bsearch: values((input, value) => {
			const items = assertArray(input, 'bsearch');
			let lo = 0;
			let hi = items.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				const order = compareValues(items[mid]!, value);
				if (order === 0) {
					return mid;
				} else if (order < 0) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			return -lo - 1;
		}),
	};

	function least(items: Value[], keys: Value[], by: Comparison): Value {
		let found: number | null = null;
		for (let ii = 0; ii < items.length; ++ii) {
			if (found === null || by(keys[ii]!, keys[found]!) < 0) {
				found = ii;
			}
		}
		return found === null ? null : items[found]!;
	}

	function greatest(items: Value[], keys: Value[], by: Comparison): Value {
		let found: number | null = null;
		for (let ii = 0; ii < items.length; ++ii) {
			if (found === null || by(keys[ii]!, keys[found]!) >= 0) {
				found = ii;
			}
		}
		return found === null ? null : items[found]!;
	}
}
