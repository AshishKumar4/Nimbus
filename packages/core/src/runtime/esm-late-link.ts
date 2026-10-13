/**
 * runtime/esm-late-link.ts — Node's link of a late ES module graph: one the
 * interpreter evaluates (a module a program wrote after its launch began, a
 * query's or a fragment's instance, a staged module the registry hands on),
 * with the staged modules it reaches. Node links a whole graph before any of
 * it runs: every static import resolves and loads, and every name a module
 * imports is one its module exports (ECMA-262 ResolveExport), or the import
 * rejects and no body runs.
 *
 * node-shims gives the facts (LateLinkHost: the registry's rows, the
 * resolver, the files, the interpreter's reading of a module); this decides.
 * It is a runtime module of its own (RUNTIME_ESM_LATE_MODULE, with Node's
 * CommonJS lexer), so a launch whose imports never need it never compiles it.
 */

import type { ModuleRequests } from '../interpreter/index.js';
import { cjsModuleExportNames } from './cjs-module-exports.js';

/** What the loader resolves a static import to. */
export interface LateResolution {
  readonly url: string;
  readonly format: string;
  readonly path?: string;
  readonly builtin?: string;
}

/**
 * A staged module row's bindings (worker facets/esm-stage.ts EsmRowBindings,
 * a module's): its own names, the rows its `export *`s reach, by static
 * import that reads names the row it loads, its specifier as written and the
 * names, and its names that are another row's (the name, the row, the name
 * there; null for its namespace).
 */
export type ModuleRowFacts = readonly [
  exports: readonly string[],
  stars: readonly number[],
  imports: readonly (readonly [row: number, specifier: string, ...names: string[]])[],
  reexports?: readonly (readonly [exported: string, row: number, name: string | null])[],
];

export interface LateLinkHost {
  /** The staged row of `kind` at `key` (a builtin's name), or -1. */
  row(kind: 'module' | 'commonjs' | 'json' | 'builtin', key: string): number;
  /** A staged row's kind: 'module', or a facade's ('commonjs', 'json', 'builtin'). */
  rowKind(row: number): string;
  /** The launch's row bindings, as staging wrote them (worker facets/esm-stage.ts EsmRowBindings): JSON, by row. */
  rowBindings(): string;
  /** A staged module row's static targets: a row, or -2 - i for the staging refused as missing(i). */
  rowTargets(row: number): readonly number[];
  /** Whether a staged row has run, or the interpreter took it over. */
  rowSettled(row: number): boolean;
  /** The staging refused as -2 - i: a query's or a fragment's instance handed on (its URL), or Node's refusal. */
  missing(i: number): { readonly handedOn: string } | { readonly refusal: Error } | null;
  /** The source of the module at `key`: staged row `row`'s, else (-1) its file's; null where none. */
  source(key: string, row: number): string | null;
  /** The format the file at `key` has by its extension or its package, else undefined (its syntax decides). */
  fileFormat(key: string): 'module' | 'commonjs' | undefined;
  /** Loads the module at `key`, which its parser could not read, as the interpreter does: for the error it throws. */
  loadUnread(key: string, text: string, format: 'module' | 'commonjs' | undefined): void;
  /**
   * `specifier` from `parentUrl`, resolved as an import and loadable, and,
   * where `type` is not undefined, checked against its type attribute;
   * else Node's error, as the loader's own (no arrow of the importer's).
   */
  resolve(specifier: string, parentUrl: string, type: string | null | undefined): LateResolution;
  /** A builtin's exports. */
  builtin(name: string): object | null | undefined;
  /** The file require() loads for `specifier` from the module at `parentPath`, or null. */
  cjsResolve(specifier: string, parentPath: string): string | null;
  /** Node's message for `name`, which the module `specifier` names does not export. */
  exportMessage(specifier: string, name: string, commonjs: boolean): string;
  /** `error` thrown as the loader's own (no arrow of the importer's). */
  decorate(error: Error): Error;
  /** A module's requests and bindings, as the interpreter reads it with the loader's parse goal (interpreter/index.ts moduleRequests). */
  requests(path: string, text: string, javaScript: boolean, goal: 'module' | 'commonjs' | 'detect'): ModuleRequests;
}

/**
 * What a late module's static import loads, as the link reads its names: a
 * staged row (a module, a facade, a JSON module), a late module by URL, or
 * the names of a builtin, a JSON file or a CommonJS module with no facade
 * (Node's lexer's, read before any body runs). Null where its format is its
 * syntax's.
 */
type LateTarget =
  | { readonly row: number; readonly url?: undefined; readonly names?: undefined }
  | { readonly row?: undefined; readonly url: string; readonly names?: undefined }
  | { readonly row?: undefined; readonly url: string; readonly names: readonly string[]; readonly commonjs: boolean };

interface LateEdge {
  readonly target: LateTarget | null;
  readonly specifier: string;
  readonly names: readonly string[];
}

/** A late module, by what its static imports read (known: its bindings were read). */
interface LateNode {
  readonly known: boolean;
  readonly exports: readonly string[];
  readonly stars: (LateTarget | null)[];
  readonly imports: LateEdge[];
  readonly reexports: [exported: string, target: LateTarget | null, name: string | null][];
}

/** A late graph: its modules the interpreter evaluates, by URL, and the staged rows of it not yet evaluated. */
interface LateGraph {
  readonly modules: Map<string, LateNode>;
  readonly rows: number[];
}

/** A row's bindings: a module's, a facade's names, or null where unknown. */
type RowBindings = ModuleRowFacts | readonly string[] | null;

/** The launch's row bindings, read once. */
let rowBindings: readonly RowBindings[] | undefined;

function bindingsOf(host: LateLinkHost, row: number): RowBindings {
  if (rowBindings === undefined) {
    try {
      const parsed: readonly RowBindings[] = JSON.parse(host.rowBindings());
      rowBindings = parsed;
    } catch {
      rowBindings = [];
    }
  }
  return rowBindings[row] ?? null;
}

const isModuleRow = (bindings: ModuleRowFacts | readonly string[]): bindings is ModuleRowFacts => Array.isArray(bindings[0]);

/** A staged module row's bindings, or null where unknown. */
function moduleFacts(host: LateLinkHost, row: number): ModuleRowFacts | null {
  const bindings = bindingsOf(host, row);
  return bindings !== null && isModuleRow(bindings) ? bindings : null;
}

/** A facade row's export names, or null where unknown. */
function rowNames(host: LateLinkHost, row: number): readonly string[] | null {
  const bindings = bindingsOf(host, row);
  return bindings !== null && !isModuleRow(bindings) ? bindings : null;
}

/** Every late module a link has read, by URL: what an interpreted module's `export *` asks of (starConflicts). */
const lateModules = new Map<string, LateNode>();

/** The CommonJS modules' names Node's lexer found, by path. */
const commonJsNameCache = new Map<string, Set<string>>();

/**
 * The names Node's loader finds in the CommonJS module at `key` before it
 * runs: a staged facade's, else Node's lexer's over its source and the
 * modules it re-exports (cjs-module-exports.ts), `default` first.
 */
export function commonJsNames(host: LateLinkHost, key: string): readonly string[] {
  const facade = host.row('commonjs', key);
  const staged = facade === -1 ? null : rowNames(host, facade);
  if (staged !== null) return staged;
  return [...cjsModuleExportNames(`/${key}`, { source: (path) => host.source(path.replace(/^\/+/, ''), -1), resolve: host.cjsResolve }, commonJsNameCache)];
}

/**
 * Links the late graph of the module at `key` (`url`): throws the refusal
 * of a static import anywhere in it that does not resolve or load, or of a
 * name a module of it imports that its module does not export. Answers the
 * staged modules it imports, in import order, for the caller to evaluate
 * before the interpreter does the rest.
 */
export function linkLateGraph(host: LateLinkHost, key: string, url: string): number[] {
  const order: number[] = [];
  const late: LateGraph = { modules: new Map(), rows: [] };
  plan(host, key, url, new Set(), order, new Set(), late);
  checkBindings(host, late, url);
  return order;
}

/** The names the `export *`s of the interpreted module at `url` reach two different bindings of, which its namespace omits. */
export function starConflicts(host: LateLinkHost, url: string): string[] {
  const late: LateGraph = { modules: lateModules, rows: [] };
  // A staged module the interpreter evaluates, by its file; not a query's or a fragment's instance.
  const { protocol, search, hash, pathname } = new URL(url);
  const row = protocol === 'file:' && search === '' && hash === '' ? host.row('module', decodeURIComponent(pathname).replace(/^\/+/, '')) : -1;
  const target: LateTarget | null = lateModules.has(url) ? { url } : row !== -1 ? { row } : null;
  const names = target === null ? null : exportedNames(host, late, target, new Set());
  if (target === null || names === null) return [];
  return names.filter((name) => resolveExport(host, late, target, name, new Set()) === AMBIGUOUS);
}

function plan(host: LateLinkHost, key: string, url: string, seen: Set<string>, order: number[], checked: Set<number>, late: LateGraph): void {
  if (seen.has(url)) return;
  seen.add(url);
  const staged = host.row('module', key);
  const text = host.source(key, staged);
  if (text === null) return;
  // Read with the parse goal the loader gives it: an adopted staged module's, a module; another's, its format.
  const format = staged !== -1 ? 'module' : host.fileFormat(key);
  const analysis = host.requests(key, text, staged !== -1, format ?? 'detect');
  // A module its parser could not read (a syntax error, TypeScript, JSX) is
  // loaded as the interpreter loads it, for that load's error, before any
  // body runs; a staged one is the launch's own to link.
  if (analysis.unread !== undefined && staged === -1) host.loadUnread(key, text, format);
  // The interpreter's lists (SafeLists: no methods) are read by index.
  const bindings = analysis.bindings;
  let statics = 0;
  for (const request of analysis.requests) if (request.kind === 'static') statics++;
  const known = bindings !== undefined && bindings.imports.length === statics;
  const exports: string[] = [];
  if (known) for (let i = 0; i < bindings.exports.length; i++) exports.push(bindings.exports[i]);
  const node: LateNode = { known, exports, stars: [], imports: [], reexports: [] };
  late.modules.set(url, node);
  lateModules.set(url, node);
  let at = -1;
  for (const request of analysis.requests) {
    if (request.kind !== 'static') continue;
    at++;
    // Checked against its attributes as the interpreter's static import checks it.
    const resolution = host.resolve(request.specifier, url, known ? bindings.types[at] : undefined);
    if (known) {
      const loads = lateTarget(host, resolution);
      for (let i = 0; i < bindings.stars.length; i++) if (bindings.stars[i] === at) node.stars.push(loads);
      const names: string[] = [];
      const reads = bindings.imports[at];
      for (let i = 0; i < reads.length; i++) names.push(reads[i]);
      if (names.length > 0) node.imports.push({ target: loads, specifier: request.specifier, names });
      for (let i = 0; i < bindings.reexports.length; i++) {
        const entry = bindings.reexports[i];
        if (entry[1] === at) node.reexports.push([entry[0], loads, entry[2]]);
      }
    }
    if (resolution.path === undefined) continue;
    const target = resolution.path.replace(/^\/+/, '');
    const { search, hash } = new URL(resolution.url);
    const id = host.row('module', target);
    // An unstaged module, or a query's or a fragment's instance (the interpreter's own): its closure is the late graph's too.
    if (id === -1 || search !== '' || hash !== '') {
      // What the interpreter loads as an ES module (a CommonJS module compiles when it evaluates, as Node's does).
      if (resolution.format === 'module' || resolution.format === 'detect') plan(host, target, resolution.url, seen, order, checked, late);
      continue;
    }
    checkLinks(host, id, seen, checked, late);
    if (!order.includes(id)) order.push(id);
  }
}

function lateTarget(host: LateLinkHost, resolution: LateResolution): LateTarget | null {
  if (resolution.format === 'builtin' && resolution.builtin !== undefined) {
    const id = host.row('builtin', resolution.builtin);
    if (id !== -1) return { row: id };
    const exports = host.builtin(resolution.builtin);
    return { url: resolution.url, names: ['default', ...(typeof exports === 'object' && exports !== null ? Object.keys(exports) : [])], commonjs: false };
  }
  if (resolution.path === undefined) return null;
  const key = resolution.path.replace(/^\/+/, '');
  const { search, hash } = new URL(resolution.url);
  if (search === '' && hash === '') {
    const id = host.row('module', key);
    if (id !== -1) return { row: id };
    const facade = host.row(resolution.format === 'json' ? 'json' : 'commonjs', key);
    if (facade !== -1) return { row: facade };
  }
  if (resolution.format === 'module' || resolution.format === 'detect') return { url: resolution.url };
  if (resolution.format === 'json') return { url: resolution.url, names: ['default'], commonjs: false };
  if (resolution.format === 'commonjs') return { url: resolution.url, names: commonJsNames(host, key), commonjs: true };
  return null;
}

/**
 * Throws the refusal of a static import staged row `id`'s unevaluated graph
 * makes that staging refused for good. A staging handed on (a query's or a
 * fragment's instance, which the interpreter evaluates where it is
 * imported) is planned as the late graph's own. The graph's unevaluated
 * rows go to `late`.
 */
function checkLinks(host: LateLinkHost, id: number, seen: Set<string>, checked: Set<number>, late: LateGraph): void {
  const visit = (at: number): void => {
    if (checked.has(at)) return;
    checked.add(at);
    if (host.rowKind(at) !== 'module' || host.rowSettled(at)) return;
    late.rows.push(at);
    for (const target of host.rowTargets(at)) {
      if (target >= 0) {
        visit(target);
        continue;
      }
      const missing = host.missing(-2 - target);
      if (missing === null) continue;
      if ('refusal' in missing) throw missing.refusal;
      const handed = new URL(missing.handedOn);
      plan(host, decodeURIComponent(handed.pathname).replace(/^\/+/, ''), missing.handedOn, seen, [], checked, late);
    }
  };
  visit(id);
}

/**
 * Each name a module of the late graph imports is one its module exports,
 * dependencies first, as Node's linker reaches them: else Node's
 * SyntaxError. A name whose module's names are not known here is the
 * interpreter's to find.
 */
function checkBindings(host: LateLinkHost, late: LateGraph, rootUrl: string): void {
  const pending = new Set(late.rows);
  const visited = new Set<string>();
  const visit = (target: LateTarget | null): void => {
    if (target === null || target.names !== undefined) return;
    if (target.row !== undefined && !pending.has(target.row)) return;
    const mark = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
    if (visited.has(mark)) return;
    visited.add(mark);
    const edges = edgesOf(host, late, target);
    for (const edge of edges) visit(edge.target);
    for (const edge of edges) {
      for (const name of edge.names) {
        const resolution = resolveExport(host, late, edge.target, name, new Set());
        if (resolution !== null && resolution !== AMBIGUOUS) continue;
        const loads = edge.target;
        const commonjs = loads !== null && (loads.row !== undefined ? host.rowKind(loads.row) === 'commonjs' : loads.names !== undefined && loads.commonjs);
        throw host.decorate(new SyntaxError(resolution === AMBIGUOUS
          ? `The requested module '${edge.specifier}' contains conflicting star exports for name '${name}'`
          : host.exportMessage(edge.specifier, name, commonjs)));
      }
    }
  };
  visit({ url: rootUrl });
  for (const url of late.modules.keys()) visit({ url });
  for (const row of late.rows) visit({ row });
}

function edgesOf(host: LateLinkHost, late: LateGraph, target: LateTarget): readonly LateEdge[] {
  if (target.row === undefined) return late.modules.get(target.url)?.imports ?? [];
  const facts = host.rowKind(target.row) === 'module' ? moduleFacts(host, target.row) : null;
  if (facts === null) return [];
  return facts[2].map(([row, specifier, ...names]) => ({ target: { row }, specifier, names }));
}

/** A name its module's `export *`s reach two different bindings of. */
const AMBIGUOUS = 'ambiguous';

interface Binding {
  readonly module: string;
  /** The binding's name in its module; '*' for its namespace. */
  readonly binding: string;
}

/** A late or staged module's own names, `export *`s and indirect entries; null where not known here. */
function factsOf(host: LateLinkHost, late: LateGraph, target: LateTarget) {
  if (target.row === undefined) {
    const node = late.modules.get(target.url);
    return node === undefined || !node.known ? null : node;
  }
  const facts = moduleFacts(host, target.row);
  if (facts === null) return null;
  return {
    exports: facts[0],
    stars: facts[1].map((row): LateTarget => ({ row })),
    reexports: (facts[3] ?? []).map(([exported, row, name]): [string, LateTarget, string | null] => [exported, { row }, name]),
  };
}

/**
 * ECMA-262 ResolveExport of `name` of `target`: its binding, null where it
 * has no such export, AMBIGUOUS where its `export *`s reach two different
 * bindings of it, undefined where its names are not known here.
 */
function resolveExport(host: LateLinkHost, late: LateGraph, target: LateTarget | null, name: string, resolving: Set<string>): Binding | null | typeof AMBIGUOUS | undefined {
  if (target === null) return undefined;
  if (target.names !== undefined) return target.names.includes(name) ? { module: `u${target.url}`, binding: name } : null;
  const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
  if (target.row !== undefined && host.rowKind(target.row) !== 'module') {
    const names = rowNames(host, target.row);
    return names === null ? undefined : names.includes(name) ? { module, binding: name } : null;
  }
  // A circular import request: nothing more to find this way.
  if (resolving.has(`${module}\0${name}`)) return null;
  resolving.add(`${module}\0${name}`);
  const facts = factsOf(host, late, target);
  if (facts === null) return undefined;
  for (const [exported, from, imported] of facts.reexports) {
    if (exported !== name) continue;
    if (imported !== null) return resolveExport(host, late, from, imported, resolving);
    if (from === null) return undefined;
    return { module: from.row !== undefined ? `r${from.row}` : `u${from.url}`, binding: '*' };
  }
  if (facts.exports.includes(name)) return { module, binding: name };
  if (name === 'default') return null;
  let found: Binding | null = null;
  let unknown = false;
  for (const star of facts.stars) {
    const resolution = resolveExport(host, late, star, name, resolving);
    if (resolution === AMBIGUOUS) return resolution;
    if (resolution === undefined) unknown = true;
    else if (resolution === null) continue;
    else if (found === null) found = resolution;
    else if (found.module !== resolution.module || found.binding !== resolution.binding) return AMBIGUOUS;
  }
  return unknown ? undefined : found;
}

/** ECMA-262 GetExportedNames of `target`: its own names, and its `export *`s' but `default`; null where not known here. */
function exportedNames(host: LateLinkHost, late: LateGraph, target: LateTarget | null, seen: Set<string>): readonly string[] | null {
  if (target === null) return null;
  if (target.names !== undefined) return target.names;
  if (target.row !== undefined && host.rowKind(target.row) !== 'module') return rowNames(host, target.row);
  const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
  if (seen.has(module)) return [];
  seen.add(module);
  const facts = factsOf(host, late, target);
  if (facts === null) return null;
  const names = new Set(facts.exports);
  for (const star of facts.stars) {
    const starred = exportedNames(host, late, star, seen);
    if (starred === null) return null;
    for (const starName of starred) if (starName !== 'default') names.add(starName);
  }
  return [...names];
}
