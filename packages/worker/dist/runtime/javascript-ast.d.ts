import { type AnyNode } from 'acorn';
export type AstNode = AnyNode & Record<string, unknown>;
export declare function parseJavaScriptModule(source: string): AstNode;
/**
 * True iff the module contains a genuine top-level `await` — an
 * `AwaitExpression` (or `for await` loop) with no enclosing function in
 * its ancestor chain. AST-based so default-value parameter braces
 * (`async function f(opts = {})`), destructured params, and
 * arrow-expression bodies can't confuse a brace-depth heuristic.
 *
 * Returns false when parsing fails — callers treat that as "not TLA"
 * and the plain single-pass transform handles it.
 */
export declare function hasTopLevelAwait(source: string): boolean;
export declare function hasTopLevelModuleSyntax(source: string): boolean;
export declare function nodeList(node: AstNode, key: string): AstNode[];
export declare function nodeProp(node: AstNode | undefined, key: string): AstNode | undefined;
export declare function nodeName(node: AstNode | undefined): string | undefined;
export declare function stringField(node: AstNode, key: string): string | undefined;
export declare function booleanField(node: AstNode, key: string): boolean;
export declare function literalStringValue(node: AstNode | undefined): string | undefined;
export declare function literalBooleanValue(node: AstNode | undefined): boolean | undefined;
export declare function isAstNode(value: unknown): value is AstNode;
//# sourceMappingURL=javascript-ast.d.ts.map