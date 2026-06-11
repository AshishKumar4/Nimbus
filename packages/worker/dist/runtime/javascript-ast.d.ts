import { type AnyNode } from 'acorn';
export type AstNode = AnyNode & Record<string, unknown>;
export declare function parseJavaScriptModule(source: string): AstNode;
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