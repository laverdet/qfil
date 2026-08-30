/**
 * The syntax tree of a jq filter, as `parse` (parser.ts) produces it and the compiler consumes it.
 *
 * Nodes are plain data. A node type that names something the program may fail to resolve — a
 * function, a variable, a label — carries `at`, the source offset it was parsed from, so the error
 * can say where.
 */

/** A scalar the source spells out directly. Arrays and objects are constructions, not literals. */
export type Scalar = null | boolean | number | string;

export type Node =
	Identity |
	RecurseAll |
	Literal |
	Str |
	Format |
	Index |
	Slice |
	Iterate |
	Try |
	Pipe |
	Comma |
	Binary |
	Logical |
	Alternative |
	Negate |
	Assign |
	If |
	Reduce |
	Foreach |
	Bind |
	Def |
	Call |
	Variable |
	Loc |
	ArrayCons |
	ObjectCons |
	Label |
	Break;

/** `.` */
export interface Identity {
	readonly type: 'identity';
}

/** `..` — every value reachable from the input, itself first. */
export interface RecurseAll {
	readonly type: 'recurse';
}

export interface Literal {
	readonly type: 'literal';
	readonly value: Scalar;
}

/**
 * A string with `\(…)` interpolations, or one under a format (`@base64 "…\(.)…"`). A string with
 * neither parses to a {@link Literal} instead. The format applies to each interpolated value.
 */
export interface Str {
	readonly type: 'string';
	readonly format: string | null;
	readonly parts: readonly (string | Node)[];
}

/** `@base64` and the like, as a filter of the input. */
export interface Format {
	readonly type: 'format';
	readonly name: string;
	readonly at: number;
}

/** `target.key`, `target[key]` — key is a string node for `.foo` and `."foo"`. */
export interface Index {
	readonly type: 'index';
	readonly target: Node;
	readonly key: Node;
}

/** `target[from:to]`; an omitted bound is null. */
export interface Slice {
	readonly type: 'slice';
	readonly target: Node;
	readonly from: Node | null;
	readonly to: Node | null;
}

/** `target[]` */
export interface Iterate {
	readonly type: 'iterate';
	readonly target: Node;
}

/** `try body catch handler`; `body?` is the same with no handler. */
export interface Try {
	readonly type: 'try';
	readonly body: Node;
	readonly handler: Node | null;
}

export interface Pipe {
	readonly type: 'pipe';
	readonly left: Node;
	readonly right: Node;
}

export interface Comma {
	readonly type: 'comma';
	readonly left: Node;
	readonly right: Node;
}

export type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface Binary {
	readonly type: 'binary';
	readonly op: BinaryOperator;
	readonly left: Node;
	readonly right: Node;
}

/** `and` / `or` — short-circuiting, yielding booleans. */
export interface Logical {
	readonly type: 'and' | 'or';
	readonly left: Node;
	readonly right: Node;
}

/** `left // right` */
export interface Alternative {
	readonly type: 'alternative';
	readonly left: Node;
	readonly right: Node;
}

export interface Negate {
	readonly type: 'negate';
	readonly operand: Node;
}

export type AssignOperator = '=' | '|=' | '+=' | '-=' | '*=' | '/=' | '%=' | '//=';

export interface Assign {
	readonly type: 'assign';
	readonly op: AssignOperator;
	readonly left: Node;
	readonly right: Node;
}

/** `if … then … else … end`; `elif` chains parse to nested ifs, and a missing `else` is null. */
export interface If {
	readonly type: 'if';
	readonly condition: Node;
	readonly then: Node;
	readonly else: Node | null;
}

/** `reduce source as pattern ?// pattern … (init; update)` */
export interface Reduce {
	readonly type: 'reduce';
	readonly source: Node;
	readonly patterns: readonly Pattern[];
	readonly init: Node;
	readonly update: Node;
}

/** `foreach source as pattern ?// pattern … (init; update; extract)` */
export interface Foreach {
	readonly type: 'foreach';
	readonly source: Node;
	readonly patterns: readonly Pattern[];
	readonly init: Node;
	readonly update: Node;
	readonly extract: Node | null;
}

/** `source as pattern ?// pattern … | body` */
export interface Bind {
	readonly type: 'bind';
	readonly source: Node;
	readonly patterns: readonly Pattern[];
	readonly body: Node;
}

/** `def name(params): body; rest` */
export interface Def {
	readonly type: 'def';
	readonly name: string;
	readonly params: readonly Param[];
	readonly body: Node;
	readonly rest: Node;
	readonly at: number;
}

/** A function parameter: a filter, or a value when written `$name`. */
export interface Param {
	readonly name: string;
	readonly value: boolean;
}

export interface Call {
	readonly type: 'call';
	readonly name: string;
	readonly args: readonly Node[];
	readonly at: number;
}

export interface Variable {
	readonly type: 'variable';
	readonly name: string;
	readonly at: number;
}

/** `$__loc__` */
export interface Loc {
	readonly type: 'loc';
	readonly line: number;
}

/** `[body]`; `[]` has a null body. */
export interface ArrayCons {
	readonly type: 'array';
	readonly body: Node | null;
}

export interface ObjectCons {
	readonly type: 'object';
	readonly entries: readonly ObjectEntry[];
}

/**
 * One `key: value` of an object construction. A null value is the shorthand `{a}` / `{"a"}` /
 * `{$__loc__}`-style entry whose value is the input indexed by the key, evaluated once.
 */
export interface ObjectEntry {
	readonly key: Node;
	readonly value: Node | null;
}

export interface Label {
	readonly type: 'label';
	readonly name: string;
	readonly body: Node;
}

export interface Break {
	readonly type: 'break';
	readonly name: string;
	readonly at: number;
}

export type Pattern = VariablePattern | ArrayPattern | ObjectPattern;

export interface VariablePattern {
	readonly type: 'variable';
	readonly name: string;
}

export interface ArrayPattern {
	readonly type: 'array';
	readonly elements: readonly Pattern[];
}

export interface ObjectPattern {
	readonly type: 'object';
	readonly entries: readonly ObjectPatternEntry[];
}

/**
 * One entry of an object pattern. `{$a}` binds `a` to `.a`; `{$a: pattern}` does that and also
 * destructures `.a`; `{key: pattern}` only destructures. `key` evaluates to the key string.
 */
export interface ObjectPatternEntry {
	readonly key: Node;
	readonly bind: string | null;
	readonly pattern: Pattern | null;
}
