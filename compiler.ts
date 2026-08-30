/**
 * Renders a parsed filter as JavaScript.
 *
 * Every expression of the language is a generator of zero or more values, and the obvious
 * rendering — a generator function per node, `yield*` between them — costs an iterator per node
 * per value. Instead each node is rendered in continuation-passing style: a node receives an
 * `emit` that renders whatever consumes its outputs, and produces statements that run that code
 * once per output, inline. `.[] | select(.a) | .b` becomes one `for` loop with an `if` in it.
 *
 * What lets that be compact is knowing, before rendering, how many outputs a node has. That is a
 * node's {@link Shape}, and it is the "spec" of the language: `expr` for a node that is exactly one
 * value and can be written as a JavaScript expression, `single` for exactly one value that needs
 * statements, and `stream` for anything else. The shape is computed against a scope, since a call
 * has whatever shape its definition has, and it lives only for the compilation: a rendered
 * function carries its shape implicitly, in being a generator function or not.
 *
 * Path expressions — the left of `|=`, the argument of `path` — are rendered a second way, where
 * every output is a `[path, value]` pair. Both renderings read the same syntax tree.
 */
import type * as ast from './ast.js';
import type { Lib } from './lib/intrinsics.js';
import { lib as defaultLib } from './lib/index.js';
import { closures, isFormat, isStream } from './lib/intrinsics.js';
import { parse } from './parser.js';

export class CompileError extends Error {
	override name = 'CompileError';
}

export interface CompileOptions {
	/** The library of named functions; the default one unless given. */
	readonly lib?: Lib;
}

/**
 * How many outputs a node has, and how it renders: an `expr` is one JavaScript expression yielding
 * one value; a `single` is statements yielding one value; a `stream` is statements yielding any
 * number. Each includes the ones before it.
 */
export type Shape = 'expr' | 'single' | 'stream';

export interface Rendered {
	/** A factory expression: `(rt, lib, ctx) => filter`, over a runtime, a library and a context. */
	readonly code: string;
	readonly shape: Shape;
}

const rank: Readonly<Record<Shape, number>> = { expr: 0, single: 1, stream: 2 };

function join(...shapes: readonly Shape[]): Shape {
	return shapes.reduce((left, right) => rank[left] >= rank[right] ? left : right, 'expr');
}

/** Renders what consumes one output, given the expression that yields it. */
type Emit = (value: string) => string;

/** The same, for a path expression: the path so far and the value at it. Both are names. */
type PathEmit = (path: string, value: string) => string;

type Mode = 'value' | 'path';

/** A function defined in the language: `def name(params): body;`. */
interface JqFunction {
	readonly kind: 'jq';
	readonly def: ast.Def;
	/** Where the definition sits: what its body can see, besides its own parameters. */
	readonly scope: Scope;
	/** A recursive definition compiles to a JavaScript function; any other is inlined where called. */
	readonly recursive: boolean;
}

/** A filter argument of an inlined call: the argument's syntax, in the scope it was written in. */
interface ClosureBinding {
	readonly kind: 'closure';
	readonly node: ast.Node;
	readonly scope: Scope;
}

/** A filter parameter of a compiled function: a JavaScript closure yielding a stream. */
interface ParamBinding {
	readonly kind: 'param';
	readonly js: string;
}

/** A library function: which of its parameters are filters, and whether it is a stream. */
interface BuiltinBinding {
	readonly kind: 'builtin';
	readonly key: string;
	readonly closures: readonly number[];
	readonly stream: boolean;
}

type FuncBinding = JqFunction | ClosureBinding | ParamBinding | BuiltinBinding;

/**
 * A builtin the compiler renders itself, because it needs its arguments as syntax rather than
 * as values: to stop iterating them (`first`, `limit`), to read them as paths (`path`), or to
 * loop rather than recurse (`until`).
 */
/**
 * What names mean at a point of the program. Variables map to JavaScript names, functions to
 * bindings, labels to the name holding the label object. Shapes are
 * memoized here since a node's shape depends on what its names resolve to.
 */
class Scope {
	readonly parent: Scope | null;
	readonly vars = new Map<string, string>();
	readonly funcs = new Map<string, FuncBinding>();
	readonly labels = new Map<string, string>();
	readonly shapes = new Map<ast.Node, Shape>();
	readonly defs = new Map<ast.Def, JqFunction>();

	constructor(parent: Scope | null) {
		this.parent = parent;
	}

	child(): Scope {
		return new Scope(this);
	}

	variable(name: string): string | undefined {
		return this.vars.get(name) ?? this.parent?.variable(name);
	}

	func(key: string): FuncBinding | undefined {
		return this.funcs.get(key) ?? this.parent?.func(key);
	}

	label(name: string): string | undefined {
		return this.labels.get(name) ?? this.parent?.label(name);
	}
}

/** Per-compilation state of a compiled (recursive) function. */
interface FunctionState {
	readonly names: { value?: string; path?: string };
	shape?: Shape;
	readonly pending: Mode[];
	readonly rendered: string[];
	/** While a returning function's body is rendered: what makes a self-call there a tail call. */
	tail: TailPosition | undefined;
}

/**
 * A function's own return, and the names its next iteration would rebind. A self-call rendered
 * against exactly this `emit` is the function's last act, and becomes a jump to the top instead of
 * a deeper frame — which is what lets a filter recurse as far as it likes.
 */
interface TailPosition {
	readonly emit: Emit;
	readonly label: string;
	readonly input: string;
	readonly params: readonly string[];
	used: boolean;
}

const identifierRegex = /^[A-Za-z_$][\w$]*$/;
const literalRegex = /^(?:-?\d[\w.]*|"(?:[^"\\]|\\.)*"|null|true|false|Infinity)$/;

/** Whether a rendered expression may be evaluated any number of times: a name or a literal. */
function isTrivial(js: string): boolean {
	return identifierRegex.test(js) || literalRegex.test(js);
}

function isTrivialNode(node: ast.Node): boolean {
	return node.type === 'identity' || node.type === 'literal' || node.type === 'variable' || node.type === 'loc';
}

/** Whether a node always yields a boolean, so that `truthy` need not be asked. */
function isBoolean(node: ast.Node): boolean {
	if (node.type === 'binary') {
		return node.op !== '+' && node.op !== '-' && node.op !== '*' && node.op !== '/' && node.op !== '%';
	} else if (node.type === 'literal') {
		return typeof node.value === 'boolean';
	}
	return node.type === 'and' || node.type === 'or';
}

function literal(value: ast.Scalar): string {
	return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function sanitize(name: string): string {
	return name.replace(/[^\w$]/g, '_');
}

/** Whether a call's argument at a position is a filter, passed as a closure, rather than a value. */
function isClosureParam(binding: BuiltinBinding | JqFunction, ii: number): boolean {
	return binding.kind === 'builtin' ? binding.closures.includes(ii) : !binding.def.params[ii]!.value;
}

/** The items of a comma chain, in order. */
function flattenComma(node: ast.Node): ast.Node[] {
	return node.type === 'comma' ? [ ...flattenComma(node.left), ...flattenComma(node.right) ] : [ node ];
}

/** Every variable a pattern binds. */
function patternVariables(pattern: ast.Pattern, into: string[] = []): string[] {
	switch (pattern.type) {
		case 'variable':
			into.push(pattern.name);
			break;
		case 'array':
			for (const element of pattern.elements) {
				patternVariables(element, into);
			}
			break;
		case 'object':
			for (const entry of pattern.entries) {
				if (entry.bind !== null) {
					into.push(entry.bind);
				}
				if (entry.pattern !== null) {
					patternVariables(entry.pattern, into);
				}
			}
			break;
	}
	return into;
}

/**
 * Whether a definition refers to itself — directly, or through a definition nested in its body,
 * which is inlined into it. Only such a definition needs to be a function; the rest inline.
 */
function isRecursive(def: ast.Def): boolean {
	const key = `${def.name}/${def.params.length}`;
	const shadowed = new Set(def.params.map(param => `${param.name}/0`));
	return references(def.body, key, shadowed);
}

function references(node: ast.Node, key: string, shadowed: ReadonlySet<string>): boolean {
	const any = (...nodes: readonly (ast.Node | null)[]) => nodes.some(child => child !== null && references(child, key, shadowed));
	const inPattern = (pattern: ast.Pattern): boolean => {
		switch (pattern.type) {
			case 'variable': return false;
			case 'array': return pattern.elements.some(inPattern);
			case 'object': return pattern.entries.some(entry => any(entry.key) || (entry.pattern !== null && inPattern(entry.pattern)));
		}
	};
	switch (node.type) {
		case 'identity': case 'recurse': case 'literal': case 'format': case 'variable': case 'loc': case 'break':
			return false;
		case 'string':
			return node.parts.some(part => typeof part !== 'string' && references(part, key, shadowed));
		case 'index': return any(node.target, node.key);
		case 'slice': return any(node.target, node.from, node.to);
		case 'iterate': return any(node.target);
		case 'negate': return any(node.operand);
		case 'label': return any(node.body);
		case 'try': return any(node.body, node.handler);
		case 'pipe': case 'comma': case 'binary': case 'and': case 'or': case 'alternative': case 'assign':
			return any(node.left, node.right);
		case 'if': return any(node.condition, node.then, node.else);
		case 'reduce': return any(node.source, node.init, node.update) || inPattern(node.pattern);
		case 'foreach': return any(node.source, node.init, node.update, node.extract) || inPattern(node.pattern);
		case 'bind': return any(node.source, node.body) || node.patterns.some(inPattern);
		case 'call': {
			const callKey = `${node.name}/${node.args.length}`;
			return (callKey === key && !shadowed.has(callKey)) || node.args.some(arg => references(arg, key, shadowed));
		}
		case 'def': {
			const innerKey = `${node.name}/${node.params.length}`;
			const inBody = new Set([ ...shadowed, innerKey, ...node.params.map(param => `${param.name}/0`) ]);
			return references(node.body, key, inBody) || references(node.rest, key, new Set([ ...shadowed, innerKey ]));
		}
		case 'array': return any(node.body);
		case 'object': return node.entries.some(entry => any(entry.key, entry.value));
	}
}

/** A path with one more key on the end; `[]` needs no spreading. */
function extend(path: string, key: string): string {
	return path === '[]' ? `[${key}]` : `[...${path}, ${key}]`;
}

const nullLiteral: ast.Literal = { type: 'literal', value: null };
const identity: ast.Identity = { type: 'identity' };

export function render(source: string, options: CompileOptions = {}): Rendered {
	return new Compiler(source, options).render();
}

class Compiler {
	private readonly source: string;
	private readonly lib: Lib;
	private temps = 0;
	/** The prologue: what the factory computes once, by the expression computing it. */
	private readonly thunks = new Map<string, string>();
	private readonly functions = new Map<JqFunction, FunctionState>();

	constructor(source: string, options: CompileOptions) {
		this.source = source;
		this.lib = options.lib ?? defaultLib;
	}

	render(): Rendered {
		const program = parse(this.source);
		const scope = new Scope(null);
		const shape = this.shape(program, scope);
		const input = 'input';
		const body = shape === 'stream'
			? `function* (${input}) {\n${this.stream(program, input, scope, value => `yield ${value};`)}\n}`
			: `function (${input}) {\n${this.stream(program, input, scope, value => `return ${value};`)}\n}`;
		// Everything the body needs from the runtime, the library and the context is resolved here,
		// once; the body refers only to these names
		const prologue = [ ...this.thunks ].map(([ expression, name ]) => `const ${name} = ${expression};`);
		const code = `(rt, lib, ctx) => {\n${prologue.join('\n')}\nreturn ${body};\n}`;
		return { code, shape };
	}

	temp(): string {
		return `_${++this.temps}`;
	}

	/**
	 * The name of a value the factory computes once, up front — a runtime function specialised to
	 * what is known statically (`rt.field("a")`), a library function bound to the context, an
	 * argument. Two uses of the same expression share the one name.
	 */
	thunk(expression: string): string {
		const existing = this.thunks.get(expression);
		if (existing !== undefined) {
			return existing;
		}
		const name = this.temp();
		this.thunks.set(expression, name);
		return name;
	}

	// -- Shape analysis --

	shape(node: ast.Node, scope: Scope): Shape {
		const memo = scope.shapes.get(node);
		if (memo !== undefined) {
			return memo;
		}
		const shape = this.computeShape(node, scope);
		scope.shapes.set(node, shape);
		return shape;
	}

	// -- Expressions --

	/** Renders a node of `expr` shape as one JavaScript expression of its one value. */
	expr(node: ast.Node, input: string, scope: Scope): string {
		switch (node.type) {
			case 'identity':
				return input;
			case 'literal':
				return literal(node.value);
			case 'variable':
				return this.lookupVariable(node, scope);
			case 'loc':
				return `({ file: "<top-level>", line: ${node.line} })`;
			case 'format':
				this.checkFormat(node.name, node.at);
				return `${this.thunk(`rt.format(${JSON.stringify(node.name)})`)}(${input})`;
			case 'string':
				return this.stringExpr(node, node.parts.map(part => typeof part === 'string' ? part : { js: this.expr(part, input, scope) }));
			case 'index':
				return this.indexExpr(this.expr(node.target, input, scope), node.key, input, scope);
			case 'slice':
				return `${this.thunk('rt.slice()')}(${this.expr(node.target, input, scope)}, ${this.expr(node.from ?? nullLiteral, input, scope)}, ${this.expr(node.to ?? nullLiteral, input, scope)})`;
			case 'pipe':
				return this.expr(node.right, this.expr(node.left, input, scope), scope);
			case 'binary':
				return this.binaryExpr(node.op, this.expr(node.left, input, scope), this.expr(node.right, input, scope));
			case 'and':
				return `(${this.test(node.left, input, scope)} && ${this.test(node.right, input, scope)})`;
			case 'or':
				return `(${this.test(node.left, input, scope)} || ${this.test(node.right, input, scope)})`;
			case 'negate':
				return `${this.thunk('rt.negate()')}(${this.expr(node.operand, input, scope)})`;
			case 'if':
				return `(${this.test(node.condition, input, scope)} ? ${this.expr(node.then, input, scope)} : ${this.expr(node.else ?? identity, input, scope)})`;
			case 'array':
				return node.body === null ? '[]' : `[${flattenComma(node.body).map(item => this.expr(item, input, scope)).join(', ')}]`;
			case 'object':
				return `({ __proto__: null, ${node.entries.map(entry => this.objectEntryExpr(entry, input, scope)).join(', ')} })`;
			case 'def':
				return this.expr(node.rest, input, this.defBinding(node, scope).scope);
			case 'call':
				return this.callExpr(node, input, scope);
			case 'recurse': case 'iterate': case 'try': case 'comma': case 'alternative': case 'assign':
			case 'reduce': case 'foreach': case 'bind': case 'label': case 'break':
				throw new Error(`Not an expression: ${node.type}`);
		}
	}

	// -- Streams --

	/**
	 * Renders a node as statements that run `emit` once per output. The expression handed to `emit`
	 * is evaluated exactly once, where the emitted code begins; `emit` binds it to a name if it
	 * needs it more than once.
	 */
	stream(node: ast.Node, input: string, scope: Scope, emit: Emit): string {
		if (this.shape(node, scope) === 'expr' && !this.isTailCall(node, scope, emit)) {
			return emit(this.expr(node, input, scope));
		}
		switch (node.type) {
			case 'string':
				return this.streamString(node, input, scope, emit);
			case 'index':
				// The key is evaluated first and varies slowest, as jq has it
				return this.each(node.key, input, scope, key =>
					this.each(node.target, input, scope, target =>
						emit(key.startsWith('"') ? `${this.thunk(`rt.field(${key})`)}(${target})` : `${this.thunk('rt.index()')}(${target}, ${key})`)));
			case 'slice':
				return this.each(node.from ?? nullLiteral, input, scope, from =>
					this.each(node.to ?? nullLiteral, input, scope, to =>
						this.each(node.target, input, scope, target =>
							emit(`${this.thunk('rt.slice()')}(${target}, ${from}, ${to})`))));
			case 'iterate': {
				const element = this.temp();
				return this.each(node.target, input, scope, target =>
					`for (const ${element} of ${this.thunk('rt.iterate()')}(${target})) {\n${emit(element)}\n}`);
			}
			case 'recurse': {
				const value = this.temp();
				return `for (const ${value} of ${this.thunk('rt.recurse()')}(${input})) {\n${emit(value)}\n}`;
			}
			case 'try':
				return this.streamTry(node, input, scope, emit);
			case 'pipe':
				return this.each(node.left, input, scope, left => this.stream(node.right, left, scope, emit));
			case 'comma':
				return this.streamComma(flattenComma(node), input, scope, emit);
			case 'binary':
				// The right operand varies slowest, as jq has it
				return this.each(node.right, input, scope, right =>
					this.each(node.left, input, scope, left => emit(this.binaryExpr(node.op, left, right))));
			case 'and': case 'or':
				return this.streamLogical(node, input, scope, emit);
			case 'alternative':
				return this.streamAlternative(node, input, scope, emit);
			case 'negate':
				return this.each(node.operand, input, scope, operand => emit(`${this.thunk('rt.negate()')}(${operand})`));
			case 'assign':
				return this.streamAssign(node, input, scope, emit);
			case 'if':
				return this.streamIf(node, input, scope, emit);
			case 'reduce':
				return this.streamReduce(node, input, scope, emit);
			case 'foreach':
				return this.streamForeach(node, input, scope, emit);
			case 'bind':
				return this.streamBind(node, input, scope, emit);
			case 'def':
				return this.streamDef(node, scope, inner => this.stream(node.rest, input, inner, emit));
			case 'call':
				return this.streamCall(node, input, scope, emit);
			case 'array': {
				const array = this.temp();
				return `{ const ${array} = [];\n${this.stream(node.body!, input, scope, value => `${array}.push(${value});`)}\n${emit(array)} }`;
			}
			case 'object':
				return this.streamObject(node, input, scope, emit);
			case 'label':
				return this.streamLabel(node, scope, inner => this.stream(node.body, input, inner, emit));
			case 'break':
				return `${this.thunk('rt.breakOut()')}(${this.lookupLabel(node, scope)});`;
			case 'identity': case 'literal': case 'variable': case 'loc': case 'format':
				throw new Error(`Always an expression: ${node.type}`);
		}
	}

	/** Runs `then` once per output of a node, with the output bound to a name usable any number of times. */
	each(node: ast.Node, input: string, scope: Scope, then: (value: string) => string): string {
		const bind = (value: string) => {
			if (isTrivial(value)) {
				return then(value);
			}
			const name = this.temp();
			return `{ const ${name} = ${value};\n${then(name)} }`;
		};
		if (this.shape(node, scope) === 'expr') {
			return bind(this.expr(node, input, scope));
		}
		return this.stream(node, input, scope, bind);
	}

	/** Binds each output of each argument, first argument varying slowest, then renders `then` with their names. */
	valueArgs(args: readonly ast.Node[], input: string, scope: Scope, then: (values: string[]) => string): string {
		const go = (ii: number, values: string[]): string => ii === args.length
			? then(values)
			: this.each(args[ii]!, input, scope, value => go(ii + 1, [ ...values, value ]));
		return go(0, []);
	}

	// -- Paths --

	/**
	 * Renders a node as a path expression: statements running `emit` once per output with the path
	 * to it from the root and the value there. `path` and `value` name the input's own.
	 */
	path(node: ast.Node, path: string, value: string, scope: Scope, emit: PathEmit): string {
		switch (node.type) {
			case 'identity':
				return emit(path, value);
			case 'recurse': {
				const pair = this.temp();
				return `for (const ${pair} of ${this.thunk('rt.recursePaths()')}(${path}, ${value})) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
			}
			case 'index':
				return this.each(node.key, value, scope, key =>
					this.path(node.target, path, value, scope, (pp, vv) => {
						const next = this.temp();
						const read = key.startsWith('"') ? `${this.thunk(`rt.field(${key})`)}(${vv})` : `${this.thunk('rt.index()')}(${vv}, ${key})`;
						return `{ const ${next} = ${read};\n${emit(extend(pp, key), next)} }`;
					}));
			case 'slice':
				return this.each(node.from ?? nullLiteral, value, scope, from =>
					this.each(node.to ?? nullLiteral, value, scope, to =>
						this.path(node.target, path, value, scope, (pp, vv) => {
							const next = this.temp();
							return `{ const ${next} = ${this.thunk('rt.slice()')}(${vv}, ${from}, ${to});\n${emit(extend(pp, `{ start: ${from}, end: ${to} }`), next)} }`;
						})));
			case 'iterate':
				return this.path(node.target, path, value, scope, (pp, vv) => {
					const key = this.temp();
					const next = this.temp();
					return `for (const ${key} of ${this.thunk('rt.keysOf()')}(${vv})) {\nconst ${next} = ${vv}[${key}];\n${emit(extend(pp, key), next)}\n}`;
				});
			case 'pipe':
				return this.path(node.left, path, value, scope, (pp, vv) => this.path(node.right, pp, vv, scope, emit));
			case 'comma':
				return this.fanOutPath(each => flattenComma(node).map(item => this.path(item, path, value, scope, each)).join('\n'), emit);
			case 'if':
				return this.pathIf(node, path, value, scope, emit);
			case 'alternative': {
				const found = this.temp();
				return this.fanOutPath(each => {
					const left = this.path(node.left, path, value, scope, (pp, vv) =>
						`if (${this.thunk('rt.truthy()')}(${vv})) {\n${found} = true;\n${each(pp, vv)}\n}`);
					return `{ let ${found} = false;\n${left}\nif (!${found}) {\n${this.path(node.right, path, value, scope, each)}\n} }`;
				}, emit);
			}
			case 'try':
				return this.pathTry(node, path, value, scope, emit);
			case 'bind': {
				if (node.patterns.length !== 1) {
					return this.invalidPath(node, value, scope);
				}
				return this.each(node.source, value, scope, source =>
					this.pattern(node.patterns[0]!, source, value, scope, 'const', inner => this.path(node.body, path, value, inner, emit)));
			}
			case 'def':
				return this.streamDef(node, scope, inner => this.path(node.rest, path, value, inner, emit));
			case 'call':
				return this.pathCall(node, path, value, scope, emit);
			case 'label':
				return this.streamLabel(node, scope, inner => this.path(node.body, path, value, inner, emit));
			case 'break':
				return this.stream(node, value, scope, () => '');
			case 'literal': case 'string': case 'format': case 'variable': case 'loc': case 'binary': case 'and': case 'or':
			case 'negate': case 'assign': case 'reduce': case 'foreach': case 'array': case 'object':
				return this.invalidPath(node, value, scope);
		}
	}

	// -- Naming --

	/** Whether a node is a call of the function being rendered, in its tail position: not an expression but a jump. */
	private isTailCall(node: ast.Node, scope: Scope, emit: Emit): boolean {
		if (node.type !== 'call') {
			return false;
		}
		const binding = this.lookupFunction(node, scope);
		return binding.kind === 'jq' && binding.recursive && this.functionState(binding).tail?.emit === emit;
	}

	private error(message: string, at?: number): CompileError {
		if (at === undefined) {
			return new CompileError(message);
		}
		const line = this.source.slice(0, at).split('\n').length;
		const column = at - this.source.lastIndexOf('\n', at - 1);
		return new CompileError(`${message} at line ${line}, column ${column}`);
	}

	// -- Bindings --

	private lookupVariable(node: ast.Variable, scope: Scope): string {
		const found = scope.variable(node.name);
		if (found !== undefined) {
			return found;
		} else if (node.name === 'ENV') {
			return this.thunk('ctx.env');
		}
		return this.thunk(`rt.argument(ctx.args, ${JSON.stringify(node.name)})`);
	}

	/** A call's binding: a definition in scope, else a library function. */
	private lookupFunction(node: ast.Call, scope: Scope): FuncBinding {
		const key = `${node.name}/${node.args.length}`;
		const local = scope.func(key);
		if (local !== undefined) {
			return local;
		}
		const fn = this.lib[key];
		if (fn !== undefined) {
			return { kind: 'builtin', key, closures: fn[closures] ?? [], stream: isStream(fn) };
		}
		throw this.error(`${key} is not defined`, node.at);
	}

	private lookupLabel(node: ast.Break, scope: Scope): string {
		return scope.label(node.name) ?? (() => {
			throw this.error(`$*label-${node.name} is not defined`, node.at);
		})();
	}

	private defBinding(node: ast.Def, scope: Scope): JqFunction {
		const existing = scope.defs.get(node);
		if (existing !== undefined) {
			return existing;
		}
		const inner = scope.child();
		const binding: JqFunction = { kind: 'jq', def: node, scope: inner, recursive: isRecursive(node) };
		inner.funcs.set(`${node.name}/${node.params.length}`, binding);
		scope.defs.set(node, binding);
		return binding;
	}

	/**
	 * The scope an inlined call's body is rendered in: the definition's own scope, plus its
	 * parameters. Filter parameters bind to the argument syntax; value parameters bind to the
	 * names in `values`, which the caller has bound to each argument's outputs in turn.
	 */
	private callScope(binding: JqFunction, node: ast.Call, caller: Scope, values: readonly string[]): Scope {
		const scope = binding.scope.child();
		let valueIndex = 0;
		for (const [ ii, param ] of binding.def.params.entries()) {
			const arg = node.args[ii]!;
			if (param.value) {
				const js = values[valueIndex++]!;
				scope.vars.set(param.name, js);
				scope.funcs.set(`${param.name}/0`, { kind: 'closure', node: { type: 'variable', name: param.name, at: node.at }, scope });
			} else {
				scope.funcs.set(`${param.name}/0`, { kind: 'closure', node: arg, scope: caller });
			}
		}
		return scope;
	}

	private valueParams(binding: BuiltinBinding | JqFunction, node: ast.Call): ast.Node[] {
		return node.args.filter((_arg, ii) => !isClosureParam(binding, ii));
	}

	private functionState(binding: JqFunction): FunctionState {
		const existing = this.functions.get(binding);
		if (existing !== undefined) {
			return existing;
		}
		const state: FunctionState = { names: {}, pending: [], rendered: [], tail: undefined };
		this.functions.set(binding, state);
		return state;
	}

	/** The JavaScript name of a compiled function in a mode, queueing it for rendering on first use. */
	private requestFunction(binding: JqFunction, mode: Mode): string {
		const state = this.functionState(binding);
		const existing = state.names[mode];
		if (existing !== undefined) {
			return existing;
		}
		const name = `f$${sanitize(binding.def.name)}_${++this.temps}${mode === 'path' ? '$p' : ''}`;
		state.names[mode] = name;
		state.pending.push(mode);
		return name;
	}

	/** Renders every requested mode of a function, and whatever those request in turn. */
	private flush(binding: JqFunction): string {
		const state = this.functionState(binding);
		while (state.pending.length > 0) {
			const mode = state.pending.shift()!;
			state.rendered.push(this.renderFunction(binding, mode));
		}
		return state.rendered.splice(0).join('\n');
	}

	/** The shape of a compiled function's *call*: an expression if it returns, a stream if it yields. */
	private functionShape(binding: JqFunction): Shape {
		const state = this.functionState(binding);
		if (state.shape !== undefined) {
			return state.shape;
		}
		// Optimistically an expression while its own body is analysed; a self-call reads this, and
		// since a body's shape only grows with its calls', one pass settles it.
		state.shape = 'expr';
		const { scope } = this.functionScope(binding);
		const shape = this.shape(binding.def.body, scope);
		state.shape = shape === 'stream' ? 'stream' : 'expr';
		return state.shape;
	}

	/** The scope a compiled function's body is rendered in, with its parameters as JavaScript names. */
	private functionScope(binding: JqFunction): { scope: Scope; params: string[] } {
		const scope = binding.scope.child();
		const params: string[] = [];
		for (const param of binding.def.params) {
			if (param.value) {
				const js = `$${sanitize(param.name)}_${++this.temps}`;
				scope.vars.set(param.name, js);
				scope.funcs.set(`${param.name}/0`, { kind: 'closure', node: { type: 'variable', name: param.name, at: binding.def.at }, scope });
				params.push(js);
			} else {
				const js = `g$${sanitize(param.name)}_${++this.temps}`;
				scope.funcs.set(`${param.name}/0`, { kind: 'param', js });
				params.push(js);
			}
		}
		return { scope, params };
	}

	private renderFunction(binding: JqFunction, mode: Mode): string {
		const name = this.requestFunction(binding, mode);
		const { scope, params } = this.functionScope(binding);
		if (mode === 'path') {
			const path = this.temp();
			const value = this.temp();
			const body = this.path(binding.def.body, path, value, scope, (pp, vv) => `yield [${pp}, ${vv}];`);
			return `function* ${name}(${[ path, value, ...params ].join(', ')}) {\n${body}\n}`;
		}
		const input = this.temp();
		if (this.functionShape(binding) === 'stream') {
			const body = this.stream(binding.def.body, input, scope, value => `yield ${value};`);
			return `function* ${name}(${[ input, ...params ].join(', ')}) {\n${body}\n}`;
		}
		const state = this.functionState(binding);
		const tail: TailPosition = { emit: value => `return ${value};`, label: `T${this.temp()}`, input, params, used: false };
		state.tail = tail;
		const body = this.stream(binding.def.body, input, scope, tail.emit);
		state.tail = undefined;
		const looped = tail.used ? `${tail.label}: while (true) {\n${body}\n}` : body;
		return `function ${name}(${[ input, ...params ].join(', ')}) {\n${looped}\n}`;
	}

	// -- Shape analysis --

	private computeShape(node: ast.Node, scope: Scope): Shape {
		const of = (child: ast.Node | null) => child === null ? 'expr' : this.shape(child, scope);
		switch (node.type) {
			case 'identity': case 'literal': case 'variable': case 'loc': case 'format':
				return 'expr';
			case 'string':
				return join(...node.parts.map(part => typeof part === 'string' ? 'expr' : of(part)));
			case 'index':
				return join(of(node.target), of(node.key));
			case 'slice':
				return join(of(node.target), of(node.from), of(node.to));
			case 'iterate': case 'recurse': case 'comma': case 'foreach': case 'label': case 'break':
				return 'stream';
			case 'try': {
				const body = of(node.body);
				if (body === 'stream' || node.handler === null) {
					return 'stream';
				}
				return join('single', of(node.handler));
			}
			case 'pipe': {
				const shape = join(of(node.left), of(node.right));
				if (shape === 'expr' && !isTrivialNode(node.left) && this.inputUses(node.right, scope) > 1) {
					// Inlining the left into each use of `.` would evaluate it more than once
					return 'single';
				}
				return shape;
			}
			case 'binary': case 'and': case 'or':
				return join(of(node.left), of(node.right));
			case 'alternative':
				return join('single', of(node.left), of(node.right));
			case 'negate':
				return of(node.operand);
			case 'assign':
				return node.op === '|=' || of(node.right) !== 'stream' ? 'single' : 'stream';
			case 'if':
				return join(of(node.condition), of(node.then), of(node.else));
			case 'reduce':
				return of(node.init) === 'stream' ? 'stream' : 'single';
			case 'bind': {
				const keys = node.patterns.flatMap(pattern => this.patternKeys(pattern));
				if (node.patterns.length > 1 || keys.some(key => of(key) === 'stream')) {
					return 'stream';
				}
				return join('single', of(node.source), of(node.body));
			}
			case 'def': {
				const binding = this.defBinding(node, scope);
				// A recursive definition declares a function, which takes a statement
				return join(binding.recursive ? 'single' : 'expr', this.shape(node.rest, binding.scope));
			}
			case 'call':
				return this.callShape(node, scope);
			case 'array':
				return node.body === null || flattenComma(node.body).every(item => of(item) === 'expr') ? 'expr' : 'single';
			case 'object': {
				const shapes = node.entries.flatMap(entry => {
					const key = of(entry.key);
					if (entry.value === null) {
						// The shorthand's value indexes by the key, which must then be a name to reuse
						return [ entry.key.type === 'literal' ? key : join('single', key) ];
					}
					return [ key, of(entry.value) ];
				});
				return join(...shapes);
			}
		}
	}

	private patternKeys(pattern: ast.Pattern): ast.Node[] {
		switch (pattern.type) {
			case 'variable': return [];
			case 'array': return pattern.elements.flatMap(element => this.patternKeys(element));
			case 'object': return pattern.entries.flatMap(entry => [
				...entry.key.type === 'literal' ? [] : [ entry.key ],
				...entry.pattern === null ? [] : this.patternKeys(entry.pattern),
			]);
		}
	}

	private callShape(node: ast.Call, scope: Scope): Shape {
		const binding = this.lookupFunction(node, scope);
		switch (binding.kind) {
			case 'closure':
				return this.shape(binding.node, binding.scope);
			case 'param':
				return 'stream';
			case 'builtin': {
				const args = node.args.filter((_arg, ii) => !binding.closures.includes(ii)).map(arg => this.shape(arg, scope));
				return join(binding.stream ? 'stream' : 'expr', ...args);
			}
			case 'jq': {
				const valueArgs = this.valueParams(binding, node);
				const args = join(...valueArgs.map(arg => this.shape(arg, scope)));
				if (binding.recursive) {
					// Within its own body a self-call is a statement, so that a tail call can be a jump
					const own = this.functionState(binding).tail === undefined ? this.functionShape(binding) : 'single';
					return join(own, args);
				}
				const body = this.shape(binding.def.body, this.callScope(binding, node, scope, valueArgs.map(() => '_')));
				// A value argument that is not a name has to be bound to one before the body reads it
				const bound = valueArgs.some(arg => !isTrivialNode(arg)) ? 'single' : 'expr';
				return join(body, args, bound);
			}
		}
	}

	/** How many times a node reads its input, counted conservatively: 2 stands for "more than once". */
	private inputUses(node: ast.Node, scope: Scope): number {
		const of = (child: ast.Node | null) => child === null ? 0 : this.inputUses(child, scope);
		switch (node.type) {
			case 'identity': case 'recurse': case 'format':
				return 1;
			case 'literal': case 'variable': case 'loc': case 'break':
				return 0;
			case 'string':
				return node.parts.reduce<number>((sum, part) => sum + (typeof part === 'string' ? 0 : of(part)), 0);
			case 'index': return of(node.target) + of(node.key);
			case 'slice': return of(node.target) + of(node.from) + of(node.to);
			case 'iterate': return of(node.target);
			case 'negate': return of(node.operand);
			case 'try': return of(node.body);
			case 'pipe': return of(node.left);
			case 'comma': case 'binary': case 'and': case 'or': case 'alternative':
				return of(node.left) + of(node.right);
			case 'assign': return 2;
			case 'if': return of(node.condition) + of(node.then) + (node.else === null ? 1 : of(node.else));
			case 'reduce': case 'foreach': return of(node.source) + of(node.init);
			case 'bind': return of(node.source) + of(node.body);
			case 'def': return of(node.rest);
			case 'label': return of(node.body);
			case 'array': return of(node.body);
			case 'object': return node.entries.reduce((sum, entry) => sum + of(entry.key) + (entry.value === null ? 1 : of(entry.value)), 0);
			case 'call': {
				const binding = this.lookupFunction(node, scope);
				if (binding.kind === 'builtin') {
					return 1 + node.args.reduce((sum, arg, ii) => sum + (binding.closures.includes(ii) ? 0 : of(arg)), 0);
				}
				return 2;
			}
		}
	}

	// -- Expressions --

	/** A node as a JavaScript condition: its truth, or the expression itself when it is a boolean already. */
	private test(node: ast.Node, input: string, scope: Scope): string {
		return isBoolean(node) ? this.expr(node, input, scope) : `${this.thunk('rt.truthy()')}(${this.expr(node, input, scope)})`;
	}

	/** A bound value as a condition; `boolean` says whether it is known to be one. */
	private testValue(value: string, boolean: boolean): string {
		return boolean ? value : `${this.thunk('rt.truthy()')}(${value})`;
	}

	private checkFormat(name: string, at: number): void {
		if (!isFormat(name)) {
			throw this.error(`${name} is not a valid format`, at);
		}
	}

	private stringExpr(node: ast.Str, parts: readonly (string | { js: string })[]): string {
		if (node.format !== null) {
			this.checkFormat(node.format, 0);
		}
		const convert = node.format === null
			? (js: string) => `${this.thunk('rt.tostring()')}(${js})`
			: (js: string) => `${this.thunk(`rt.format(${JSON.stringify(node.format)})`)}(${js})`;
		const pieces = parts.map(part => typeof part === 'string' ? JSON.stringify(part) : convert(part.js));
		return pieces.length === 1 ? pieces[0]! : `(${pieces.join(' + ')})`;
	}

	private indexExpr(target: string, key: ast.Node, input: string, scope: Scope): string {
		if (key.type === 'literal' && typeof key.value === 'string') {
			return `${this.thunk(`rt.field(${JSON.stringify(key.value)})`)}(${target})`;
		} else if (key.type === 'literal' && typeof key.value === 'number') {
			return `${this.thunk(`rt.element(${literal(key.value)})`)}(${target})`;
		}
		return `${this.thunk('rt.index()')}(${target}, ${this.expr(key, input, scope)})`;
	}

	private binaryExpr(op: ast.BinaryOperator, left: string, right: string): string {
		switch (op) {
			case '+': case '-': case '*': case '/': case '%':
				return `${this.thunk(`rt.binary(${JSON.stringify(op)})`)}(${left}, ${right})`;
			case '==': case '!=': case '<': case '<=': case '>': case '>=':
				return `${this.thunk(`rt.compare(${JSON.stringify(op)})`)}(${left}, ${right})`;
		}
	}

	/** A literal key in a rendered object literal, where a bare `__proto__` would set the prototype. */
	private objectKey(key: string): string {
		return key === '__proto__' ? '["__proto__"]' : JSON.stringify(key);
	}

	private objectEntryExpr(entry: ast.ObjectEntry, input: string, scope: Scope): string {
		const { key } = entry;
		if (key.type === 'literal' && typeof key.value === 'string') {
			const value = entry.value === null ? `${this.thunk(`rt.field(${JSON.stringify(key.value)})`)}(${input})` : this.expr(entry.value, input, scope);
			return `${this.objectKey(key.value)}: ${value}`;
		}
		return `[${this.thunk('rt.toKey()')}(${this.expr(key, input, scope)})]: ${this.expr(entry.value!, input, scope)}`;
	}

	private callExpr(node: ast.Call, input: string, scope: Scope): string {
		const binding = this.lookupFunction(node, scope);
		switch (binding.kind) {
			case 'closure':
				return this.expr(binding.node, input, binding.scope);
			case 'builtin': {
				const applied = this.staticApplication(binding, node, scope, 'value');
				return applied === undefined
					? `${this.libThunk(binding)}(${[ input, ...this.callArgs(binding, node, scope, arg => this.expr(arg, input, scope)) ].join(', ')})`
					: `${applied}(${input})`;
			}
			case 'jq':
				if (binding.recursive) {
					const args = this.callArgs(binding, node, scope, arg => this.expr(arg, input, scope));
					return `${this.requestFunction(binding, 'value')}(${[ input, ...args ].join(', ')})`;
				}
				return this.expr(binding.def.body, input, this.callScope(binding, node, scope, this.valueParams(binding, node).map(arg => this.expr(arg, input, scope))));
			case 'param':
				throw new Error('A parameter is never an expression');
		}
	}

	/** A library function bound to the context, once. */
	private libThunk(binding: BuiltinBinding): string {
		return this.thunk(`lib[${JSON.stringify(binding.key)}].bind(ctx)`);
	}

	/** A call's arguments: values rendered by `value`, and filters as closures carrying both modes. */
	private callArgs(binding: BuiltinBinding | JqFunction, node: ast.Call, scope: Scope, value: (arg: ast.Node) => string): string[] {
		return node.args.map((arg, ii) => isClosureParam(binding, ii) ? this.closureArg(arg, scope) : value(arg));
	}

	/** A filter argument as a closure. A constant one — referring to nothing bound in the body — is made once, in the prologue. */
	private closureArg(arg: ast.Node, scope: Scope): string {
		const closure = `${this.thunk('rt.closure()')}(${this.valueClosure(arg, scope)}, ${this.pathClosure(arg, scope)})`;
		return this.captures(arg, scope) ? closure : this.thunk(closure);
	}

	/**
	 * A library call whose arguments are all constants — literals, and closures that capture
	 * nothing — is applied once, in the prologue; this is the name of the filter that results, or
	 * nothing when an argument varies.
	 */
	private staticApplication(binding: BuiltinBinding, node: ast.Call, scope: Scope, mode: Mode): string | undefined {
		const constant = node.args.every((arg, ii) => isClosureParam(binding, ii) ? !this.captures(arg, scope) : arg.type === 'literal');
		if (!constant) {
			return undefined;
		}
		const args = this.callArgs(binding, node, scope, arg => literal((arg as ast.Literal).value));
		return this.thunk(`rt.${mode === 'path' ? 'applyPath' : 'apply'}(${[ `lib[${JSON.stringify(binding.key)}]`, 'ctx', ...args ].join(', ')})`);
	}

	/**
	 * Whether a filter argument refers to anything bound in the program body — a variable, a
	 * parameter, a function declared there, a label — rather than only to its own input and to
	 * constants. One that does not is itself a constant. Constructs that bind names count as
	 * capturing, conservatively; a free variable is an argument, and a constant.
	 */
	private captures(node: ast.Node, scope: Scope): boolean {
		const any = (...children: (ast.Node | null)[]) => children.some(child => child !== null && this.captures(child, scope));
		switch (node.type) {
			case 'identity': case 'recurse': case 'literal': case 'format': case 'loc':
				return false;
			case 'variable':
				return node.name !== 'ENV' && scope.variable(node.name) !== undefined;
			case 'string':
				return node.parts.some(part => typeof part !== 'string' && this.captures(part, scope));
			case 'index': return any(node.target, node.key);
			case 'slice': return any(node.target, node.from, node.to);
			case 'iterate': return any(node.target);
			case 'try': return any(node.body, node.handler);
			case 'pipe': case 'comma': case 'binary': case 'and': case 'or': case 'alternative': case 'assign':
				return any(node.left, node.right);
			case 'negate': return any(node.operand);
			case 'if': return any(node.condition, node.then, node.else);
			case 'array': return any(node.body);
			case 'object': return node.entries.some(entry => any(entry.key, entry.value));
			case 'reduce': case 'foreach': case 'bind': case 'def': case 'label': case 'break':
				return true;
			case 'call': {
				const binding = this.lookupFunction(node, scope);
				switch (binding.kind) {
					case 'param':
						return true;
					case 'closure':
						return this.captures(binding.node, binding.scope);
					case 'builtin':
						return node.args.some(arg => this.captures(arg, scope));
					case 'jq':
						return binding.recursive
							|| binding.def.params.some(param => param.value)
							|| this.captures(binding.def.body, this.callScope(binding, node, scope, []));
				}
			}
		}
	}

	private valueClosure(node: ast.Node, scope: Scope): string {
		const input = this.temp();
		return `function* (${input}) {\n${this.stream(node, input, scope, value => `yield ${value};`)}\n}`;
	}

	private pathClosure(node: ast.Node, scope: Scope): string {
		const path = this.temp();
		const value = this.temp();
		return `function* (${path}, ${value}) {\n${this.path(node, path, value, scope, (pp, vv) => `yield [${pp}, ${vv}];`)}\n}`;
	}

	// -- Streams --

	/**
	 * Renders a construct that must emit at more than one site. When the consumer is small it is
	 * simply repeated; otherwise the sites yield into a generator the consumer reads once.
	 */
	private fanOut(body: (emit: Emit) => string, emit: Emit): string {
		const probe = emit('_probe');
		if (probe.length <= 200) {
			return body(emit);
		}
		const value = this.temp();
		return `for (const ${value} of function* () {\n${body(item => `yield ${item};`)}\n}()) {\n${emit(value)}\n}`;
	}

	private streamString(node: ast.Str, input: string, scope: Scope, emit: Emit): string {
		// The last interpolation varies slowest, as jq has it
		const go = (ii: number, rendered: (string | { js: string })[]): string => {
			if (ii < 0) {
				return emit(this.stringExpr(node, rendered));
			}
			const part = node.parts[ii]!;
			if (typeof part === 'string') {
				return go(ii - 1, [ part, ...rendered ]);
			}
			return this.each(part, input, scope, value => go(ii - 1, [ { js: value }, ...rendered ]));
		};
		return go(node.parts.length - 1, []);
	}

	private streamComma(items: readonly ast.Node[], input: string, scope: Scope, emit: Emit): string {
		if (items.every(item => this.shape(item, scope) === 'expr')) {
			// All expressions: one loop choosing each in turn, which keeps them lazy in order
			const step = this.temp();
			const value = this.temp();
			const cases = items.map((item, ii) => `case ${ii}: ${value} = ${this.expr(item, input, scope)}; break;`);
			return `for (let ${step} = 0; ${step} < ${items.length}; ++${step}) {\nlet ${value};\nswitch (${step}) {\n${cases.join('\n')}\n}\n${emit(value)}\n}`;
		}
		return this.fanOut(each => items.map(item => this.stream(item, input, scope, each)).join('\n'), emit);
	}

	private streamTry(node: ast.Try, input: string, scope: Scope, emit: Emit): string {
		if (node.handler === null && node.body.type === 'iterate' && isTrivialNode(node.body.target)) {
			// `.[]?`: the only error is the iteration's own, so it needs no `try`
			const element = this.temp();
			return `for (const ${element} of ${this.thunk('rt.iterateOptional()')}(${this.expr(node.body.target, input, scope)})) {\n${emit(element)}\n}`;
		}
		const error = this.temp();
		const guard = `if (!${this.thunk('rt.isError()')}(${error})) throw ${error};`;
		const value = this.temp();
		if (this.shape(node.body, scope) !== 'stream' && node.handler === null) {
			const label = `L${this.temp()}`;
			return `${label}: { let ${value};\ntry {\n${this.stream(node.body, input, scope, output => `${value} = ${output};`)}\n} catch (${error}) {\n${guard}\nbreak ${label};\n}\n${emit(value)} }`;
		} else if (this.shape(node.body, scope) !== 'stream' && node.handler !== null && this.shape(node.handler, scope) !== 'stream') {
			return `{ let ${value};\ntry {\n${this.stream(node.body, input, scope, output => `${value} = ${output};`)}\n} catch (${error}) {\n${guard}\n${this.stream(node.handler, `${error}.value`, scope, output => `${value} = ${output};`)}\n}\n${emit(value)} }`;
		}
		const body = this.valueClosure(node.body, scope);
		const handler = node.handler === null ? 'null' : `${error} => ${this.valueClosure(node.handler, scope)}(${error})`;
		return `for (const ${value} of ${this.thunk('rt.tryCatch()')}(${body}(${input}), ${handler})) {\n${emit(value)}\n}`;
	}

	private streamLogical(node: ast.Logical, input: string, scope: Scope, emit: Emit): string {
		return this.fanOut(each => this.each(node.left, input, scope, left => {
			const rest = this.each(node.right, input, scope, right => each(this.testValue(right, isBoolean(node.right))));
			const test = this.testValue(left, isBoolean(node.left));
			return node.type === 'and'
				? `if (${test}) {\n${rest}\n} else {\n${each('false')}\n}`
				: `if (${test}) {\n${each('true')}\n} else {\n${rest}\n}`;
		}), emit);
	}

	/** `a // b`: the truthy outputs of `a`, or those of `b` when there are none. Errors are errors. */
	private streamAlternative(node: ast.Alternative, input: string, scope: Scope, emit: Emit): string {
		const found = this.temp();
		return this.fanOut(each => {
			const left = this.each(node.left, input, scope, value =>
				`if (${this.testValue(value, isBoolean(node.left))}) {\n${found} = true;\n${each(value)}\n}`);
			return `{ let ${found} = false;\n${left}\nif (!${found}) {\n${this.stream(node.right, input, scope, each)}\n} }`;
		}, emit);
	}

	private streamIf(node: ast.If, input: string, scope: Scope, emit: Emit): string {
		const otherwise: ast.Node = node.else ?? identity;
		const body = (each: Emit) => this.each(node.condition, input, scope, condition => {
			const test = this.testValue(condition, isBoolean(node.condition));
			return `if (${test}) {\n${this.stream(node.then, input, scope, each)}\n} else {\n${this.stream(otherwise, input, scope, each)}\n}`;
		});
		return this.fanOut(body, emit);
	}

	private streamReduce(node: ast.Reduce, input: string, scope: Scope, emit: Emit): string {
		const state = this.temp();
		return this.each(node.init, input, scope, init => {
			const loop = this.each(node.source, input, scope, item => this.pattern(node.pattern, item, input, scope, 'const', inner => {
				const current = this.temp();
				const next = this.temp();
				return `{ const ${current} = ${state};\nlet ${next} = null;\n${this.stream(node.update, current, inner, value => `${next} = ${value};`)}\n${state} = ${next}; }`;
			}));
			return `{ let ${state} = ${init};\n${loop}\n${emit(state)} }`;
		});
	}

	private streamForeach(node: ast.Foreach, input: string, scope: Scope, emit: Emit): string {
		const state = this.temp();
		return this.each(node.init, input, scope, init => {
			const loop = this.each(node.source, input, scope, item => this.pattern(node.pattern, item, input, scope, 'const', inner => {
				const current = this.temp();
				return `{ const ${current} = ${state};\n${this.stream(node.update, current, inner, value => {
					const updated = this.temp();
					return `{ const ${updated} = ${value};\n${state} = ${updated};\n${node.extract === null ? emit(updated) : this.stream(node.extract, updated, inner, emit)} }`;
				})} }`;
			}));
			return `{ let ${state} = ${init};\n${loop} }`;
		});
	}

	private streamBind(node: ast.Bind, input: string, scope: Scope, emit: Emit): string {
		if (node.patterns.length === 1) {
			return this.each(node.source, input, scope, value =>
				this.pattern(node.patterns[0]!, value, input, scope, 'const', inner => this.stream(node.body, input, inner, emit)));
		}
		// Destructuring alternatives: every variable of every pattern is in scope, null unless bound
		// by the pattern that matched, and an error under one pattern — while matching or in the
		// body — moves on to the next. The body yields through a generator so that only its own
		// errors count.
		const names = [ ...new Set(node.patterns.flatMap(pattern => patternVariables(pattern))) ];
		const inner = scope.child();
		const declared = names.map(name => {
			const js = `$${sanitize(name)}_${++this.temps}`;
			inner.vars.set(name, js);
			return js;
		});
		const reset = declared.map(js => `${js} = null;`).join(' ');
		const attempt = (ii: number): string => {
			const matched = this.pattern(node.patterns[ii]!, 'source', input, inner, 'assign', () => this.stream(node.body, input, inner, value => `yield ${value};`));
			if (ii === node.patterns.length - 1) {
				return matched;
			}
			const error = this.temp();
			return `try {\n${matched}\n} catch (${error}) {\nif (!${this.thunk('rt.isError()')}(${error})) throw ${error};\n${reset}\n${attempt(ii + 1)}\n}`;
		};
		const value = this.temp();
		return this.each(node.source, input, scope, source =>
			`for (const ${value} of function* (source) {\nlet ${declared.join(' = null, ')} = null;\n${attempt(0)}\n}(${source})) {\n${emit(value)}\n}`);
	}

	/**
	 * Binds a pattern against a value, then renders `then` in the scope of its variables.
	 * `declare` is `const` for fresh bindings and `assign` to set variables already declared.
	 */
	private pattern(pattern: ast.Pattern, value: string, input: string, scope: Scope, declare: 'const' | 'assign', then: (scope: Scope) => string): string {
		switch (pattern.type) {
			case 'variable': {
				if (declare === 'assign') {
					return `${scope.variable(pattern.name)!} = ${value};\n${then(scope)}`;
				}
				const inner = scope.child();
				const js = `$${sanitize(pattern.name)}_${++this.temps}`;
				inner.vars.set(pattern.name, js);
				return `const ${js} = ${value};\n${then(inner)}`;
			}
			case 'array': {
				const go = (ii: number, inner: Scope): string => {
					if (ii === pattern.elements.length) {
						return then(inner);
					}
					const element = this.temp();
					return `{ const ${element} = ${this.thunk(`rt.element(${ii})`)}(${value});\n${this.pattern(pattern.elements[ii]!, element, input, inner, declare, next => go(ii + 1, next))} }`;
				};
				return go(0, scope);
			}
			case 'object': {
				const go = (ii: number, inner: Scope): string => {
					if (ii === pattern.entries.length) {
						return then(inner);
					}
					const entry = pattern.entries[ii]!;
					return this.each(entry.key, input, inner, key => {
						const member = this.temp();
						// `{$a: pattern}` binds the member and destructures it too
						const bind = (next: Scope, rest: (last: Scope) => string) => entry.bind === null
							? rest(next)
							: this.pattern({ type: 'variable', name: entry.bind }, member, input, next, declare, rest);
						const destructure = (next: Scope) => entry.pattern === null
							? go(ii + 1, next)
							: this.pattern(entry.pattern, member, input, next, declare, last => go(ii + 1, last));
						return `{ const ${member} = ${this.thunk('rt.index()')}(${value}, ${key});\n${bind(inner, destructure)} }`;
					});
				};
				return go(0, scope);
			}
		}
	}

	private streamDef(node: ast.Def, scope: Scope, rest: (inner: Scope) => string): string {
		const binding = this.defBinding(node, scope);
		const body = rest(binding.scope);
		// A recursive definition's functions are declared where the definition is, once whatever
		// follows has said which modes it needs
		return binding.recursive ? `${this.flush(binding)}\n${body}` : body;
	}

	private streamLabel(node: ast.Label, scope: Scope, body: (inner: Scope) => string): string {
		const label = this.temp();
		const inner = scope.child();
		inner.labels.set(node.name, label);
		const error = this.temp();
		return `{ const ${label} = {};\ntry {\n${body(inner)}\n} catch (${error}) {\nif (!${this.thunk('rt.isBreak()')}(${error}, ${label})) throw ${error};\n} }`;
	}

	private streamCall(node: ast.Call, input: string, scope: Scope, emit: Emit): string {
		const binding = this.lookupFunction(node, scope);
		switch (binding.kind) {
			case 'closure':
				return this.stream(binding.node, input, binding.scope, emit);
			case 'param': {
				const value = this.temp();
				return `for (const ${value} of ${binding.js}(${input})) {\n${emit(value)}\n}`;
			}
			case 'builtin': {
				const invoke = (call: string) => {
					if (binding.stream) {
						const value = this.temp();
						return `for (const ${value} of ${call}) {\n${emit(value)}\n}`;
					}
					return emit(call);
				};
				const applied = this.staticApplication(binding, node, scope, 'value');
				if (applied !== undefined) {
					return invoke(`${applied}(${input})`);
				}
				return this.valueArgs(this.valueParams(binding, node), input, scope, values => {
					let next = 0;
					const args = this.callArgs(binding, node, scope, () => values[next++]!);
					return invoke(`${this.libThunk(binding)}(${[ input, ...args ].join(', ')})`);
				});
			}
			case 'jq':
				return this.valueArgs(this.valueParams(binding, node), input, scope, values => {
					if (!binding.recursive) {
						return this.stream(binding.def.body, input, this.callScope(binding, node, scope, values), emit);
					}
					let next = 0;
					const args = this.callArgs(binding, node, scope, () => values[next++]!);
					const tail = this.functionState(binding).tail;
					if (tail?.emit === emit) {
						// The function's own last act: rebind its parameters and start over
						tail.used = true;
						const held = args.map(() => this.temp());
						const bindings = held.map((name, ii) => `const ${name} = ${args[ii]};`);
						const rebinds = [ `${tail.input} = ${input};`, ...held.map((name, ii) => `${tail.params[ii]} = ${name};`) ];
						return `{ ${bindings.join(' ')}\n${rebinds.join(' ')}\ncontinue ${tail.label}; }`;
					}
					const call = `${this.requestFunction(binding, 'value')}(${[ input, ...args ].join(', ')})`;
					if (this.functionShape(binding) === 'stream') {
						const value = this.temp();
						return `for (const ${value} of ${call}) {\n${emit(value)}\n}`;
					}
					return emit(call);
				});
		}
	}

	private streamObject(node: ast.ObjectCons, input: string, scope: Scope, emit: Emit): string {
		const go = (ii: number, members: string[]): string => {
			if (ii === node.entries.length) {
				return emit(`({ __proto__: null, ${members.join(', ')} })`);
			}
			const entry = node.entries[ii]!;
			const { key } = entry;
			if (key.type === 'literal' && typeof key.value === 'string') {
				const name = this.objectKey(key.value);
				if (entry.value === null) {
					return go(ii + 1, [ ...members, `${name}: ${this.thunk(`rt.field(${JSON.stringify(key.value)})`)}(${input})` ]);
				}
				return this.each(entry.value, input, scope, value => go(ii + 1, [ ...members, `${name}: ${value}` ]));
			}
			return this.each(key, input, scope, keyValue => {
				const name = this.temp();
				const member = (value: string) => go(ii + 1, [ ...members, `[${name}]: ${value}` ]);
				const rest = entry.value === null
					? member(`${this.thunk('rt.index()')}(${input}, ${name})`)
					: this.each(entry.value, input, scope, member);
				return `{ const ${name} = ${this.thunk('rt.toKey()')}(${keyValue});\n${rest} }`;
			});
		};
		return go(0, []);
	}

	private streamAssign(node: ast.Assign, input: string, scope: Scope, emit: Emit): string {
		const editor = this.temp();
		const path = this.temp();
		const finish = (updates: string) => `{ const ${editor} = ${this.thunk('rt.editor()')}(${input});\n${updates}\n${emit(`${editor}.result()`)} }`;
		if (node.op === '=') {
			return this.each(node.right, input, scope, value =>
				finish(this.path(node.left, '[]', input, scope, (pp, _vv) => `${editor}.set(${pp}, ${value});`)));
		} else if (node.op === '|=') {
			const deletions = this.temp();
			const label = `L${this.temp()}`;
			const current = this.temp();
			const updates = this.path(node.left, '[]', input, scope, (pp, _vv) =>
				`{ const ${path} = ${pp};\n${label}: { const ${current} = ${editor}.get(${path});\n${this.stream(node.right, current, scope, value => `${editor}.set(${path}, ${value});\nbreak ${label};`)}\n${deletions}.push(${path}); } }`);
			return `{ const ${editor} = ${this.thunk('rt.editor()')}(${input});\nconst ${deletions} = [];\n${updates}\n${emit(`${this.thunk('rt.delpaths()')}(${editor}.result(), ${deletions})`)} }`;
		}
		const op = node.op.slice(0, -1) as ast.BinaryOperator | '//';
		return this.each(node.right, input, scope, value => {
			const current = this.temp();
			const updated = op === '//'
				? `${this.thunk('rt.truthy()')}(${current}) ? ${current} : ${value}`
				: this.binaryExpr(op, current, value);
			return finish(this.path(node.left, '[]', input, scope, (pp, _vv) =>
				`{ const ${path} = ${pp};\nconst ${current} = ${editor}.get(${path});\n${editor}.set(${path}, ${updated}); }`));
		});
	}

	// -- Paths --

	/** A node that is not a path expression: evaluated for its value, which the error then names. */
	private invalidPath(node: ast.Node, value: string, scope: Scope): string {
		return this.stream(node, value, scope, output => `${this.thunk('rt.invalidPath()')}(${output});`);
	}

	private fanOutPath(body: (emit: PathEmit) => string, emit: PathEmit): string {
		const probe = emit('_probe', '_probe');
		if (probe.length <= 200) {
			return body(emit);
		}
		const pair = this.temp();
		return `for (const ${pair} of function* () {\n${body((pp, vv) => `yield [${pp}, ${vv}];`)}\n}()) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
	}

	private pathIf(node: ast.If, path: string, value: string, scope: Scope, emit: PathEmit): string {
		const otherwise: ast.Node = node.else ?? identity;
		const body = (each: PathEmit) => this.each(node.condition, value, scope, condition => {
			const test = this.testValue(condition, isBoolean(node.condition));
			return `if (${test}) {\n${this.path(node.then, path, value, scope, each)}\n} else {\n${this.path(otherwise, path, value, scope, each)}\n}`;
		});
		return this.fanOutPath(body, emit);
	}

	private pathTry(node: ast.Try, path: string, value: string, scope: Scope, emit: PathEmit): string {
		if (node.handler === null && node.body.type === 'iterate' && node.body.target.type === 'identity') {
			// `.[]?`, as in value mode
			const key = this.temp();
			const next = this.temp();
			return `for (const ${key} of ${this.thunk('rt.keysOfOptional()')}(${value})) {\nconst ${next} = ${value}[${key}];\n${emit(extend(path, key), next)}\n}`;
		}
		const pair = this.temp();
		const error = this.temp();
		const handler = node.handler === null ? 'null' : `${error} => ${this.pathClosure(node.handler, scope)}(${path}, ${value})`;
		return `for (const ${pair} of ${this.thunk('rt.tryCatch()')}(${this.pathClosure(node.body, scope)}(${path}, ${value}), ${handler})) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
	}

	private pathCall(node: ast.Call, path: string, value: string, scope: Scope, emit: PathEmit): string {
		const binding = this.lookupFunction(node, scope);
		switch (binding.kind) {
			case 'closure':
				return this.path(binding.node, path, value, binding.scope, emit);
			case 'param': {
				const pair = this.temp();
				return `for (const ${pair} of ${binding.js}.path(${path}, ${value})) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
			}
			case 'builtin': {
				const pair = this.temp();
				const applied = this.staticApplication(binding, node, scope, 'path');
				if (applied !== undefined) {
					return `for (const ${pair} of ${applied}(${path}, ${value})) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
				}
				return this.valueArgs(this.valueParams(binding, node), value, scope, values => {
					let next = 0;
					const args = this.callArgs(binding, node, scope, () => values[next++]!);
					return `for (const ${pair} of ${this.thunk(`rt.pathCall(lib[${JSON.stringify(binding.key)}], ctx)`)}(${[ path, value, ...args ].join(', ')})) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
				});
			}
			case 'jq':
				return this.valueArgs(this.valueParams(binding, node), value, scope, values => {
					if (!binding.recursive) {
						return this.path(binding.def.body, path, value, this.callScope(binding, node, scope, values), emit);
					}
					let next = 0;
					const args = this.callArgs(binding, node, scope, () => values[next++]!);
					const pair = this.temp();
					return `for (const ${pair} of ${this.requestFunction(binding, 'path')}(${[ path, value, ...args ].join(', ')})) {\n${emit(`${pair}[0]`, `${pair}[1]`)}\n}`;
				});
		}
	}
}
