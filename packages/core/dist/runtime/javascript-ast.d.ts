import { type AnyNode, type Options, type Program, type Token } from 'acorn';
export type AstNode = AnyNode & Record<string, unknown>;
/** How an ES module is parsed. */
export declare const MODULE_PARSE_OPTIONS: Options;
/** How a program Node would run is parsed (as a module, else as a CommonJS script): what either allows. */
export declare const PROGRAM_PARSE_OPTIONS: {
    readonly ecmaVersion: "latest";
    readonly allowHashBang: true;
    readonly allowReturnOutsideFunction: true;
    readonly allowAwaitOutsideFunction: true;
    readonly allowImportExportEverywhere: true;
};
export declare function parseJavaScriptModule(source: string): AstNode;
/**
 * A program as Node would run it: an ES module, or a CommonJS script (whose
 * top level may `return`); null when it is neither.
 */
export declare function parseJavaScriptProgram(source: string): Program | null;
/** What {@link parseStatements} hands over as it parses. */
export interface StatementHooks {
    /** A top-level statement, once parsed; it is not kept. */
    readonly onStatement?: (statement: AstNode) => void;
    /**
     * A node, once finished: its children before it. A function's body is
     * dropped after the function's own call, so what a hook keeps of one is
     * what it took then.
     */
    readonly onNode?: (node: AstNode) => void;
}
/**
 * acorn's parse of `source` with no tree of the whole program held: each
 * top-level statement goes to the hooks as it is parsed and is not kept,
 * and each function's body is dropped once the function is finished (its
 * parameters stay, which acorn checks after). What is held at once is the
 * chain of functions being parsed and their code outside functions, so a
 * multi-MiB bundle parses in bounded memory (acorn's whole tree is 17 to 24
 * times its source). Throws acorn's SyntaxError, as `parse` does.
 */
export declare function parseStatements(source: string, options: Options, hooks: StatementHooks): void;
/** Parentheses, `(0, f)`, `await` and `?.` do not change what is called. */
export declare function unwrapCallee(node: AnyNode): AnyNode;
/** The name of the function a call reaches: `f`, `x.f`, `x['f']`, through {@link unwrapCallee}. */
export declare function calleeName(callee: AnyNode): string | null;
/** The module syntax a token opens: a top-level declaration, or `import.meta` anywhere. */
export type ModuleSyntaxToken = 'import' | 'export' | 'import.meta';
/**
 * The names Node's CommonJS wrapper binds: what a CommonJS module's top level
 * may not redeclare lexically, and what no ES module's scope has.
 */
export declare const COMMONJS_WRAPPER_NAMES: ReadonlySet<string>;
/**
 * Whether Node runs `source`, whose extension and package "type" leave it
 * undecided, as an ES module: Node's syntax detection (doc/api/packages.md
 * "Syntax detection", on by default from v22.7.0), as src/node_contextify.cc
 * ContainsModuleSyntax decides it. Node compiles the source as CommonJS (a
 * file as the body of the wrapper function, whose parameters are the
 * wrapper's names; `--eval` code and stdin, `scope` 'eval', with none) and it
 * is CommonJS if that compiles. Otherwise V8's first error decides: one at
 * an `import` (not `import(`), an `export` or `import.meta` makes it a
 * module; one Node retries (a lexical redeclaration of a wrapper name, and
 * the errors a top-level `await` gives) makes it a module if it compiles as
 * one; any other leaves it CommonJS.
 *
 * Only an `import`, an `export`, `import.meta`, a top-level `await` or a
 * top-level lexical declaration can make the answer a module, so a walk of
 * the tokens answers every other source CommonJS without a parse (a
 * multi-MiB bundle must fit a 48 MiB heap). One that finds a top-level
 * `import` or `export`, or `import.meta`, before either of the others
 * answers module. Where that differs from Node (a syntax error before it;
 * an `import` or `export` nested in a block) the source compiles under
 * neither, and fails either way. The rest are compiled, by acorn in V8's
 * place (commonJsCompileError).
 */
export declare function containsModuleSyntax(source: string, scope?: 'file' | 'eval'): boolean;
/**
 * Whether `source` may hold an `await` outside every function body (a
 * top-level await), read off its tokens: true when one is found, or when the
 * source does not tokenize, so a false answer is certain.
 */
export declare function hasUnscopedAwait(source: string): boolean;
/**
 * Walk `source`'s tokens tracking brace, paren and bracket depth, without
 * building an AST (a multi-MiB bundle chunk must fit a 48 MiB heap). `visit`
 * sees every token with whether it sits at top level and the module syntax
 * it opens: for a top-level `import` or `export` keyword, the declaration
 * (not `import(`), and for an `import` anywhere, `import.meta`; never for a
 * member named so (after `.` or `?.`). `visit` returns true to stop the walk.
 *
 * Returns true when `visit` stopped it, false at the end of the source, and
 * null when the source does not tokenize (as `sourceType` does).
 */
export declare function walkTopLevelModuleTokens(source: string, visit: (token: Token, syntax: ModuleSyntaxToken | null, topLevel: boolean) => boolean, sourceType?: 'module' | 'script'): boolean | null;
/** A replacement of source text `[start, end)` by `text`. */
export interface SourceEdit {
    start: number;
    end: number;
    text: string;
}
/**
 * `source` with `edits` applied, in source order. Edits may come in any
 * order and may insert (start === end), but never overlap: an overlap is a
 * rewrite that lost track of what it replaced, and throws.
 */
export declare function applySourceEdits(source: string, edits: readonly SourceEdit[]): string;
export declare function nodeList(node: AstNode, key: string): AstNode[];
export declare function nodeProp(node: AstNode | undefined, key: string): AstNode | undefined;
export declare function nodeName(node: AstNode | undefined): string | undefined;
export declare function stringField(node: AstNode, key: string): string | undefined;
export declare function booleanField(node: AstNode, key: string): boolean;
export declare function literalStringValue(node: AstNode | undefined): string | undefined;
export declare function literalBooleanValue(node: AstNode | undefined): boolean | undefined;
/**
 * A node of a tree acorn parsed: an object whose `type` is one of acorn's
 * node types. Its other fields are acorn's, which this does not re-check.
 */
export declare function isAstNode(value: unknown): value is AstNode;
/** Each child node of `node`. */
export declare function forEachChild(node: AnyNode, visit: (child: AnyNode) => void): void;
/** Every node below `node`, functions included, in source order. */
export declare function forEachNode(node: AnyNode, visit: (n: AnyNode) => void): void;
//# sourceMappingURL=javascript-ast.d.ts.map