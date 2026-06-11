import { parse, type AnyNode } from 'acorn';
import { ancestor } from 'acorn-walk';

export type AstNode = AnyNode & Record<string, unknown>;

export function parseJavaScriptModule(source: string): AstNode {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
  }) as AstNode;
}

const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

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
export function hasTopLevelAwait(source: string): boolean {
  if (!source || source.indexOf('await') === -1) return false;
  let ast: AstNode;
  try {
    ast = parseJavaScriptModule(source);
  } catch {
    return false;
  }
  let found = false;
  const isTopLevel = (ancestors: AnyNode[]): boolean => {
    // ancestors includes the node itself at the tail; scan the rest for
    // any enclosing function scope.
    for (let i = 0; i < ancestors.length - 1; i++) {
      if (FUNCTION_NODE_TYPES.has(ancestors[i].type)) return false;
    }
    return true;
  };
  ancestor(ast as AnyNode, {
    AwaitExpression(_node, _state, ancestors) {
      if (!found && isTopLevel(ancestors as AnyNode[])) found = true;
    },
    ForOfStatement(node, _state, ancestors) {
      if (!found && (node as { await?: boolean }).await && isTopLevel(ancestors as AnyNode[])) found = true;
    },
  });
  return found;
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
