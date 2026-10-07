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
/** Whether `source` holds a top-level `import` or `export` declaration. */
export declare function hasTopLevelModuleSyntax(source: string): boolean;
/**
 * Walk `source`'s tokens tracking brace, paren and bracket depth, without
 * building an AST (a multi-MiB bundle chunk must fit a 48 MiB heap). `visit`
 * sees each token with whether it sits at top level and, for a top-level
 * `import` or `export` keyword, which declaration it opens: not `import(`,
 * not `import.meta`, and not a member named so (after `.` or `?.`). The token
 * after an `import` keyword is read to decide that and not visited. `visit`
 * returns true to stop the walk.
 *
 * Returns true when `visit` stopped it, false at the end of the source, and
 * null when the source does not tokenize.
 */
export declare function walkTopLevelModuleTokens(source: string, visit: (token: Token, declaration: 'import' | 'export' | null, topLevel: boolean) => boolean): boolean | null;
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