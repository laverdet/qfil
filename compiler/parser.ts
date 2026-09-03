import type * as ast from './ast.js';

/** A syntax error, located by line and column in the message. */
export class ParseError extends Error {
	override name = 'ParseError';
}

/** Words the grammar reserves; none of them is a call, a field name is another matter. */
const keywords = new Set([
	'and', 'as', 'catch', 'def', 'elif', 'else', 'end', 'foreach', 'if', 'import', 'include', 'label',
	'module', 'or', 'reduce', 'then', 'try', '__loc__',
]);

/** Longest first, so that `peekOperator` never reads a prefix of a longer operator as itself. */
const operators = [
	'?//', '//=',
	'|=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '//', '..',
	'|', ',', '=', '<', '>', '+', '-', '*', '/', '%', '?', '.', '(', ')', '[', ']', '{', '}', ':', ';',
];

const assignOperators: readonly ast.AssignOperator[] = [ '=', '|=', '+=', '-=', '*=', '/=', '%=', '//=' ];
const comparisonOperators: readonly ast.BinaryOperator[] = [ '==', '!=', '<=', '>=', '<', '>' ];

const identifierRegex = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/y;
const numberRegex = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const formatRegex = /@[A-Za-z0-9_]+/y;
/** The rest of a comment: to the end of the line, and on past it when the line ends in an odd number of backslashes, as jq 1.7 has it. */
const commentRegex = /(?:\\\\|\\\r?\n|[^\n])*/y;

function isIdentifierStart(code: number): boolean {
	return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f;
}

function isIdentifierChar(code: number): boolean {
	return isIdentifierStart(code) || (code >= 0x30 && code <= 0x39);
}

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/** Parses a jq program into its syntax tree. Throws {@link ParseError} on malformed input. */
export function parse(source: string): ast.Node {
	return new Parser(source).program();
}

/**
 * A scannerless recursive-descent parser over the source string. Precedence follows jq's grammar,
 * loosest first: `|`, `,`, `//`, assignment, `or`, `and`, comparison, `+ -`, `* / %`, then prefix
 * `-` and `try`, then postfix suffixes (`.foo`, `[…]`, `?`) on a term.
 *
 * `noComma` is set while parsing the value of an object entry — `{a: 1, b: 2}` — where a comma
 * separates entries rather than joining a stream. Every delimited context (parentheses, brackets,
 * `if … end`, call arguments, interpolations) clears it again.
 */
class Parser {
	private readonly source: string;
	private index = 0;
	private noComma = false;

	constructor(source: string) {
		this.source = source;
	}

	program(): ast.Node {
		this.skip();
		if (this.index === this.source.length) {
			throw this.error('Expected a program');
		}
		const node = this.pipe();
		this.skip();
		if (this.index !== this.source.length) {
			throw this.error('Unexpected token');
		}
		return node;
	}

	// pipe := comma ('|' pipe)?
	private pipe(): ast.Node {
		const left = this.noComma ? this.alternative() : this.comma();
		if (this.peekOperator() === '|') {
			++this.index;
			return { type: 'pipe', left, right: this.pipe() };
		}
		return left;
	}

	// comma := binding (',' binding)*
	private comma(): ast.Node {
		let node = this.binding();
		while (this.peekOperator() === ',') {
			++this.index;
			node = { type: 'comma', left: node, right: this.binding() };
		}
		return node;
	}

	// binding := alternative ('as' patterns '|' pipe)?
	// The source of a binding is anything up to a comma or a pipe — jq 1.8 reads
	// `. - 1 as $n | …` as `(. - 1) as $n | …` — and the body runs as far right as it can.
	private binding(): ast.Node {
		const source = this.alternative();
		if (this.acceptKeyword('as')) {
			const patterns = this.patterns();
			this.expect('|');
			return { type: 'bind', source, patterns, body: this.pipe() };
		}
		return source;
	}

	// alternative := assign ('//' alternative)?
	private alternative(): ast.Node {
		const left = this.assign();
		if (this.peekOperator() === '//') {
			this.index += 2;
			return { type: 'alternative', left, right: this.alternative() };
		}
		return left;
	}

	// assign := or (ASSIGN or)?
	private assign(): ast.Node {
		const left = this.or();
		const op = this.peekOperator();
		if (op !== undefined && (assignOperators as readonly string[]).includes(op)) {
			this.index += op.length;
			return { type: 'assign', op: op as ast.AssignOperator, left, right: this.or() };
		}
		return left;
	}

	// or := and ('or' and)*
	private or(): ast.Node {
		let node = this.and();
		while (this.acceptKeyword('or')) {
			node = { type: 'or', left: node, right: this.and() };
		}
		return node;
	}

	// and := comparison ('and' comparison)*
	private and(): ast.Node {
		let node = this.comparison();
		while (this.acceptKeyword('and')) {
			node = { type: 'and', left: node, right: this.comparison() };
		}
		return node;
	}

	// comparison := sum (COMPARISON sum)?
	private comparison(): ast.Node {
		const left = this.sum();
		const op = this.peekOperator();
		if (op !== undefined && (comparisonOperators as readonly string[]).includes(op)) {
			this.index += op.length;
			return { type: 'binary', op: op as ast.BinaryOperator, left, right: this.sum() };
		}
		return left;
	}

	// sum := product (('+' | '-') product)*
	private sum(): ast.Node {
		let node = this.product();
		while (true) {
			const op = this.peekOperator();
			if (op === '+' || op === '-') {
				++this.index;
				node = { type: 'binary', op, left: node, right: this.product() };
			} else {
				return node;
			}
		}
	}

	// product := unary (('*' | '/' | '%') unary)*
	private product(): ast.Node {
		let node = this.unary();
		while (true) {
			const op = this.peekOperator();
			if (op === '*' || op === '/' || op === '%') {
				++this.index;
				node = { type: 'binary', op, left: node, right: this.unary() };
			} else {
				return node;
			}
		}
	}

	// unary := '-' unary | 'try' unary ('catch' unary)? | postfix
	// `try` binds tighter than every binary operator, as in jq: `try a + b` is `(try a) + b`.
	private unary(): ast.Node {
		if (this.peekOperator() === '-') {
			++this.index;
			return { type: 'negate', operand: this.unary() };
		} else if (this.acceptKeyword('try')) {
			const body = this.unary();
			const handler = this.acceptKeyword('catch') ? this.unary() : null;
			return { type: 'try', body, handler };
		}
		return this.postfix();
	}

	// postfix := term suffix*
	// suffix := FIELD | '.' string | '.'? '[' … ']' | '?'
	private postfix(): ast.Node {
		let node = this.term();
		while (true) {
			this.skip();
			const code = this.source.charCodeAt(this.index);
			if (code === 0x2e /* . */) {
				const next = this.source.charCodeAt(this.index + 1);
				if (isIdentifierStart(next)) {
					++this.index;
					node = { type: 'index', target: node, key: { type: 'literal', value: this.identifier() } };
				} else if (next === 0x22 /* " */) {
					++this.index;
					node = { type: 'index', target: node, key: this.string(null) };
				} else if (next === 0x5b /* [ */) {
					this.index += 2;
					node = this.bracket(node);
				} else {
					break;
				}
			} else if (code === 0x5b /* [ */) {
				++this.index;
				node = this.bracket(node);
			} else if (this.peekOperator() === '?') {
				++this.index;
				node = { type: 'try', body: node, handler: null };
			} else {
				break;
			}
		}
		return node;
	}

	// The inside of `[…]` after a term, the `[` consumed: an iteration, an index or a slice.
	private bracket(target: ast.Node): ast.Node {
		return this.delimited(() => {
			if (this.accept(']')) {
				return { type: 'iterate', target };
			} else if (this.accept(':')) {
				const to = this.pipe();
				this.expect(']');
				return { type: 'slice', target, from: null, to };
			}
			const from = this.pipe();
			if (this.accept(':')) {
				const to = this.accept(']') ? null : function(this: Parser) {
					const node = this.pipe();
					this.expect(']');
					return node;
				}.call(this);
				return { type: 'slice', target, from, to };
			}
			this.expect(']');
			return { type: 'index', target, key: from };
		});
	}

	private term(): ast.Node {
		this.skip();
		const { source } = this;
		const at = this.index;
		const code = source.charCodeAt(at);
		switch (code) {
			case 0x2e: { // .
				const next = source.charCodeAt(at + 1);
				if (next === 0x2e) {
					this.index += 2;
					return { type: 'recurse' };
				} else if (isDigit(next)) {
					return this.number();
				} else if (isIdentifierStart(next)) {
					++this.index;
					return { type: 'index', target: { type: 'identity' }, key: { type: 'literal', value: this.identifier() } };
				} else if (next === 0x22 /* " */) {
					++this.index;
					return { type: 'index', target: { type: 'identity' }, key: this.string(null) };
				} else if (next === 0x5b /* [ */) {
					this.index += 2;
					return this.bracket({ type: 'identity' });
				}
				++this.index;
				return { type: 'identity' };
			}
			case 0x22: // "
				return this.string(null);
			case 0x40: { // @
				const name = this.match(formatRegex) ?? (() => {
					throw this.error('Expected format name');
				})();
				if (this.peek('"')) {
					return this.string(name.slice(1));
				}
				return { type: 'format', name: name.slice(1), at };
			}
			case 0x28: { // (
				++this.index;
				const node = this.delimited(() => this.pipe());
				this.expect(')');
				return node;
			}
			case 0x5b: { // [
				++this.index;
				if (this.accept(']')) {
					return { type: 'array', body: null };
				}
				const body = this.delimited(() => this.pipe());
				this.expect(']');
				return { type: 'array', body };
			}
			case 0x7b: // {
				++this.index;
				return this.object();
			case 0x24: { // $
				++this.index;
				const name = this.identifier();
				if (name === '__loc__') {
					return { type: 'loc', line: this.lineOf(at) };
				}
				return { type: 'variable', name, at };
			}
		}
		if (isDigit(code)) {
			return this.number();
		} else if (isIdentifierStart(code)) {
			const name = this.identifier();
			switch (name) {
				case 'if': return this.if();
				case 'reduce': return this.reduce();
				case 'foreach': return this.foreach();
				case 'label': return this.label();
				case 'def': return this.def(at);
				case 'break': {
					this.expect('$');
					return { type: 'break', name: this.identifier(), at };
				}
				case 'import': case 'include': case 'module':
					throw this.error(`\`${name}\` is not supported`, at);
			}
			if (keywords.has(name)) {
				throw this.error(`Unexpected keyword \`${name}\``, at);
			}
			return this.call(name, at);
		}
		throw this.error(this.index === source.length ? 'Unexpected end of input' : 'Expected expression');
	}

	// call := IDENT ('(' pipe (';' pipe)* ')')?
	// `true`, `false` and `null` are identifiers that name constants, as in jq.
	private call(name: string, at: number): ast.Node {
		if (this.accept('(')) {
			const args = this.delimited(() => this.separated(';', () => this.pipe()));
			this.expect(')');
			return { type: 'call', name, args, at };
		}
		switch (name) {
			case 'true': return { type: 'literal', value: true };
			case 'false': return { type: 'literal', value: false };
			case 'null': return { type: 'literal', value: null };
			default: return { type: 'call', name, args: [], at };
		}
	}

	// if := 'if' pipe 'then' pipe ('elif' pipe 'then' pipe)* ('else' pipe)? 'end'
	private if(): ast.Node {
		return this.delimited(() => {
			const condition = this.pipe();
			this.expectKeyword('then');
			const then = this.pipe();
			const otherwise = function(this: Parser): ast.Node | null {
				if (this.acceptKeyword('elif')) {
					return this.if();
				} else if (this.acceptKeyword('else')) {
					const node = this.pipe();
					this.expectKeyword('end');
					return node;
				}
				this.expectKeyword('end');
				return null;
			}.call(this);
			return { type: 'if', condition, then, else: otherwise };
		});
	}

	// reduce := 'reduce' alternative 'as' patterns '(' pipe ';' pipe ')'
	// The source is as wide as a binding's: `reduce .[] + 1 as $x (…)` folds over `.[] + 1`.
	private reduce(): ast.Node {
		const source = this.alternative();
		this.expectKeyword('as');
		const patterns = this.patterns();
		this.expect('(');
		const [ init, update ] = this.delimited(() => this.separated(';', () => this.pipe()));
		this.expect(')');
		if (init === undefined || update === undefined) {
			throw this.error('`reduce` takes an initial value and an update: `reduce … as $x (init; update)`');
		}
		return { type: 'reduce', source, patterns, init, update };
	}

	// foreach := 'foreach' alternative 'as' patterns '(' pipe ';' pipe (';' pipe)? ')'
	private foreach(): ast.Node {
		const source = this.alternative();
		this.expectKeyword('as');
		const patterns = this.patterns();
		this.expect('(');
		const [ init, update, extract ] = this.delimited(() => this.separated(';', () => this.pipe()));
		this.expect(')');
		if (init === undefined || update === undefined) {
			throw this.error('`foreach` takes an initial value and an update: `foreach … as $x (init; update; extract)`');
		}
		return { type: 'foreach', source, patterns, init, update, extract: extract ?? null };
	}

	// label := 'label' '$' IDENT '|' pipe
	private label(): ast.Node {
		this.expect('$');
		const name = this.identifier();
		this.expect('|');
		return { type: 'label', name, body: this.pipe() };
	}

	// def := 'def' IDENT ('(' param (';' param)* ')')? ':' pipe ';' pipe
	// The definition scopes over everything after the `;`, to the end of the enclosing expression.
	private def(at: number): ast.Node {
		const name = this.identifier();
		const params = this.accept('(')
			? this.delimited(() => this.separated(';', () => {
				const value = this.accept('$');
				return { name: this.identifier(), value };
			}))
			: [];
		if (params.length > 0) {
			this.expect(')');
		}
		this.expect(':');
		const body = this.delimited(() => this.pipe());
		this.expect(';');
		this.skip();
		if (this.index === this.source.length) {
			throw this.error('Top-level program not given (try ".")');
		}
		return { type: 'def', name, params, body, rest: this.pipe(), at };
	}

	// object := '{' (entry (',' entry)*)? '}'
	// entry := '$' IDENT (':' value)? | IDENT (':' value)? | string (':' value)? | '(' pipe ')' ':' value
	// value := pipe, with `,` reserved for separating entries
	private object(): ast.Node {
		const entries = this.delimited(() => {
			if (this.peek('}')) {
				return [];
			}
			return this.separated(',', () => this.objectEntry());
		});
		this.expect('}');
		return { type: 'object', entries };
	}

	private objectEntry(): ast.ObjectEntry {
		this.skip();
		const at = this.index;
		const code = this.source.charCodeAt(at);
		if (code === 0x24 /* $ */) {
			++this.index;
			const name = this.identifier();
			if (name === '__loc__') {
				return { key: { type: 'literal', value: '__loc__' }, value: { type: 'loc', line: this.lineOf(at) } };
			} else if (this.accept(':')) {
				// `{$k: v}` keys by the variable's value
				return { key: { type: 'variable', name, at }, value: this.objectValue() };
			}
			return { key: { type: 'literal', value: name }, value: { type: 'variable', name, at } };
		} else if (code === 0x28 /* ( */) {
			++this.index;
			const key = this.delimited(() => this.pipe());
			this.expect(')');
			this.expect(':');
			return { key, value: this.objectValue() };
		}
		const key = function(this: Parser): ast.Node {
			if (code === 0x22 /* " */) {
				return this.string(null);
			} else if (code === 0x40 /* @ */) {
				const name = this.match(formatRegex) ?? (() => {
					throw this.error('Expected format name');
				})();
				return this.string(name.slice(1));
			} else if (isIdentifierStart(code)) {
				// Keywords are fine as keys: `{if: 1}`
				return { type: 'literal', value: this.identifier() };
			}
			throw this.error('Expected object key');
		}.call(this);
		return { key, value: this.accept(':') ? this.objectValue() : null };
	}

	private objectValue(): ast.Node {
		const saved = this.noComma;
		this.noComma = true;
		const node = this.pipe();
		this.noComma = saved;
		return node;
	}

	// patterns := pattern ('?//' pattern)*
	private patterns(): readonly ast.Pattern[] {
		const patterns = [ this.pattern() ];
		while (this.peekOperator() === '?//') {
			this.index += 3;
			patterns.push(this.pattern());
		}
		return patterns;
	}

	// pattern := '$' IDENT | '[' pattern (',' pattern)* ']' | '{' objectPattern (',' objectPattern)* '}'
	private pattern(): ast.Pattern {
		if (this.accept('$')) {
			return { type: 'variable', name: this.identifier() };
		} else if (this.accept('[')) {
			const elements = this.delimited(() => this.separated(',', () => this.pattern()));
			this.expect(']');
			return { type: 'array', elements };
		} else if (this.accept('{')) {
			const entries = this.delimited(() => this.separated(',', () => this.objectPattern()));
			this.expect('}');
			return { type: 'object', entries };
		}
		throw this.error('Expected pattern');
	}

	// objectPattern := '$' IDENT (':' pattern)? | IDENT ':' pattern | string ':' pattern | '(' pipe ')' ':' pattern
	private objectPattern(): ast.ObjectPatternEntry {
		this.skip();
		const code = this.source.charCodeAt(this.index);
		if (code === 0x24 /* $ */) {
			++this.index;
			const name = this.identifier();
			const pattern = this.accept(':') ? this.pattern() : null;
			return { key: { type: 'literal', value: name }, bind: name, pattern };
		}
		const key = function(this: Parser): ast.Node {
			if (code === 0x28 /* ( */) {
				++this.index;
				const node = this.delimited(() => this.pipe());
				this.expect(')');
				return node;
			} else if (code === 0x22 /* " */) {
				return this.string(null);
			} else if (isIdentifierStart(code)) {
				return { type: 'literal', value: this.identifier() };
			}
			throw this.error('Expected object pattern');
		}.call(this);
		this.expect(':');
		return { key, bind: null, pattern: this.pattern() };
	}

	// string := '"' (char | escape | '\(' pipe ')')* '"'
	private string(format: string | null): ast.Node {
		const { source } = this;
		const start = this.index;
		++this.index;
		const parts: (string | ast.Node)[] = [];
		let text = '';
		while (true) {
			const code = source.charCodeAt(this.index);
			if (Number.isNaN(code)) {
				throw this.error('Unterminated string', start);
			} else if (code === 0x22 /* " */) {
				++this.index;
				break;
			} else if (code === 0x5c /* \ */) {
				const escape = source.charCodeAt(this.index + 1);
				this.index += 2;
				switch (escape) {
					case 0x22: text += '"'; break;
					case 0x5c: text += '\\'; break;
					case 0x2f: text += '/'; break;
					case 0x62: text += '\b'; break;
					case 0x66: text += '\f'; break;
					case 0x6e: text += '\n'; break;
					case 0x72: text += '\r'; break;
					case 0x74: text += '\t'; break;
					case 0x75: { // u
						const hex = source.slice(this.index, this.index + 4);
						if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
							throw this.error('Invalid \\u escape', this.index - 2);
						}
						text += String.fromCharCode(parseInt(hex, 16));
						this.index += 4;
						break;
					}
					case 0x28: { // (
						if (text !== '') {
							parts.push(text);
							text = '';
						}
						parts.push(this.delimited(() => this.pipe()));
						this.expect(')');
						break;
					}
					default:
						throw this.error('Invalid escape', this.index - 2);
				}
			} else {
				text += source[this.index]!;
				++this.index;
			}
		}
		if (text !== '' || parts.length === 0) {
			parts.push(text);
		}
		if (format === null && parts.length === 1 && typeof parts[0] === 'string') {
			return { type: 'literal', value: parts[0] };
		}
		return { type: 'string', format, parts };
	}

	private number(): ast.Node {
		const text = this.match(numberRegex) ?? (() => {
			throw this.error('Expected number');
		})();
		return { type: 'literal', value: Number(text), text };
	}

	private identifier(): string {
		this.skip();
		return this.match(identifierRegex) ?? (() => {
			throw this.error('Expected identifier');
		})();
	}

	// One or more of `item`, separated by `separator`
	private separated<Type>(separator: string, item: () => Type): Type[] {
		const items = [ item() ];
		while (this.accept(separator)) {
			items.push(item());
		}
		return items;
	}

	// Runs `fn` in a delimited context, where a comma is a comma again
	private delimited<Type>(fn: () => Type): Type {
		const saved = this.noComma;
		this.noComma = false;
		const result = fn();
		this.noComma = saved;
		return result;
	}

	private match(regex: RegExp): string | undefined {
		regex.lastIndex = this.index;
		const text = regex.exec(this.source)?.[0];
		if (text !== undefined) {
			this.index += text.length;
		}
		return text;
	}

	private skip(): void {
		const { source } = this;
		while (this.index < source.length) {
			const code = source.charCodeAt(this.index);
			if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
				++this.index;
			} else if (code === 0x23 /* # */) {
				++this.index;
				this.match(commentRegex);
			} else {
				return;
			}
		}
	}

	private peekOperator(): string | undefined {
		this.skip();
		return operators.find(op => this.source.startsWith(op, this.index));
	}

	private peek(text: string): boolean {
		this.skip();
		return this.source.startsWith(text, this.index);
	}

	private accept(text: string): boolean {
		if (this.peek(text)) {
			this.index += text.length;
			return true;
		}
		return false;
	}

	private expect(text: string): void {
		if (!this.accept(text)) {
			throw this.error(`Expected \`${text}\``);
		}
	}

	private peekKeyword(word: string): boolean {
		return this.peek(word) && !isIdentifierChar(this.source.charCodeAt(this.index + word.length));
	}

	private acceptKeyword(word: string): boolean {
		if (this.peekKeyword(word)) {
			this.index += word.length;
			return true;
		}
		return false;
	}

	private expectKeyword(word: string): void {
		if (!this.acceptKeyword(word)) {
			throw this.error(`Expected \`${word}\``);
		}
	}

	private lineOf(at: number): number {
		let line = 1;
		for (let ii = 0; ii < at; ++ii) {
			if (this.source.charCodeAt(ii) === 0x0a) {
				++line;
			}
		}
		return line;
	}

	private error(message: string, at = this.index): ParseError {
		const line = this.lineOf(at);
		const column = at - this.source.lastIndexOf('\n', at - 1);
		return new ParseError(`${message} at line ${line}, column ${column}`);
	}
}
