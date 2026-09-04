/**
 * The jq flavour's prelude: everything the JavaScript one defines, and what jq tells in its own
 * dialect on top — the date family, as jq itself defines it over `strftime` and `strptime`. The
 * definitions shadow whatever the library inherited under the same names.
 */
import { once } from '#/compiler/filter.js';
import { definitions } from '#/compiler/parser.js';
import { prelude as js } from '#/runtime/js/prelude.js';

export const prelude = once(() => [
	...js(),
	...definitions(`
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def todateiso8601: todate;
def fromdateiso8601: strptime("%Y-%m-%dT%H:%M:%SZ") | mktime;
def fromdate: fromdateiso8601;
`),
]);
