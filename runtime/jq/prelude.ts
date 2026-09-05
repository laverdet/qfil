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
# abs negates through the runtime, so a spelled literal keeps its text: -1E+1000 | abs is 1E+1000,
# and jq's total order decides the branches — a string sits above 0 and passes through
def abs: if . > 0 then . elif . < 0 then - . else 0 end;
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def todateiso8601: todate;
def fromdateiso8601: strptime("%Y-%m-%dT%H:%M:%SZ") | mktime;
def fromdate: fromdateiso8601;
`),
]);
