import { parse, tokenizer, tokTypes, type AnyNode, type Program, type TokenType } from 'acorn';

export type AstNode = AnyNode & Record<string, unknown>;

export function parseJavaScriptModule(source: string): AstNode {
  const program = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  });
  // Program declares no index signature; the guard gives it AstNode's keyed view.
  if (!isAstNode(program)) throw new TypeError(`acorn parsed a ${program.type}, not a node`);
  return program;
}

/**
 * A program as Node would run it: an ES module, or a CommonJS script (whose
 * top level may `return`); null when it is neither.
 */
export function parseJavaScriptProgram(source: string): Program | null {
  const options = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
  } as const;
  try {
    return parse(source, { ...options, sourceType: 'module' });
  } catch {
    try {
      return parse(source, { ...options, sourceType: 'script' });
    } catch {
      return null;
    }
  }
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

/** Every node type acorn's AnyNode names: `satisfies` holds the list to acorn's types. */
const NODE_TYPES: ReadonlySet<string> = new Set(Object.keys({
  ArrayExpression: true, ArrayPattern: true, ArrowFunctionExpression: true, AssignmentExpression: true,
  AssignmentPattern: true, AwaitExpression: true, BinaryExpression: true, BlockStatement: true, BreakStatement: true,
  CallExpression: true, CatchClause: true, ChainExpression: true, ClassBody: true, ClassDeclaration: true,
  ClassExpression: true, ConditionalExpression: true, ContinueStatement: true, DebuggerStatement: true,
  DoWhileStatement: true, EmptyStatement: true, ExportAllDeclaration: true, ExportDefaultDeclaration: true,
  ExportNamedDeclaration: true, ExportSpecifier: true, ExpressionStatement: true, ForInStatement: true,
  ForOfStatement: true, ForStatement: true, FunctionDeclaration: true, FunctionExpression: true, Identifier: true,
  IfStatement: true, ImportAttribute: true, ImportDeclaration: true, ImportDefaultSpecifier: true,
  ImportExpression: true, ImportNamespaceSpecifier: true, ImportSpecifier: true, LabeledStatement: true,
  Literal: true, LogicalExpression: true, MemberExpression: true, MetaProperty: true, MethodDefinition: true,
  NewExpression: true, ObjectExpression: true, ObjectPattern: true, ParenthesizedExpression: true,
  PrivateIdentifier: true, Program: true, Property: true, PropertyDefinition: true, RestElement: true,
  ReturnStatement: true, SequenceExpression: true, SpreadElement: true, StaticBlock: true, Super: true,
  SwitchCase: true, SwitchStatement: true, TaggedTemplateExpression: true, TemplateElement: true,
  TemplateLiteral: true, ThisExpression: true, ThrowStatement: true, TryStatement: true, UnaryExpression: true,
  UpdateExpression: true, VariableDeclaration: true, VariableDeclarator: true, WhileStatement: true,
  WithStatement: true, YieldExpression: true,
} satisfies Record<AnyNode['type'], true>));

/**
 * A node of a tree acorn parsed: an object whose `type` is one of acorn's
 * node types. Its other fields are acorn's, which this does not re-check.
 */
export function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value
    && typeof value.type === 'string' && NODE_TYPES.has(value.type);
}

const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** Each child node of `node`. */
export function forEachChild(node: AnyNode, visit: (child: AnyNode) => void): void {
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    const child: unknown = Reflect.get(node, key);
    if (Array.isArray(child)) {
      const children: readonly unknown[] = child;
      for (const c of children) if (isAstNode(c)) visit(c);
    } else if (isAstNode(child)) {
      visit(child);
    }
  }
}

/** Every node below `node`, functions included, in source order. */
export function forEachNode(node: AnyNode, visit: (n: AnyNode) => void): void {
  visit(node);
  forEachChild(node, (child) => forEachNode(child, visit));
}
