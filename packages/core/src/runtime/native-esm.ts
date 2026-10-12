/**
 * native-esm.ts — an ES module as a guest's module registry evaluates it:
 * its own text, scope, live bindings, cycles and top-level await, all the
 * engine's. Nimbus stages it; it never lowers it.
 *
 * The registry (workerd's new module registry over a Worker Loader map, or a
 * host's own loader off Cloudflare) joins a specifier to the importing
 * module's URL and nothing more: no package lookup, no conditions, no Node
 * builtins in a program's sense, and every module lives under the map's
 * root, so its own `import.meta` names the map, not the program's file. So
 * each module is staged before it runs, edited only where the registry reads
 * it differently from Node:
 *   - each static specifier names the map module of what Node's resolver
 *     names for it (a module, a CommonJS facade, a builtin facade);
 *   - `import.meta` and the `import` of `import(` are the module's own
 *     bindings of the same length, so no line or column moves;
 *   - a prologue call opens the first line (its `head`), and one line after
 *     the last binds those names from the module's meta instance
 *     (ESM_META_MODULE, `?<id>`), imports the module's own namespace, and
 *     registers it once the body completes.
 *
 * The meta instance is the module's gate (workerd): its body ends in a
 * top-level await, so the registry, which evaluates every module with the
 * request's I/O context suppressed (workerd io/worker-modules.h,
 * SuppressIoContextScope), runs no module body inside that evaluation; V8
 * runs it from the gate's fulfillment, a microtask, inside the request. One
 * instance per module, so a module first evaluated later (a chunk whose
 * dependencies are all loaded) waits for its own gate too. The prologue call
 * runs first in the body, where a gate cannot: every gate of a batch settles
 * before any body of it runs. It stops the body once an earlier body of the
 * same batch threw, as Node's evaluation stops at the first error, or once
 * the batch was cancelled for a require() of a module in it (node-shims).
 *
 * Every edit is recorded (ColumnMap): a stack frame's column moves back by
 * the ones that changed a line's length, and the module's text before it was
 * staged is read back through them all (commonjs-cell.ts
 * __nimbusModuleSourceText), for its source map's URL and for the
 * interpreter, which evaluates the module where the registry cannot
 * (node-shims' adoption).
 */

import type { Identifier } from 'acorn';
import { bindingIdentifiers } from './binding-pattern.js';
import { escapedIdentifierNames, readModuleImportSites, type ImportSites } from './dynamic-import-rewrite.js';
import { esModuleFacts } from './esm-require-hoist.js';
import type { ModuleScope } from './module-format.js';
import { MODULE_PARSE_OPTIONS, parseStatements, type SourceEdit } from './javascript-ast.js';

/** The map module every staged module binds import.meta, import(), its check and its registration from. */
export const ESM_META_MODULE = 'nimbus/meta.js';
/** The map module the runner fills with the functions ESM_META_MODULE's instances ask for. */
export const ESM_HOST_MODULE = 'nimbus/esm-host.js';
/** Where a launch puts the facades an ES module imports a builtin or a CommonJS module through. */
export const ESM_FACADE_DIR = 'nimbus/facade/';
/** A staged module's flag in its launch's table: its meta instance binds Bun's CommonJS names (bunScopeNames). */
export const ESM_BUN_SCOPE = 1;
/** A staged module's flag in its launch's table: it awaits at its top level (esm-require-hoist.ts hasTopLevelAwait). */
export const ESM_TOP_LEVEL_AWAIT = 2;
/**
 * A staged module's flag in its launch's table: a `.js` an ES module by its
 * syntax alone, under a package.json with no "type" (its row names that
 * package.json), which Node warns about as it loads it (MODULE_TYPELESS_PACKAGE_JSON).
 */
export const ESM_TYPELESS = 4;

/**
 * Where a module's edits change a line, by line: [line, source column,
 * generated length, source text], and 1 for a call (commonjs-cell.ts
 * __nimbusSourceColumn, __nimbusSourceLine).
 */
export type ColumnMap = Array<[number, number, number, string] | [number, number, number, string, 1]>;

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The ColumnMap of `edits` to `source`, none of which adds or removes a line break. */
export function columnMap(source: string, edits: readonly SourceEdit[]): ColumnMap {
  const entries: ColumnMap = [];
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (const edit of ordered) {
    const before = source.slice(scanned, edit.start).split(LINE_BREAK);
    if (before.length > 1) {
      line += before.length - 1;
      lineStart = edit.start - before[before.length - 1]!.length;
    }
    scanned = edit.start;
    const from = source.slice(edit.start, edit.end).split(LINE_BREAK);
    const to = edit.text.split(LINE_BREAK);
    for (let i = 0; i < from.length; i++) {
      const column = i === 0 ? edit.start - lineStart : 0;
      const text = i === from.length - 1 ? to.slice(i).join('') : to[i]!;
      if (text !== from[i]) entries.push([line + i, column, text.length, from[i]!]);
    }
  }
  return entries;
}

/** An ES module as staged: its map text, and how its frames and its file are read back from it. */
export interface StagedEsModule {
  readonly text: string;
  /** Characters of prologue before the module's first line. */
  readonly head: number;
  /** Characters after its last line. */
  readonly tail: number;
  /** It opened with a shebang, which the text carries as `//`. */
  readonly hashbang: boolean;
  readonly columns: ColumnMap;
}

/** Where a staged module sits and what it links to. */
export interface EsModuleLink {
  /** Its meta instance's query: the module's row in the launch's cell table. */
  readonly id: number;
  /** Its own map name, under the map's root. */
  readonly name: string;
  /** The map name each of `sites.statics`, in order, loads. */
  readonly targets: readonly string[];
  /** Bun's scope: the CommonJS names (`require`, `__filename`, `__dirname`) it reads but does not declare. */
  readonly commonJsNames?: readonly string[];
  /**
   * The map names its hoisted require()s load (esm-require-hoist.ts), in
   * order: imported after its own imports, so evaluated before its body.
   */
  readonly hoisted?: readonly string[];
}

/** The map's root as module URLs name it: workerd's, under which a Worker Loader map's modules live. */
export const MAP_ROOT = 'file:///bundle/';

/**
 * The relative specifier that names map module `target` from map module
 * `from`. Every specifier a stage writes is relative, so the staged text
 * names the same modules under any root its host serves the map from.
 */
export function relativeSpecifier(from: string, target: string): string {
  const fromDir = from.split('/').slice(0, -1);
  const parts = target.split('/');
  let common = 0;
  while (common < fromDir.length && common < parts.length - 1 && fromDir[common] === parts[common]) common++;
  const up = fromDir.length - common;
  return (up === 0 ? './' : '../'.repeat(up)) + parts.slice(common).join('/');
}

/** The specifier that names map module `target` from map module `from`: as written when the registry already resolves it there. */
function mapSpecifier(written: string, from: string, target: string): string {
  try {
    if (new URL(written, MAP_ROOT + from).href === MAP_ROOT + target) return written;
  } catch {
    // Not a URL the registry reads: rewritten below.
  }
  return relativeSpecifier(from, target);
}

/**
 * Identifiers `text` never spells, raw or escaped, of `length` characters
 * each: names the stage adds cannot be one the module declares or reads.
 */
function freshNames(text: string, length: number): () => string {
  const escaped = text.includes('\\u') ? escapedIdentifierNames(text) : new Set<string>();
  let n = 0;
  return () => {
    for (;;) {
      const suffix = (n++).toString(36);
      const name = '$n' + suffix.padStart(length - 2, '_');
      if (!text.includes(name) && !escaped.has(name)) return name;
    }
  };
}

/** The import, from map module `from`, of a module's meta instance: `bindings` are `export as local` pairs. */
function metaImport(from: string, id: number, bindings: ReadonlyArray<readonly [string, string]>): string {
  return `import{${bindings.map(([exported, local]) => `${exported} as ${local}`).join(',')}}from${JSON.stringify(`${relativeSpecifier(from, ESM_META_MODULE)}?${id}`)};`;
}

/**
 * The module the registry evaluates for ES module `text`, read as `sites`,
 * linked as `link` says. Lines and columns stay the file's but for the first
 * line's prologue (`head`) and specifiers whose length changed (`columns`).
 */
export function stageEsModule(text: string, sites: ImportSites, link: EsModuleLink): StagedEsModule {
  const hashbang = text.startsWith('#!');
  const source = hashbang ? '//' + text.slice(2) : text;
  const fresh = freshNames(text, 6);
  const [check, register, self] = [fresh(), fresh(), fresh()];
  const meta = sites.metas.length > 0 ? fresh() : null;
  const load = sites.calls.length > 0 ? fresh() : null;

  const edits: SourceEdit[] = [];
  sites.statics.forEach((site, index) => {
    const target = link.targets[index];
    if (target === undefined) throw new Error(`no target for specifier ${JSON.stringify(site.specifier)}`);
    const specifier = mapSpecifier(site.specifier, link.name, target);
    if (specifier === site.specifier) return;
    // A literal written over lines (a line continuation) keeps them: the
    // same continuations before its closing quote.
    const breaks = source.slice(site.start, site.end).match(/\r\n|[\n\r\u2028\u2029]/g) ?? [];
    edits.push({ start: site.start, end: site.end, text: JSON.stringify(specifier).slice(0, -1) + breaks.map((at) => '\\' + at).join('') + '"' });
  });
  // Import attributes are checked when staged (esm-stage.ts); the registry's
  // own check would refuse a JSON module, which the map carries as the
  // module of its value. Each clause is spaces but its line breaks.
  for (const { clause } of sites.statics) {
    if (clause !== undefined) edits.push({ start: clause.start, end: clause.end, text: source.slice(clause.start, clause.end).replace(/[^\n\r\u2028\u2029]/g, ' ') });
  }
  // `import` becomes the binding, and the rest of `import.meta` spaces but
  // its line breaks: the same length, the same lines.
  if (meta !== null) {
    for (const { start, end } of sites.metas) edits.push({ start, end, text: meta + source.slice(start + 6, end).replace(/[^\n\r\u2028\u2029]/g, ' ') });
  }
  if (load !== null) for (const { start } of sites.calls) edits.push({ start, end: start + 6, text: load });

  const bindings: Array<readonly [string, string]> = [['c', check], ['r', register]];
  if (meta !== null) bindings.push(['m', meta]);
  if (load !== null) bindings.push(['i', load]);
  for (const name of link.commonJsNames ?? []) bindings.push([COMMONJS_NAME_EXPORTS[name] ?? name, name]);
  const prologue = `${check}();`;
  const hoisted = (link.hoisted ?? []).map((target) => `import${JSON.stringify(relativeSpecifier(link.name, target))};`).join('');
  const tail = `\n;${hoisted}${metaImport(link.name, link.id, bindings)}import*as ${self} from${JSON.stringify(relativeSpecifier(link.name, link.name))};${register}(${self});`;
  let body = '';
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    body += source.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  body += source.slice(at);
  return { text: prologue + body + tail, head: prologue.length, tail: tail.length, hashbang, columns: columnMap(source, edits) };
}

/** The CommonJS names Bun's module scope binds (module-format.ts ModuleScope). */
const BUN_SCOPE_NAMES = ['require', '__filename', '__dirname'] as const;

/**
 * The CommonJS names an ES module in Bun's scope may read and does not
 * declare at its top level: the ones its meta instance binds for it. A name
 * the text only mentions (in a string, a comment) is bound unread, which is
 * harmless; one it declares is its own.
 */
export function bunScopeNames(code: string): string[] {
  const named = BUN_SCOPE_NAMES.filter((name) => code.includes(name));
  if (named.length === 0) return [];
  const declared = new Set<string>();
  const ids: Identifier[] = [];
  parseStatements(code, MODULE_PARSE_OPTIONS, {
    onStatement: (statement) => {
      const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
      if (declaration === null || declaration === undefined) return;
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) bindingIdentifiers(declarator.id, ids);
      } else if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        declared.add(declaration.id.name);
      } else if (declaration.type === 'ImportDeclaration') {
        for (const specifier of declaration.specifiers) declared.add(specifier.local.name);
      }
    },
  });
  for (const id of ids) declared.add(id.name);
  return named.filter((name) => !declared.has(name));
}

/**
 * What staging reads of an ES module's text, once, where the module is read
 * (the transform host; its store keeps the reading with the module): its
 * import sites, its EsModuleFacts, and in Bun's `scope` the CommonJS names
 * its meta instance binds.
 */
export function readEsModule(code: string, scope: ModuleScope | undefined): ImportSites {
  return {
    ...readModuleImportSites(code),
    ...esModuleFacts(code),
    ...(scope === 'bun' ? { commonJsNames: bunScopeNames(code) } : {}),
  };
}

/** What ESM_META_MODULE exports a Bun module's CommonJS names as. */
const COMMONJS_NAME_EXPORTS: Readonly<Record<string, string>> = { require: 'q', __filename: 'f', __dirname: 'd' };

/** The facade of a builtin or CommonJS module: its exports, read from what its meta instance's `l` loads. */
function facadeModule(name: string, id: number, names: readonly string[], resync: boolean): string {
  const exported = names.filter((name) => name !== 'default');
  const lines = [
    'c();',
    'const m = l();',
    'export default m;',
  ];
  if (exported.length > 0) {
    const read = resync
      ? (name: string) => `m[${JSON.stringify(name)}]`
      : (name: string) => `v(${JSON.stringify(name)})`;
    if (!resync) {
      // Node's CommonJS namespace: an own property's value when the module has
      // loaded, undefined otherwise, and a throwing getter reads as undefined.
      lines.push('const o = Object.prototype.hasOwnProperty, v = (k) => { if (m === null || m === undefined || !o.call(m, k)) return undefined; try { return m[k]; } catch { return undefined; } };');
    }
    lines.push(
      `let ${exported.map((name, i) => `$${i} = ${read(name)}`).join(', ')};`,
      `export { ${exported.map((name, i) => `$${i} as ${JSON.stringify(name)}`).join(', ')} };`,
    );
    // module.syncBuiltinESMExports() reads a builtin's names again.
    if (resync) lines.push(`s(() => { ${exported.map((name, i) => `$${i} = ${read(name)};`).join(' ')} });`);
  }
  lines.push('r();', metaImport(name, id, [['c', 'c'], ['l', 'l'], ['r', 'r'], ...(resync ? [['s', 's'] as const] : [])]));
  return lines.join('\n') + '\n';
}

/**
 * The facade an ES module imports CommonJS module `id` through (Node's
 * createCJSModuleWrap): it loads the module as require() does, at its place
 * in the graph's evaluation; `default` is module.exports and each of `names`
 * (cjs-module-exports.ts) its own property's value then.
 */
export function commonJsFacadeModule(name: string, id: number, names: readonly string[]): string {
  return facadeModule(name, id, names, false);
}

/**
 * The facade an ES module imports builtin `id` through (Node's
 * getESMFacade): `default` is the builtin itself, the object require()
 * gives, and each of `names` (node-builtin-exports.ts) its value, until
 * module.syncBuiltinESMExports() reads them again.
 */
export function builtinFacadeModule(name: string, id: number, names: readonly string[]): string {
  return facadeModule(name, id, names, true);
}

/**
 * The module an ES module imports JSON file `id` through (Node's JSON
 * translator): `default` is the file's value, the object require() gives
 * for the same file, which its meta instance's `l` loads.
 */
export function jsonFacadeModule(name: string, id: number): string {
  return facadeModule(name, id, [], false);
}

/**
 * ESM_META_MODULE: one instance per staged module (`?<id>`). Its evaluation
 * hands the module its bindings from the runner (ESM_HOST_MODULE's `host`),
 * which tags the module with the batch evaluating it. On workerd it is the
 * module's gate (`await`, see the header); a host with no request context to
 * reach has none, so its graphs stay synchronous for require().
 */
export function metaModuleSource(gate: boolean): string {
  return [
    `import { host } from ${JSON.stringify(relativeSpecifier(ESM_META_MODULE, ESM_HOST_MODULE))};`,
    'export const { m, i, c, r, l, s, q, f, d } = host.enter(import.meta.url);',
    gate ? 'await 0;' : '',
  ].join('\n');
}

/** ESM_HOST_MODULE: what the runner fills before the program's first import. */
export const ESM_HOST_SOURCE = 'export const host = Object.create(null);\n';
