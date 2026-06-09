import { parse, type AnyNode } from 'acorn';

export type AstNode = AnyNode & Record<string, unknown>;

export function parseJavaScriptModule(source: string): AstNode {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  }) as AstNode;
}

export function hasTopLevelModuleSyntax(source: string): boolean {
  let ast: AstNode;
  try {
    ast = parseJavaScriptModule(source);
  } catch {
    return false;
  }
  return nodeList(ast, 'body').some((node) =>
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportDefaultDeclaration' ||
    node.type === 'ExportAllDeclaration'
  );
}

export function nodeList(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isAstNode);
}

export function nodeProp(node: AstNode | undefined, key: string): AstNode | undefined {
  if (!node) return undefined;
  const value = node[key];
  return isAstNode(value) ? value : undefined;
}

export function nodeName(node: AstNode | undefined): string | undefined {
  if (node?.type !== 'Identifier' && node?.type !== 'Literal') return undefined;
  if (node.type === 'Identifier') return stringField(node, 'name');
  return literalStringValue(node);
}

export function stringField(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(node: AstNode, key: string): boolean {
  const value = node[key];
  return typeof value === 'boolean' ? value : false;
}

export function literalStringValue(node: AstNode | undefined): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

export function literalBooleanValue(node: AstNode | undefined): boolean | undefined {
  return node?.type === 'Literal' && typeof node.value === 'boolean' ? node.value : undefined;
}

export function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}
