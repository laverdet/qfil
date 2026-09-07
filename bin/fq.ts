#!/usr/bin/env node
/**
 * `fq` — the filesystem queried as values: `fq [options] <filter> [root...]`. Each root argument
 * is a path to start from, `.` when none; `.[]` of a directory is its entries and `..` walks.
 */
import type { Command } from './cli.js';
import type { Value } from 'qfil/compiler/filter.js';
import process from 'node:process';
import * as runtime from 'qfil/runtime/fs/runtime.js';
import { entry } from 'qfil/runtime/fs/value.js';
import * as lib from 'qfil/runtime/js/index.js';
import { execute } from './cli.js';

const USAGE = `usage: fq [options] <filter> [root...]

  Each root is a path to query, \`.\` when none is given.

  -n, --null-input       use null as the input; the roots are read by \`input\` and \`inputs\`
  -r, --raw-output       write strings without quotes
  -j, --join-output      raw output, without newlines
  -a, --ascii-output     escape non-ASCII characters
  -c, --compact-output   one line per output
  -S, --sort-keys        sort object keys
      --tab              indent with tabs
      --indent <n>       indent with n spaces (default 2)
  -e, --exit-status      exit 1 when the last output is false or null, 4 when there is none
      --arg <name> <value>     bind $name to a string
      --argjson <name> <json>  bind $name to a JSON value
  -h, --help
`;

const fq: Command = {
	name: 'fq',
	usage: USAGE,
	options: {},
	session: (_flags, files) => ({
		options: { runtime, lib },
		inputs: function*(): Iterable<Value> {
			for (const root of files.length === 0 ? [ '.' ] : files) {
				yield entry(root);
			}
		}(),
	}),
};

process.exitCode = await execute(fq, process.argv.slice(2));
