/**
 * The filesystem as values. An entry — a file, a directory — is a plain object of its stat:
 * `path`, `name`, `type`, `size`, `mtime`, with a brand the types cannot spell so the runtime can
 * tell it from data that merely resembles one. Being a plain value, the rest of the language
 * already works on it: `.size` indexes, `select` filters, `sort_by(.mtime)` orders, printing is
 * JSON. What fails down here — a path that is not there, a directory that will not read — is a
 * `JqError`, so the program's own `try` applies.
 */
import type { Value, ValueObject } from '#/compiler/filter.js';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { JqError } from '#/runtime/js/value.js';

const marker: unique symbol = Symbol('jssq.entry');

/** A directory entry as a value: its stat, read once when the entry is made. */
export interface Entry {
	readonly [marker]: true;
	readonly path: string;
	readonly name: string;
	readonly type: 'file' | 'directory' | 'link' | 'other';
	readonly size: number;
	readonly mtime: number;
}

export function isEntry(value: Value): value is Entry & ValueObject {
	return typeof value === 'object' && value !== null && (value as { readonly [marker]?: true })[marker] === true;
}

/** The entry at a path; an `lstat`, so a link is itself, not what it points to. */
export function entry(at: string): Value {
	return make(at, statOf(at));
}

function make(at: string, stat: fs.Stats): Value {
	const type = function(): Entry['type'] {
		if (stat.isFile()) {
			return 'file';
		} else if (stat.isDirectory()) {
			return 'directory';
		} else if (stat.isSymbolicLink()) {
			return 'link';
		}
		return 'other';
	}();
	const made: Entry = { [marker]: true, path: at, name: basename(at) || at, type, size: stat.size, mtime: stat.mtimeMs };
	return Object.assign(Object.create(null), made) as Value;
}

function statOf(at: string): fs.Stats {
	try {
		return fs.lstatSync(at);
	} catch (error) {
		throw new JqError((error as Error).message);
	}
}

/** A directory's entries, in name order, each stat'd as it is read. */
export function *children(parent: Entry): Generator<Value> {
	const names = function() {
		try {
			return fs.readdirSync(parent.path);
		} catch (error) {
			throw new JqError((error as Error).message);
		}
	}();
	for (const name of names.sort()) {
		yield entry(join(parent.path, name));
	}
}

/** An entry and everything beneath it, itself first; links are not followed. */
export function *walk(root: Value): Generator<Value> {
	yield root;
	if (isEntry(root) && root.type === 'directory') {
		for (const child of children(root)) {
			yield* walk(child);
		}
	}
}
