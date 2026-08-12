import {
  type AstNode,
  booleanField,
  literalBooleanValue,
  literalStringValue,
  nodeList,
  nodeName,
  nodeProp,
  parseJavaScriptModule,
  stringField,
} from './javascript-ast.js';

export interface ParsedViteConfig {
  root?: string;
  base?: string;
  outDir?: string;
  port?: number;
  injectBasename?: boolean;
  alias?: Record<string, string>;
  define?: Record<string, string>;
  devServer?: 'real' | 'real-vite' | 'cirrus' | 'shim' | 'auto' | string;
  importsVitePlugin?: boolean;
}

export function parseViteConfigSource(source: string): ParsedViteConfig {
  const ast = parseJavaScriptModule(source);
  const bindings = collectTopLevelBindings(ast);
  const configExpr = findExportedConfigExpression(ast, bindings);
  const configObject = configExpr ? unwrapConfigExpression(configExpr, bindings) : null;
  const config: ParsedViteConfig = {};

  if (configObject?.type === 'ObjectExpression') {
    readStringProperty(configObject, 'root', (value) => { config.root = value; });
    readStringProperty(configObject, 'base', (value) => { config.base = value; });
    readBooleanProperty(configObject, 'nimbusInjectBasename', (value) => { config.injectBasename = value; });
    readStringProperty(configObject, 'nimbusDevServer', (value) => { config.devServer = value; });

    const build = getObjectProperty(configObject, 'build');
    if (build?.type === 'ObjectExpression') {
      readStringProperty(build, 'outDir', (value) => { config.outDir = value; });
    }
    readStringProperty(configObject, 'outDir', (value) => { config.outDir = value; });

    const server = getObjectProperty(configObject, 'server');
    const preview = getObjectProperty(configObject, 'preview');
    config.port =
      numberProperty(server, 'port') ??
      numberProperty(preview, 'port') ??
      numberProperty(configObject, 'port');

    const resolve = getObjectProperty(configObject, 'resolve');
    const alias = resolve?.type === 'ObjectExpression' ? getObjectProperty(resolve, 'alias') : undefined;
    const parsedAlias = alias ? parseAlias(alias) : undefined;
    if (parsedAlias && Object.keys(parsedAlias).length > 0) config.alias = parsedAlias;

    const define = getObjectProperty(configObject, 'define');
    const parsedDefine = define?.type === 'ObjectExpression' ? parseDefine(define) : undefined;
    if (parsedDefine && Object.keys(parsedDefine).length > 0) config.define = parsedDefine;
  }

  config.importsVitePlugin = importsVitePlugin(ast);
  return config;
}

function collectTopLevelBindings(ast: AstNode): Map<string, AstNode> {
  const bindings = new Map<string, AstNode>();
  for (const stmt of nodeList(ast, 'body')) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of nodeList(stmt, 'declarations')) {
        const id = nodeProp(decl, 'id');
        const init = nodeProp(decl, 'init');
        const name = id?.type === 'Identifier' ? stringField(id, 'name') : undefined;
        if (name && init) bindings.set(name, init);
      }
      continue;
    }
    if (stmt.type === 'FunctionDeclaration') {
      const id = nodeProp(stmt, 'id');
      const name = id?.type === 'Identifier' ? stringField(id, 'name') : undefined;
      if (name) bindings.set(name, stmt);
    }
  }
  return bindings;
}

function findExportedConfigExpression(ast: AstNode, bindings: Map<string, AstNode>): AstNode | null {
  for (const stmt of nodeList(ast, 'body')) {
    if (stmt.type === 'ExportDefaultDeclaration') return nodeProp(stmt, 'declaration') || null;
    if (stmt.type === 'ExportNamedDeclaration') {
      for (const specifier of nodeList(stmt, 'specifiers')) {
        const exported = nodeProp(specifier, 'exported');
        const local = nodeProp(specifier, 'local');
        const exportedName = nodeName(exported);
        const localName = nodeName(local);
        if (exportedName === 'default' && localName) return bindings.get(localName) || null;
      }
    }
    if (stmt.type === 'ExpressionStatement') {
      const expression = nodeProp(stmt, 'expression');
      if (expression?.type !== 'AssignmentExpression') continue;
      const left = nodeProp(expression, 'left');
      if (isModuleExports(left) || isExportsDefault(left)) return nodeProp(expression, 'right') || null;
    }
  }
  return null;
}

function unwrapConfigExpression(expr: AstNode | undefined, bindings: Map<string, AstNode>): AstNode | null {
  if (!expr) return null;
  if (expr.type === 'Identifier') return unwrapConfigExpression(bindings.get(stringField(expr, 'name') || ''), bindings);
  if (expr.type === 'CallExpression') {
    const first = nodeList(expr, 'arguments')[0];
    if (first?.type === 'ObjectExpression') return first;
    if (first?.type === 'ArrowFunctionExpression') return unwrapConfigExpression(nodeProp(first, 'body'), bindings);
    return null;
  }
  if (expr.type === 'ObjectExpression') return expr;
  if (
    expr.type === 'ArrowFunctionExpression' ||
    expr.type === 'FunctionExpression' ||
    expr.type === 'FunctionDeclaration'
  ) {
    return unwrapConfigExpression(nodeProp(expr, 'body'), bindings);
  }
  if (expr.type === 'BlockStatement') {
    for (const stmt of nodeList(expr, 'body')) {
      if (stmt.type === 'ReturnStatement') return unwrapConfigExpression(nodeProp(stmt, 'argument'), bindings);
    }
    return null;
  }
  if (expr.type === 'ParenthesizedExpression') return unwrapConfigExpression(nodeProp(expr, 'expression'), bindings);
  return null;
}

function getObjectProperty(objectNode: AstNode | undefined, name: string): AstNode | undefined {
  if (!objectNode || objectNode.type !== 'ObjectExpression') return undefined;
  for (const property of nodeList(objectNode, 'properties')) {
    if (property.type !== 'Property' || booleanField(property, 'computed')) continue;
    if (propertyKeyName(nodeProp(property, 'key')) === name) return nodeProp(property, 'value');
  }
  return undefined;
}

function readStringProperty(objectNode: AstNode, name: string, set: (value: string) => void): void {
  const value = stringLiteralValue(getObjectProperty(objectNode, name));
  if (value !== undefined) set(value);
}

function readBooleanProperty(objectNode: AstNode, name: string, set: (value: boolean) => void): void {
  const value = booleanLiteralValue(getObjectProperty(objectNode, name));
  if (value !== undefined) set(value);
}

function numberProperty(objectNode: AstNode | undefined, name: string): number | undefined {
  const value = getObjectProperty(objectNode, name);
  return value?.type === 'Literal' && typeof value.value === 'number' ? value.value : undefined;
}

function parseAlias(aliasNode: AstNode): Record<string, string> | undefined {
  if (aliasNode.type === 'ObjectExpression') {
    const out: Record<string, string> = {};
    for (const property of nodeList(aliasNode, 'properties')) {
      if (property.type !== 'Property' || booleanField(property, 'computed')) continue;
      const name = propertyKeyName(nodeProp(property, 'key'));
      const value = pathLikeValue(nodeProp(property, 'value'));
      if (name && value) out[name] = value;
    }
    return out;
  }

  if (aliasNode.type === 'ArrayExpression') {
    const out: Record<string, string> = {};
    for (const element of nodeList(aliasNode, 'elements')) {
      if (element.type !== 'ObjectExpression') continue;
      const find = stringLiteralValue(getObjectProperty(element, 'find'));
      const replacement = pathLikeValue(getObjectProperty(element, 'replacement'));
      if (find && replacement) out[find] = replacement;
    }
    return out;
  }

  return undefined;
}

function parseDefine(defineNode: AstNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const property of nodeList(defineNode, 'properties')) {
    if (property.type !== 'Property' || booleanField(property, 'computed')) continue;
    const name = propertyKeyName(nodeProp(property, 'key'));
    const value = defineValue(nodeProp(property, 'value'));
    if (name && value !== undefined) out[name] = value;
  }
  return out;
}

function propertyKeyName(key: AstNode | undefined): string | undefined {
  if (key?.type === 'Identifier') return stringField(key, 'name');
  if (key?.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

function stringLiteralValue(node: AstNode | undefined): string | undefined {
  return literalStringValue(node);
}

function booleanLiteralValue(node: AstNode | undefined): boolean | undefined {
  return literalBooleanValue(node);
}

function pathLikeValue(node: AstNode | undefined): string | undefined {
  const direct = stringLiteralValue(node);
  if (direct !== undefined) return direct;
  if (node?.type === 'CallExpression') {
    const args = nodeList(node, 'arguments');
    for (let i = args.length - 1; i >= 0; i--) {
      const value = stringLiteralValue(args[i]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function defineValue(node: AstNode | undefined): string | undefined {
  const direct = stringLiteralValue(node);
  if (direct !== undefined) return direct;
  if (node?.type === 'Literal' && (typeof node.value === 'number' || typeof node.value === 'boolean')) {
    return String(node.value);
  }
  if (node?.type === 'CallExpression' && isJsonStringifyCall(node)) {
    const arg = nodeList(node, 'arguments')[0];
    if (arg?.type === 'Literal') return JSON.stringify(arg.value);
  }
  return undefined;
}

function importsVitePlugin(ast: AstNode): boolean {
  for (const stmt of nodeList(ast, 'body')) {
    const source = nodeProp(stmt, 'source');
    if (stmt.type === 'ImportDeclaration' && typeof source?.value === 'string') {
      if (source.value.startsWith('@vitejs/plugin-')) return true;
    }
  }
  return false;
}

function isJsonStringifyCall(node: AstNode): boolean {
  const callee = nodeProp(node, 'callee');
  if (callee?.type !== 'MemberExpression') return false;
  const object = nodeProp(callee, 'object');
  const property = nodeProp(callee, 'property');
  return object?.type === 'Identifier' &&
    stringField(object, 'name') === 'JSON' &&
    propertyKeyName(property) === 'stringify' &&
    nodeList(node, 'arguments').length === 1;
}

function isModuleExports(node: AstNode | undefined): boolean {
  if (node?.type !== 'MemberExpression') return false;
  const object = nodeProp(node, 'object');
  const property = nodeProp(node, 'property');
  return object?.type === 'Identifier' &&
    stringField(object, 'name') === 'module' &&
    propertyKeyName(property) === 'exports';
}

function isExportsDefault(node: AstNode | undefined): boolean {
  if (node?.type !== 'MemberExpression') return false;
  const object = nodeProp(node, 'object');
  const property = nodeProp(node, 'property');
  return object?.type === 'Identifier' &&
    stringField(object, 'name') === 'exports' &&
    propertyKeyName(property) === 'default';
}
