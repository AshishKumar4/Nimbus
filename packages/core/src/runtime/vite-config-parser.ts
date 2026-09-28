import {
  type AstNode,
  booleanField,
  isAstNode,
  literalBooleanValue,
  literalStringValue,
  nodeList,
  nodeName,
  nodeProp,
  parseJavaScriptModule,
  stringField,
} from './javascript-ast.js';
import type { Pattern } from 'acorn';
import { simple } from 'acorn-walk';

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
  /**
   * Specifiers behind every `plugins: [...]` entry, where resolvable —
   * e.g. `@sveltejs/kit/vite` for `plugins: [sveltekit()]` when
   * `sveltekit` was imported from it. Unresolvable entries contribute a
   * descriptive placeholder (`inline plugin 'x'`, local identifier name,
   * '(unresolved plugin expression)') so the list never under-reports:
   * a non-empty array always means "this config runs plugins".
   */
  plugins?: string[];
}

/**
 * Read a `vite.config.ts` without a TypeScript transform where the transform
 * cannot change what this reader sees.
 *
 * The transform is esbuild, and on a fresh session it is the session's first:
 * it starts the esbuild facet (loading the wasm and initializing esbuild,
 * about a second), and `vite` waits on it before it serves anything. Most
 * configs, the seeded one included, are plain JavaScript under a `.ts` name.
 *
 * The direct read is taken only for a source that parses as a JavaScript
 * module built solely from PASS_THROUGH_NODES: syntax esbuild's `ts` transform
 * leaves as it is. That rules out, by construction, the two ways a source can
 * mean something else to esbuild. Type syntax: annotations, casts and enums do
 * not parse as JavaScript, and a generic call such as `f<T>(x)` or
 * `f<A<B>>(x)` parses only as comparisons or shifts, which are not on the
 * list. And rewriting: esbuild folds constants (`'a' + 'b'`, `!0`,
 * `+"5173"`, `null || x`, `false && f()`, conditionals, templates with
 * substitutions), all of them operators that are not on the list either.
 * TypeScript (and esbuild) also drop an import none of whose bindings is
 * used, which changes `importsVitePlugin` and so the dev-server choice, so a
 * source with such an import, or one that declares a name an import binds,
 * goes through esbuild too. Anything else calls `eraseTypes`.
 */
export async function parseViteConfigTypeScript(
  source: string,
  eraseTypes: (source: string) => Promise<string>,
): Promise<ParsedViteConfig> {
  let ast: AstNode | null = null;
  try {
    ast = parseJavaScriptModule(source);
  } catch {
    // Type syntax, or not a module at all: esbuild decides.
  }
  if (ast && onlyPassThroughSyntax(ast) && everyImportIsUsed(ast)) return readViteConfig(ast);
  return parseViteConfigSource(await eraseTypes(source));
}

/**
 * Every import binding is referenced, and no declaration reuses its name. A
 * side-effect-only `import 'x'` binds nothing and is kept either way.
 */
function everyImportIsUsed(ast: AstNode): boolean {
  const imported = new Set<string>();
  for (const statement of nodeList(ast, 'body')) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of nodeList(statement, 'specifiers')) {
      const local = nodeName(nodeProp(specifier, 'local'));
      if (local) imported.add(local);
    }
  }
  if (imported.size === 0) return true;
  const referenced = new Set<string>();
  const declared = new Set<string>();
  const declare = (pattern: Pattern | null | undefined): void => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') declared.add(pattern.name);
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) declare(property.type === 'RestElement' ? property.argument : property.value);
    } else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) declare(element);
    else if (pattern.type === 'RestElement') declare(pattern.argument);
    else if (pattern.type === 'AssignmentPattern') declare(pattern.left);
  };
  simple(ast, {
    // Identifiers the walker visits: references and declaration patterns;
    // import specifiers, non-computed keys and member names are not visited.
    Identifier(node) { referenced.add(node.name); },
    VariableDeclarator(node) { declare(node.id); },
    Function(node) {
      if (node.id) declared.add(node.id.name);
      for (const param of node.params) declare(param);
    },
    Class(node) { if (node.id) declared.add(node.id.name); },
    CatchClause(node) { declare(node.param); },
  });
  for (const name of imported) {
    if (!referenced.has(name) || declared.has(name)) return false;
  }
  return true;
}

/**
 * Syntax esbuild's `ts` transform passes through unchanged, and that a config
 * the reader understands is written in. No operator of any kind: every one is
 * either a candidate for constant folding or how a generic call parses.
 */
const PASS_THROUGH_NODES = new Set([
  'Program', 'ImportDeclaration', 'ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier',
  'ExportDefaultDeclaration', 'ExportNamedDeclaration', 'ExportSpecifier',
  'VariableDeclaration', 'VariableDeclarator', 'ExpressionStatement', 'BlockStatement', 'ReturnStatement',
  'CallExpression', 'NewExpression', 'MemberExpression', 'MetaProperty',
  'ObjectExpression', 'Property', 'ArrayExpression', 'Literal', 'TemplateLiteral', 'TemplateElement', 'Identifier',
  'ArrowFunctionExpression', 'FunctionExpression', 'ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'RestElement',
]);

function onlyPassThroughSyntax(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(onlyPassThroughSyntax);
  if (!isAstNode(node)) return true;
  if (!PASS_THROUGH_NODES.has(node.type)) return false;
  // A computed key or member may be folded to a plain one; a template with
  // substitutions may be folded to a string.
  if ((node.type === 'Property' || node.type === 'MemberExpression') && node.computed === true) return false;
  if (node.type === 'TemplateLiteral' && nodeList(node, 'expressions').length > 0) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && typeof value === 'object' && value !== null && !onlyPassThroughSyntax(value)) return false;
  }
  return true;
}

export function parseViteConfigSource(source: string): ParsedViteConfig {
  return readViteConfig(parseJavaScriptModule(source));
}

function readViteConfig(ast: AstNode): ParsedViteConfig {
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
    const plugins = getObjectProperty(configObject, 'plugins');
    if (plugins?.type === 'ArrayExpression') {
      const importSpecifiers = collectImportSpecifiers(ast);
      const pluginNames: string[] = [];
      for (const element of nodeList(plugins, 'elements')) {
        for (const name of pluginExpressionNames(element, importSpecifiers)) {
          pluginNames.push(name);
        }
      }
      if (pluginNames.length > 0) config.plugins = pluginNames;
    }
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

/** Map every imported local name to its module specifier (`import sveltekit from '@sveltejs/kit/vite'` → `sveltekit → '@sveltejs/kit/vite'`). */
function collectImportSpecifiers(ast: AstNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of nodeList(ast, 'body')) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const source = nodeProp(stmt, 'source');
    const specifier = source?.type === 'Literal' ? literalStringValue(source) : undefined;
    if (!specifier) continue;
    for (const spec of nodeList(stmt, 'specifiers')) {
      const local = nodeName(nodeProp(spec, 'local'));
      if (local) map.set(local, specifier);
    }
  }
  return map;
}

/**
 * Best-effort names for one `plugins: [...]` element. Vite plugin entries
 * are almost always `identifier()` call expressions on imported factories;
 * each form is resolved back to its import specifier so the diagnostic
 * names the package (`@sveltejs/kit/vite`), not the local name.
 */
function pluginExpressionNames(
  node: AstNode | undefined,
  imports: Map<string, string>,
  depth = 0,
): string[] {
  if (!node || depth > 4) return ['(unresolved plugin expression)'];
  switch (node.type) {
    case 'CallExpression':
    case 'NewExpression': {
      const callee = nodeProp(node, 'callee');
      if (callee?.type === 'Identifier') {
        const local = stringField(callee, 'name') || '';
        return [imports.get(local) || `local plugin '${local}'`];
      }
      if (callee?.type === 'MemberExpression') {
        const object = nodeProp(callee, 'object');
        const local = object?.type === 'Identifier' ? stringField(object, 'name') : undefined;
        const imported = local ? imports.get(local) : undefined;
        if (imported) return [imported];
      }
      return ['(unresolved plugin expression)'];
    }
    case 'Identifier': {
      const local = stringField(node, 'name') || '';
      // Imported factory reference (e.g. `plugins: [vue]`) or a local
      // function/const used as a plugin — either way it is a plugin.
      return [imports.get(local) || `local plugin '${local}'`];
    }
    case 'ObjectExpression': {
      // Inline plugin object literal `{ name: 'x', transform() {} }`.
      const name = literalStringValue(getObjectProperty(node, 'name'));
      return [name ? `inline plugin '${name}'` : '(inline plugin)'];
    }
    case 'SpreadElement':
      return pluginExpressionNames(nodeProp(node, 'argument'), imports, depth + 1);
    case 'ConditionalExpression':
      return [
        ...pluginExpressionNames(nodeProp(node, 'consequent'), imports, depth + 1),
        ...pluginExpressionNames(nodeProp(node, 'alternate'), imports, depth + 1),
      ];
    case 'LogicalExpression':
      return pluginExpressionNames(nodeProp(node, 'right'), imports, depth + 1);
    case 'Literal':
      return typeof node.value === 'string' ? [`'${node.value}'`] : [];
    default:
      return ['(unresolved plugin expression)'];
  }
}

/**
 * Vite plugins the built-in (`cirrus`) path already handles itself — they
 * are skipped by every gate below and produce no warning:
 *
 *  - `@vitejs/plugin-react*` — inert: the built-in server compiles JSX/TSX
 *    (incl. the automatic runtime) natively; the plugin's contribution is
 *    fast-refresh, which the shim does not need.
 *  - `@cloudflare/vite-plugin` — its whole job is booting a local workerd
 *    sidecar (miniflare). Inside Nimbus the session already IS workerd, so
 *    there is nothing to delegate; the SPA the config also serves is plain
    Vite and works as-is.
 *  - `@tailwindcss/vite` — Tailwind v4's CSS-first transform is covered by
 *    the dev server's Tailwind pipeline (@tailwind stripping, @apply
 *    expansion, vendored Play CDN inject — vite-dev-server.ts), so the
 *    plugin is redundant.
 */
const CIRRUS_KNOWN_VITE_PLUGINS: Record<string, true> = {
  '@vitejs/plugin-react': true,
  '@vitejs/plugin-react-swc': true,
  '@vitejs/plugin-react-oxc': true,
  '@cloudflare/vite-plugin': true,
  '@tailwindcss/vite': true,
};

/**
 * Framework plugins whose `plugins: [...]` presence means the project is
 * not a plain-Vite app at all: SvelteKit/Vue/Solid compile `.svelte`/
 * `.vue`/`src/routes` module graphs the built-in esbuild path cannot
 * produce. `vite build` refuses these (any other entry layout would die
 * deep in esbuild on a confusing error); dev only warns. Astro and Nuxt
 * are absent — they are driven by astro.config/nuxt.config, never by a
 * vite.config `plugins` entry.
 */
const CIRRUS_FRAMEWORK_VITE_PLUGINS: Record<string, true> = {
  '@sveltejs/kit/vite': true,
  '@sveltejs/vite-plugin-svelte': true,
  '@vitejs/plugin-vue': true,
  'vite-plugin-solid': true,
};

/** Plugins a parsed config declares that the built-in build must refuse:
 *  the framework denylist only — everything else gets a warning and tries. */
export function viteBuildBlockingPlugins(config: ParsedViteConfig): string[] {
  return (config.plugins || []).filter(
    (name) => CIRRUS_FRAMEWORK_VITE_PLUGINS[name] === true,
  );
}

/** Plugins a parsed config declares that the built-in server does not
 *  evaluate but that are not known-handled — the dev/build warning list. */
export function unhandledVitePlugins(config: ParsedViteConfig): string[] {
  return (config.plugins || []).filter(
    (name) => !CIRRUS_KNOWN_VITE_PLUGINS[name] && CIRRUS_FRAMEWORK_VITE_PLUGINS[name] !== true,
  );
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
