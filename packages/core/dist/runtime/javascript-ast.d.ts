import { type AnyNode, type Program } from 'acorn';
export type AstNode = AnyNode & Record<string, unknown>;
export declare function parseJavaScriptModule(source: string): AstNode;
/**
 * A program as Node would run it: an ES module, or a CommonJS script (whose
 * top level may `return`); null when it is neither.
 */
export declare function parseJavaScriptProgram(source: string): Program | null;
export declare function hasTopLevelModuleSyntax(source: string): boolean;
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