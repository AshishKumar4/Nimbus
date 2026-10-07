/**
 * javascript-scope.ts — which scope a name in a parsed program binds to.
 *
 * Reads ESTree as acorn and rolldown's parser give it, structurally (any
 * object with a string `type` and numeric `start` and `end` is a node), so
 * TypeScript's binding forms count where they bind at run time. The scopes
 * are the language's: a program's and a static block's, a function's
 * parameters and its body's `var`s, a block's, a switch's, a `for` head's
 * `let` and `const`, a catch clause's, and a class's name inside its body.
 *
 * Self-contained: rolldown-compat.ts (the build facet's runtime) and
 * async-module-lowering.ts (the transform facet's) both bundle it.
 */

/** A node of a parsed program. */
export interface EsNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export function isNode(value: unknown): value is EsNode {
  return typeof value === 'object' && value !== null
    && 'type' in value && typeof value.type === 'string'
    && 'start' in value && typeof value.start === 'number'
    && 'end' in value && typeof value.end === 'number';
}

/** `node[key]` when it is a node. */
export function child(node: EsNode | null, key: string): EsNode | null {
  const value = node?.[key];
  return isNode(value) ? value : null;
}

/** The nodes of the list `node[key]`. */
export function list(node: EsNode | null, key: string): EsNode[] {
  const value = node?.[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** `node[key]` when it is a string. */
export function stringOf(node: EsNode | null, key: string): string | null {
  const value = node?.[key];
  return typeof value === 'string' ? value : null;
}

/** The names a binding binds: an identifier, or what the parts of a pattern bind. */
export function* patternNames(node: EsNode | null): Generator<string> {
  switch (node?.type) {
    case 'Identifier': {
      const name = stringOf(node, 'name');
      if (name !== null) yield name;
      return;
    }
    case 'ObjectPattern':
      for (const property of list(node, 'properties')) yield* patternNames(child(property, property.type === 'RestElement' ? 'argument' : 'value'));
      return;
    case 'ArrayPattern':
      for (const element of list(node, 'elements')) yield* patternNames(element);
      return;
    case 'RestElement':
      yield* patternNames(child(node, 'argument'));
      return;
    case 'AssignmentPattern':
      yield* patternNames(child(node, 'left'));
      return;
    case 'TSParameterProperty':
      yield* patternNames(child(node, 'parameter'));
      return;
    // `namespace A.B {}` binds A.
    case 'TSQualifiedName':
      yield* patternNames(child(node, 'left'));
      return;
  }
}

/** A scope of a program: the names it binds, and the scope it is in. */
export interface Scope {
  readonly names: ReadonlySet<string>;
  readonly parent: Scope | null;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** The names a list of statements binds lexically: let, const, class, function and import. */
function* lexicalNames(statements: EsNode[]): Generator<string> {
  for (const statement of statements) {
    const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? child(statement, 'declaration') : statement;
    if (node?.type === 'VariableDeclaration' && node.kind !== 'var') {
      for (const declarator of list(node, 'declarations')) yield* patternNames(child(declarator, 'id'));
    }
    if (node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration') yield* patternNames(child(node, 'id'));
    if (node?.type === 'ImportDeclaration') for (const specifier of list(node, 'specifiers')) yield* patternNames(child(specifier, 'local'));
  }
}

/**
 * The names `var` binds in `value` for the function (or program, or static
 * block) it is in, not entering nested ones; in sloppy code, a function
 * declared in a block is one of them too (Annex B).
 */
function varNames(value: unknown, sloppy: boolean, top = true, names: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) varNames(item, sloppy, top, names);
    return names;
  }
  if (!isNode(value)) return names;
  if (value.type === 'FunctionDeclaration' && sloppy && !top) names.push(...patternNames(child(value, 'id')));
  if (FUNCTIONS.has(value.type) || value.type === 'StaticBlock') return names;
  if (value.type === 'VariableDeclaration' && value.kind === 'var') {
    for (const declarator of list(value, 'declarations')) names.push(...patternNames(child(declarator, 'id')));
  }
  for (const key in value) if (key !== 'parent') varNames(value[key], sloppy, false, names);
  return names;
}

/**
 * The scope `node`'s children are in, given the one it is in. A function's
 * parameters are in a scope of their own, with `arguments` unless it is an
 * arrow, its body's `var`s in its body's (a parameter's default value does
 * not see them).
 */
function scopeOf(node: EsNode, scope: Scope, sloppy: boolean, functionBody: boolean): Scope {
  const within = (names: Iterable<string>): Scope => ({ names: new Set(names), parent: scope });
  switch (node.type) {
    case 'Program':
    case 'StaticBlock':
      return within([...varNames(list(node, 'body'), sloppy), ...lexicalNames(list(node, 'body'))]);
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return within([
        ...(node.type === 'FunctionExpression' ? patternNames(child(node, 'id')) : []),
        ...(node.type === 'ArrowFunctionExpression' ? [] : ['arguments']),
        ...list(node, 'params').flatMap((parameter) => [...patternNames(parameter)]),
      ]);
    case 'BlockStatement':
      return within([...(functionBody ? varNames(list(node, 'body'), sloppy) : []), ...lexicalNames(list(node, 'body'))]);
    case 'SwitchStatement':
      return within(lexicalNames(list(node, 'cases').flatMap((c) => list(c, 'consequent'))));
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const head = child(node, node.type === 'ForStatement' ? 'init' : 'left');
      return within(head?.type === 'VariableDeclaration' && head.kind !== 'var'
        ? list(head, 'declarations').flatMap((declarator) => [...patternNames(child(declarator, 'id'))])
        : []);
    }
    case 'CatchClause':
      return within(patternNames(child(node, 'param')));
    // A class's name is its body's too (an expression's, only its body's).
    case 'ClassDeclaration':
    case 'ClassExpression':
      return within(patternNames(child(node, 'id')));
    default:
      return scope;
  }
}

/**
 * Every node under `value`, each before its children, with the scope it is
 * in, the node it is under and the key it is under that node by (null and
 * '' for `value` itself). A program's own scope is the one whose parent is
 * `scope`. A node `opaque` says is yielded, but not what is under it.
 *
 * Walked with a stack of its own, not a generator per node: a yield passes
 * through no frames, whatever the depth.
 */
export function* scoped(
  value: unknown,
  scope: Scope,
  sloppy: boolean,
  functionBody = false,
  parent: EsNode | null = null,
  key = '',
  opaque?: (node: EsNode) => boolean,
): Generator<[EsNode, Scope, EsNode | null, string]> {
  const stack: [unknown, Scope, boolean, EsNode | null, string][] = [[value, scope, functionBody, parent, key]];
  while (stack.length > 0) {
    const [item, at, inBody, under, field] = stack.pop()!;
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) stack.push([item[i], at, false, under, field]);
      continue;
    }
    if (!isNode(item)) continue;
    yield [item, at, under, field];
    if (opaque?.(item)) continue;
    const inner = scopeOf(item, at, sloppy, inBody);
    const isFunction = FUNCTIONS.has(item.type);
    const fields = Object.keys(item);
    for (let i = fields.length - 1; i >= 0; i--) {
      const name = fields[i]!;
      if (name === 'parent') continue;
      // A switch's discriminant is evaluated before its cases' scope exists.
      const fieldScope = item.type === 'SwitchStatement' && name === 'discriminant' ? at : inner;
      stack.push([item[name], fieldScope, isFunction && name === 'body', item, name]);
    }
  }
}

/** The innermost scope from `scope` out that binds `name`, or null where none does. */
export function bindingScope(scope: Scope | null, name: string): Scope | null {
  for (let at = scope; at; at = at.parent) if (at.names.has(name)) return at;
  return null;
}

/**
 * Whether an identifier under `parent` by `key` reads or writes a binding,
 * rather than naming a property, a key or a label, `import.meta`'s parts, or
 * an import or export specifier's names (the declaration's, or the other
 * module's).
 */
export function namesBinding(parent: EsNode, key: string): boolean {
  switch (parent.type) {
    case 'MemberExpression':
      return key !== 'property' || parent.computed === true;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key !== 'key' || parent.computed === true;
    case 'ImportAttribute':
      return key !== 'key';
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'MetaProperty':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'ExportAllDeclaration':
      return false;
    default:
      return true;
  }
}

/** Whether a program's code is sloppy: a script without "use strict". */
export function isSloppy(program: EsNode): boolean {
  if (program.sourceType === 'module') return false;
  return !list(program, 'body').some((statement) => statement.type === 'ExpressionStatement' && statement.directive === 'use strict');
}
