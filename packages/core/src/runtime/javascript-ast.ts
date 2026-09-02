import { parse, tokenizer, tokTypes, type AnyNode, type TokenType } from 'acorn';

export type AstNode = AnyNode & Record<string, unknown>;

export function parseJavaScriptModule(source: string): AstNode {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  }) as AstNode;
}

export function hasTopLevelModuleSyntax(source: string): boolean {
  try {
    const tokens = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let previous: TokenType | undefined;

    const updateDepth = (type: TokenType): void => {
      if (type === tokTypes.braceL || type === tokTypes.dollarBraceL) braceDepth++;
      else if (type === tokTypes.braceR) braceDepth = Math.max(0, braceDepth - 1);
      else if (type === tokTypes.parenL) parenDepth++;
      else if (type === tokTypes.parenR) parenDepth = Math.max(0, parenDepth - 1);
      else if (type === tokTypes.bracketL) bracketDepth++;
      else if (type === tokTypes.bracketR) bracketDepth = Math.max(0, bracketDepth - 1);
    };

    while (true) {
      const token = tokens.getToken();
      const type = token.type;
      if (type === tokTypes.eof) return false;
      const topLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;

      if (topLevel && previous !== tokTypes.dot) {
        if (type === tokTypes._export) return true;
        if (type === tokTypes._import) {
          const next = tokens.getToken();
          if (next.type !== tokTypes.parenL && next.type !== tokTypes.dot) return true;
          updateDepth(next.type);
          previous = next.type;
          continue;
        }
      }

      updateDepth(type);
      previous = type;
    }
  } catch {
    return false;
  }
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
