import { type AnyNode } from 'acorn';
export type AstNode = AnyNode & Record<string, unknown>;
export declare function parseJavaScriptModule(source: string): AstNode;
/**
 * A program as Node would run it: an ES module, or a CommonJS script (whose
 * top level may `return`); null when it is neither.
 */
export declare function parseJavaScriptProgram(source: string): AstNode | null;
export declare function hasTopLevelModuleSyntax(source: string): boolean;
export declare function nodeList(node: AstNode, key: string): AstNode[];
export declare function nodeProp(node: AstNode | undefined, key: string): AstNode | undefined;
export declare function nodeName(node: AstNode | undefined): string | undefined;
export declare function stringField(node: AstNode, key: string): string | undefined;
export declare function booleanField(node: AstNode, key: string): boolean;
export declare function literalStringValue(node: AstNode | undefined): string | undefined;
export declare function literalBooleanValue(node: AstNode | undefined): boolean | undefined;
export declare function isAstNode(value: unknown): value is AstNode;
/** Each child node of `node`. */
export declare function forEachChild<N extends {
    type: string;
}>(node: N, visit: (child: N) => void): void;
/** Every node below `node`, functions included, in source order. */
export declare function forEachNode<N extends {
    type: string;
}>(node: N, visit: (n: N) => void): void;
//# sourceMappingURL=javascript-ast.d.ts.map