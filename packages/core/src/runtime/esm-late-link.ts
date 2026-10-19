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
import { urlHash, urlHref, urlPathname, urlProtocol, urlSearch, urlSetPathname } from '../_shared/package-map.js';
import {
  arrayIncludes, dataDescriptor, decodeURIComponentOf, Error, JSONParse, mathMin, newURL, objectHasOwn, ownField,
  reflectDefineProperty, SafeList, SafeMap, SafeSet, setForEach, stringIncludes, stringSlice, stringStartsWith, SyntaxError,
} from '../_shared/primordials.js';
import { cjsModuleExportNames } from './cjs-module-exports.js';
import { dataModule } from './esm-loader-policy.js';

function stripLeadingSlashes(path: string): string {
  let start = 0;
  while (start < path.length && path[start] === '/') start++;
  return stringSlice(path, start);
}

function bindingsOf(analysis: ModuleRequests | null): ModuleRequests['bindings'] {
  return analysis !== null && objectHasOwn(analysis, 'bindings') ? analysis['bindings'] : undefined;
}

/** What the loader resolves a static import to. */
export interface LateResolution {
  readonly url: string;
  readonly format: string;
  readonly path?: string;
  readonly builtin?: string;
}

/**
 * A module's facts, as its source reads, by what its static imports load:
 * its own names, and the binding of each that is its own; what its
 * `export *`s load; each static import that reads names, with its specifier
 * as written; and its names that are another module's (the name, what loads
 * that module, the name there; null for its namespace).
 */
interface ModuleFacts {
  readonly exports: readonly string[];
  readonly locals: readonly (readonly [exported: string, local: string])[];
  readonly stars: readonly (LateTarget | null)[];
  readonly imports: readonly LateEdge[];
  readonly reexports: readonly (readonly [exported: string, target: LateTarget | null, name: string | null])[];
}

export interface LateLinkHost {
  /** The staged row of `kind` at `key` (a builtin's name), or -1. */
  row(kind: 'module' | 'commonjs' | 'json' | 'builtin', key: string): number;
  /** A staged row's kind: 'module', or a facade's ('commonjs', 'json', 'builtin'). */
  rowKind(row: number): string;
  /** A staged row's key: a module's path, a builtin's name. */
  rowKey(row: number): string;
  /** The facades' export names, as staging wrote them (worker facets/esm-stage.ts EsmRowBindings): JSON, by row. */
  rowBindings(): string;
  /** A staged module row's static targets: a row, or -2 - i for the staging refused as missing(i). */
  rowTargets(row: number): readonly number[];
  /** Whether a staged row has run, or the interpreter took it over. */
  rowSettled(row: number): boolean;
  /**
   * The staging refused as -2 - i: a module handed on (its URL: a query's or
   * a fragment's instance, a data: module, or a file the launch lacked or did
   * not stage, resolved again when it is linked), or Node's refusal.
   */
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
  /** A builtin's export names: `default`, and its own (a function's too). */
  builtinNames(name: string): readonly string[];
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
  | { readonly row: number; readonly url: undefined; readonly names: undefined }
  | { readonly row: undefined; readonly url: string; readonly names: undefined }
  | { readonly row: undefined; readonly url: string; readonly names: readonly string[]; readonly commonjs: boolean };

const rowTarget = (row: number): LateTarget => ({ row, url: undefined, names: undefined });
const moduleTarget = (url: string): LateTarget => ({ row: undefined, url, names: undefined });
const namedTarget = (url: string, names: readonly string[], commonjs: boolean): LateTarget => ({ row: undefined, url, names, commonjs });

interface LateEdge {
  readonly target: LateTarget | null;
  readonly specifier: string;
  readonly names: readonly string[];
}

/** A late module, by what its static imports read (known: its bindings were read). */
interface LateNode extends ModuleFacts {
  readonly known: boolean;
  readonly locals: SafeList<[exported: string, local: string]>;
  readonly stars: SafeList<LateTarget | null>;
  readonly imports: SafeList<LateEdge>;
  readonly reexports: SafeList<[exported: string, target: LateTarget | null, name: string | null]>;
}

/** A late graph: its modules the interpreter evaluates, by URL, and the staged rows of it not yet evaluated. */
interface LateGraph {
  readonly modules: SafeMap<string, LateNode>;
  readonly rows: SafeList<number>;
  /** An import()'s link: a module it fails in keeps the failure (linkFailures); a require()'s retries, as Node's does. */
  readonly kept: boolean;
}

/** The facades' export names, by row, read once. */
let facadeNames: readonly (readonly string[] | null)[] | undefined;

/** A facade row's export names, or null where unknown. */
function rowNames(host: LateLinkHost, row: number): readonly string[] | null {
  if (facadeNames === undefined) {
    try {
      const parsed: readonly (readonly string[] | null)[] = JSONParse(host.rowBindings());
      facadeNames = parsed;
    } catch {
      facadeNames = [];
    }
  }
  return objectHasOwn(facadeNames, row) ? facadeNames[row] ?? null : null;
}

/** A staged module row's source as read: its requests and bindings, and its static imports' specifiers in order. */
interface RowRead {
  readonly analysis: ModuleRequests | null;
  readonly specifiers: readonly string[];
}

/** Staged module rows as read, by row, once each. */
const rowReads = new SafeMap<number, RowRead>();

/** A staged module row's source, read once (its static imports index its targets). */
function rowRead(host: LateLinkHost, row: number): RowRead {
  const known = rowReads.get(row);
  if (known !== undefined) return known;
  const key = host.rowKey(row);
  const text = host.source(key, row);
  const analysis = text === null ? null : host.requests(key, text, true, 'module');
  const specifiers = new SafeList<string>();
  if (analysis !== null) {
    for (let i = 0; i < analysis.requests.length; i++) {
      const request = analysis.requests[i];
      if (request.kind === 'static') specifiers[specifiers.length] = request.specifier;
    }
  }
  const read = { analysis, specifiers };
  rowReads.set(row, read);
  return read;
}

/** Staged module rows' facts, by row, read from their sources when a link first needs them. */
const rowFacts = new SafeMap<number, ModuleFacts | null>();

/** A staged module row's facts, or null where its source does not tell them. */
function moduleFacts(host: LateLinkHost, row: number): ModuleFacts | null {
  const known = rowFacts.get(row);
  if (known !== undefined) return known;
  let facts: ModuleFacts | null = null;
  const key = host.rowKey(row);
  const { analysis, specifiers } = rowRead(host, row);
  const bindings = bindingsOf(analysis);
  const targets = host.rowTargets(row);
  if (bindings !== undefined && bindings.imports.length === targets.length && specifiers.length === targets.length) {
    // What static import `at` loads: a row, or what staging handed it on to.
    const loads = (at: number): LateTarget | null => {
      if (targets[at] >= 0) return rowTarget(targets[at]);
      const missing = host.missing(-2 - targets[at]);
      const handedOn = missing === null ? undefined : ownField(missing, 'handedOn');
      if (typeof handedOn !== 'string') return null;
      const file = handedOnFile(host, key, handedOn, specifiers[at], bindings.types[at]);
      return file === null ? handedOnTarget(handedOn) : lateTarget(host, file);
    };
    const exports = new SafeList<string>();
    for (let i = 0; i < bindings.exports.length; i++) exports[exports.length] = bindings.exports[i];
    const locals = new SafeList<[string, string]>();
    for (let i = 0; i < bindings.locals.length; i++) locals[locals.length] = [bindings.locals[i][0], bindings.locals[i][1]];
    const stars = new SafeList<LateTarget | null>();
    for (let i = 0; i < bindings.stars.length; i++) stars[stars.length] = loads(bindings.stars[i]);
    const imports = new SafeList<LateEdge>();
    for (let at = 0; at < targets.length; at++) {
      const names = new SafeList<string>();
      for (let i = 0; i < bindings.imports[at].length; i++) names[names.length] = bindings.imports[at][i];
      if (names.length > 0) imports[imports.length] = { target: loads(at), specifier: specifiers[at], names };
    }
    const reexports = new SafeList<[string, LateTarget | null, string | null]>();
    for (let i = 0; i < bindings.reexports.length; i++) {
      const entry = bindings.reexports[i];
      reexports[reexports.length] = [entry[0], loads(entry[1]), entry[2]];
    }
    facts = { exports, locals, stars, imports, reexports };
  }
  rowFacts.set(row, facts);
  return facts;
}

/**
 * The modules an import()'s link failed in, by instance (a file's path; a
 * query's, a fragment's or a data: module's URL): the module a static
 * import of did not resolve or load, and each that imports it on the way
 * from the link's root. The failure stays, as Node's loader keeps a
 * ModuleJob that did not link: a later link reaching one fails with it,
 * whatever the program wrote since.
 */
const linkFailures = new SafeMap<string, Error>();

/** The failure an import()'s link kept for the staged module at `key` (linkFailures): what a later load of it throws. */
export function keptFailure(key: string): Error | undefined {
  return linkFailures.get(key);
}

/** Every late module a link has read, by URL: what an interpreted module's `export *` asks of (starConflicts). */
const lateModules = new SafeMap<string, LateNode>();

/** The CommonJS modules' names Node's lexer found, by path. */
const commonJsNameCache = new SafeMap<string, Set<string>>();

/**
 * The names Node's loader finds in the CommonJS module at `key` before it
 * runs: a staged facade's, else Node's lexer's over its source and the
 * modules it re-exports (cjs-module-exports.ts), `default` first.
 */
export function commonJsNames(host: LateLinkHost, key: string): readonly string[] {
  const facade = host.row('commonjs', key);
  const staged = facade === -1 ? null : rowNames(host, facade);
  if (staged !== null) return staged;
  const out: string[] = [];
  const names = cjsModuleExportNames(`/${key}`, { source: (path) => host.source(stripLeadingSlashes(path), -1), resolve: host.cjsResolve }, commonJsNameCache);
  setForEach(names, (name) => { reflectDefineProperty(out, out.length, dataDescriptor(name, true, true, true)); });
  return out;
}

/**
 * Links the late graph of the module at `key` (`url`): throws the refusal
 * of a static import anywhere in it that does not resolve or load, or of a
 * name a module of it imports that its module does not export. Answers the
 * staged modules it imports, in import order, for the caller to evaluate
 * before the interpreter does the rest.
 */
export function linkLateGraph(host: LateLinkHost, key: string, url: string, kept: boolean): number[] {
  const order: number[] = [];
  const late: LateGraph = { modules: new SafeMap(), rows: new SafeList(), kept };
  plan(host, key, url, new SafeSet(), order, new SafeSet(), late);
  checkBindings(host, late, url);
  for (let i = 0; i < late.rows.length; i++) checkedRows.add(late.rows[i]);
  return order;
}

/** The staged rows whose graphs a link checked, every imported name in them: none is checked again. */
const checkedRows = new SafeSet<number>();

/**
 * Links staged row `id` (its module at `key`, `url`), which the interpreter
 * adopts because workerd could not link its graph (it reaches a module
 * staging handed on, or one the interpreter took), as a late graph is
 * linked: unless a link already checked it (the late graph that imports it).
 */
export function linkAdopted(host: LateLinkHost, id: number, key: string, url: string): void {
  if (checkedRows.has(id)) return;
  linkLateGraph(host, key, url, true);
  checkedRows.add(id);
}

/** The names the `export *`s of the interpreted module at `url` reach two different bindings of, which its namespace omits. */
export function starConflicts(host: LateLinkHost, url: string): string[] {
  const late: LateGraph = { modules: lateModules, rows: new SafeList(), kept: false };
  // A staged module the interpreter evaluates, by its file; not a query's or a fragment's instance.
  const parsed = newURL(url);
  const protocol = urlProtocol(parsed);
  const search = urlSearch(parsed);
  const hash = urlHash(parsed);
  const pathname = urlPathname(parsed);
  const row = protocol === 'file:' && search === '' && hash === '' ? host.row('module', stripLeadingSlashes(decodeURIComponentOf(pathname))) : -1;
  const target = lateModules.has(url) ? moduleTarget(url) : row !== -1 ? rowTarget(row) : null;
  const names = target === null ? null : exportedNames(host, late, target, new SafeSet());
  if (target === null || names === null) return [];
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (resolveExport(host, late, target, name, new SafeSet()) === AMBIGUOUS) reflectDefineProperty(out, out.length, dataDescriptor(name, true, true, true));
  }
  return out;
}

/**
 * The names of the namespace of the late module at `url`, as its link read
 * them: its own and its `export *`s', but those two of them reach different
 * bindings of; null where its link did not read them (one not linked, or
 * whose names its source does not tell). Known before its body runs, so a
 * namespace taken in a cycle has them all.
 */
export function namespaceNames(host: LateLinkHost, url: string): string[] | null {
  const late: LateGraph = { modules: lateModules, rows: new SafeList(), kept: false };
  if (!lateModules.has(url)) return null;
  const target = moduleTarget(url);
  const names = exportedNames(host, late, target, new SafeSet());
  if (names === null) return null;
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (resolveExport(host, late, target, name, new SafeSet()) !== AMBIGUOUS) reflectDefineProperty(out, out.length, dataDescriptor(name, true, true, true));
  }
  return out;
}

/**
 * Plans the late module at `url` (a file's at `key`; a data: URL's is its
 * URL): its static imports' modules, their names, and the staged rows it
 * reaches, into `late` and `order`.
 */
function plan(host: LateLinkHost, key: string, url: string, seen: SafeSet<string>, order: number[], checked: SafeSet<number>, late: LateGraph): void {
  if (seen.has(url)) return;
  seen.add(url);
  const instance = stringStartsWith(url, 'file:') && !stringIncludes(url, '?') && !stringIncludes(url, '#') ? key : url;
  const failure = linkFailures.get(instance);
  if (failure !== undefined) throw failure;
  try {
    planModule(host, key, url, seen, order, checked, late);
  } catch (e) {
    if (late.kept && e instanceof Error) linkFailures.set(instance, e);
    throw e;
  }
}

function planModule(host: LateLinkHost, key: string, url: string, seen: SafeSet<string>, order: number[], checked: SafeSet<number>, late: LateGraph): void {
  // A data: URL's module is its body, an ES module (its MIME type's goal): no row, no file.
  const data = stringStartsWith(url, 'data:') ? dataModule(url) : null;
  const staged = data !== null ? -1 : host.row('module', key);
  const text = data !== null ? (data.format === 'module' ? data.source : null) : host.source(key, staged);
  if (text === null) return;
  // Read with the parse goal the loader gives it: an adopted staged module's, a module; another's, its format.
  const format = staged !== -1 || data !== null ? 'module' : host.fileFormat(key);
  const analysis = host.requests(key, text, staged !== -1 || data !== null, format ?? 'detect');
  // A module its parser could not read (a syntax error, TypeScript, JSX) is
  // loaded as the interpreter loads it, for that load's error, before any
  // body runs; a staged one is the launch's own to link.
  if (ownField(analysis, 'unread') !== undefined && staged === -1) host.loadUnread(key, text, format);
  // The interpreter's lists (SafeLists: no methods) are read by index.
  const bindings = bindingsOf(analysis);
  let statics = 0;
  for (let i = 0; i < analysis.requests.length; i++) if (analysis.requests[i].kind === 'static') statics++;
  const known = bindings !== undefined && bindings.imports.length === statics;
  const exports = new SafeList<string>();
  const locals = new SafeList<[string, string]>();
  if (known) {
    for (let i = 0; i < bindings.exports.length; i++) exports[exports.length] = bindings.exports[i];
    for (let i = 0; i < bindings.locals.length; i++) locals[locals.length] = [bindings.locals[i][0], bindings.locals[i][1]];
  }
  const node: LateNode = { known, exports, locals, stars: new SafeList(), imports: new SafeList(), reexports: new SafeList() };
  late.modules.set(url, node);
  lateModules.set(url, node);
  let at = -1;
  for (let index = 0; index < analysis.requests.length; index++) {
    const request = analysis.requests[index];
    if (request.kind !== 'static') continue;
    at++;
    // Checked against its attributes as the interpreter's static import checks it.
    const resolution = host.resolve(request.specifier, url, known ? bindings.types[at] : undefined);
    if (known) {
      const loads = lateTarget(host, resolution);
      for (let i = 0; i < bindings.stars.length; i++) if (bindings.stars[i] === at) node.stars[node.stars.length] = loads;
      const names = new SafeList<string>();
      const reads = bindings.imports[at];
      for (let i = 0; i < reads.length; i++) names[names.length] = reads[i];
      if (names.length > 0) node.imports[node.imports.length] = { target: loads, specifier: request.specifier, names };
      for (let i = 0; i < bindings.reexports.length; i++) {
        const entry = bindings.reexports[i];
        if (entry[1] === at) node.reexports[node.reexports.length] = [entry[0], loads, entry[2]];
      }
    }
    // A data: JavaScript module is the late graph's own, by its URL.
    if (resolution.format === 'data') {
      plan(host, resolution.url, resolution.url, seen, order, checked, late);
      continue;
    }
    const path = ownField(resolution, 'path');
    if (typeof path !== 'string') continue;
    const target = stripLeadingSlashes(path);
    const parsed = newURL(resolution.url);
    const search = urlSearch(parsed);
    const hash = urlHash(parsed);
    const id = host.row('module', target);
    // An unstaged module, or a query's or a fragment's instance (the interpreter's own): its closure is the late graph's too.
    if (id === -1 || search !== '' || hash !== '') {
      // What the interpreter loads as an ES module (a CommonJS module compiles when it evaluates, as Node's does).
      if (resolution.format === 'module' || resolution.format === 'detect') plan(host, target, resolution.url, seen, order, checked, late);
      continue;
    }
    checkLinks(host, id, seen, checked, late);
    if (!arrayIncludes(order, id)) reflectDefineProperty(order, order.length, dataDescriptor(id, true, true, true));
  }
}

/**
 * A file staging handed on (one the launch lacked, did not stage as the
 * format it is, or a query's or a fragment's instance), resolved again from
 * its importer at `key` as the loader resolves it when the importer is
 * imported, checked against its `type` attribute: the module it loads is
 * its format's. Null for a data: URL. Throws Node's error where it does not
 * resolve still.
 */
function handedOnFile(host: LateLinkHost, key: string, url: string, specifier: string, type: string | null | undefined): LateResolution | null {
  if (urlProtocol(newURL(url)) !== 'file:') return null;
  const parent = newURL('file://');
  urlSetPathname(parent, '/' + key);
  return host.resolve(specifier, urlHref(parent), type);
}

/**
 * What a module staging handed on (or a data: import) loads: a query's or a
 * fragment's instance, a late module by its URL; a data: module by its MIME
 * type, JavaScript a late module of its own, JSON its default alone.
 */
function handedOnTarget(url: string): LateTarget | null {
  if (!stringStartsWith(url, 'data:')) return moduleTarget(url);
  const { format } = dataModule(url);
  return format === 'module' ? moduleTarget(url) : format === 'json' ? namedTarget(url, ['default'], false) : null;
}

function lateTarget(host: LateLinkHost, resolution: LateResolution): LateTarget | null {
  if (resolution.format === 'builtin') {
    const builtin = ownField(resolution, 'builtin');
    if (typeof builtin === 'string') {
      const id = host.row('builtin', builtin);
      return id !== -1 ? rowTarget(id) : namedTarget(resolution.url, host.builtinNames(builtin), false);
    }
  }
  if (resolution.format === 'data') return handedOnTarget(resolution.url);
  const path = ownField(resolution, 'path');
  if (typeof path !== 'string') return null;
  const key = stripLeadingSlashes(path);
  const parsed = newURL(resolution.url);
  const search = urlSearch(parsed);
  const hash = urlHash(parsed);
  if (search === '' && hash === '') {
    const id = host.row('module', key);
    if (id !== -1) return rowTarget(id);
    const facade = host.row(resolution.format === 'json' ? 'json' : 'commonjs', key);
    if (facade !== -1) return rowTarget(facade);
  }
  if (resolution.format === 'module' || resolution.format === 'detect') return moduleTarget(resolution.url);
  if (resolution.format === 'json') return namedTarget(resolution.url, ['default'], false);
  if (resolution.format === 'commonjs') return namedTarget(resolution.url, commonJsNames(host, key), true);
  return null;
}

/**
 * Throws the refusal of a static import staged row `id`'s unevaluated graph
 * makes that staging refused for good. A staging handed on (a query's or a
 * fragment's instance, which the interpreter evaluates where it is
 * imported) is planned as the late graph's own. The graph's unevaluated
 * rows go to `late`. A require() staging hoisted (a target past the row's
 * static imports) is not followed: the interpreter evaluates the row's own
 * text, whose require() links its module where it runs, as Node's does,
 * after the row's static imports evaluate (which may write its files).
 */
function checkLinks(host: LateLinkHost, id: number, seen: SafeSet<string>, checked: SafeSet<number>, late: LateGraph): void {
  if (checked.has(id)) return;
  checked.add(id);
  if (host.rowKind(id) !== 'module' || host.rowSettled(id)) return;
  const failure = linkFailures.get(host.rowKey(id));
  if (failure !== undefined) throw failure;
  try {
    late.rows[late.rows.length] = id;
    const { analysis, specifiers } = rowRead(host, id);
    const targets = host.rowTargets(id).length;
    const statics = analysis === null ? targets : mathMin(specifiers.length, targets);
    for (let index = 0; index < statics; index++) checkTarget(host, id, index, seen, checked, late);
  } catch (e) {
    if (late.kept && e instanceof Error) linkFailures.set(host.rowKey(id), e);
    throw e;
  }
}

/** Throws the refusal of staged row `row`'s target `index`, as checkLinks does; what it loads goes to `late`. */
function checkTarget(host: LateLinkHost, row: number, index: number, seen: SafeSet<string>, checked: SafeSet<number>, late: LateGraph): void {
  const target = host.rowTargets(row)[index];
  if (target >= 0) {
    checkLinks(host, target, seen, checked, late);
    return;
  }
  const missing = host.missing(-2 - target);
  if (missing === null) return;
  if (objectHasOwn(missing, 'refusal')) throw ownField(missing, 'refusal');
  // A file handed on is resolved now, as the loader resolves it when the
  // module is imported (Node's error if it is missing still), and planned
  // as an unstaged module is: a JSON or CommonJS file has no links.
  const { analysis, specifiers } = rowRead(host, row);
  const specifier = specifiers[index];
  const handedOn = ownField(missing, 'handedOn');
  if (typeof handedOn !== 'string') return;
  const bindings = bindingsOf(analysis);
  const file = specifier === undefined ? null : handedOnFile(host, host.rowKey(row), handedOn, specifier, bindings?.types[index]);
  if (file !== null) {
    const path = ownField(file, 'path');
    if (typeof path === 'string' && (file.format === 'module' || file.format === 'detect')) plan(host, stripLeadingSlashes(path), file.url, seen, [], checked, late);
    return;
  }
  // A query's or a fragment's file by its path; a data: module by its URL.
  const handed = newURL(handedOn);
  const key = urlProtocol(handed) === 'data:' ? handedOn : stripLeadingSlashes(decodeURIComponentOf(urlPathname(handed)));
  plan(host, key, handedOn, seen, [], checked, late);
}

/**
 * Each name a module of the late graph imports is one its module exports,
 * dependencies first, as Node's linker reaches them: else Node's
 * SyntaxError. A name whose module's names are not known here is the
 * interpreter's to find.
 */
function checkBindings(host: LateLinkHost, late: LateGraph, rootUrl: string): void {
  const pending = new SafeSet<number>();
  for (let i = 0; i < late.rows.length; i++) pending.add(late.rows[i]);
  const visited = new SafeSet<string>();
  const visit = (target: LateTarget | null): void => {
    if (target === null || target.names !== undefined) return;
    if (target.row !== undefined && !pending.has(target.row)) return;
    const mark = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
    if (visited.has(mark)) return;
    visited.add(mark);
    const edges = edgesOf(host, late, target);
    for (let i = 0; i < edges.length; i++) visit(edges[i].target);
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      for (let n = 0; n < edge.names.length; n++) {
        const name = edge.names[n];
        const resolution = resolveExport(host, late, edge.target, name, new SafeSet());
        if (resolution !== null && resolution !== AMBIGUOUS) continue;
        const loads = edge.target;
        const commonjs = loads !== null && (loads.row !== undefined ? host.rowKind(loads.row) === 'commonjs' : loads.names !== undefined && loads.commonjs);
        throw host.decorate(new SyntaxError(resolution === AMBIGUOUS
          ? `The requested module '${edge.specifier}' contains conflicting star exports for name '${name}'`
          : host.exportMessage(edge.specifier, name, commonjs)));
      }
    }
  };
  visit(moduleTarget(rootUrl));
  late.modules.forEach((_node, url) => { visit(moduleTarget(url)); });
  for (let i = 0; i < late.rows.length; i++) visit(rowTarget(late.rows[i]));
}

function edgesOf(host: LateLinkHost, late: LateGraph, target: LateTarget): readonly LateEdge[] {
  if (target.row === undefined) return late.modules.get(target.url)?.imports ?? [];
  const facts = host.rowKind(target.row) === 'module' ? moduleFacts(host, target.row) : null;
  return facts === null ? [] : facts.imports;
}

/** A name its module's `export *`s reach two different bindings of. */
const AMBIGUOUS = 'ambiguous';

interface Binding {
  readonly module: string;
  /** The binding's own name in its module (one binding under two exported names is one); '*' for its namespace. */
  readonly binding: string;
}

/**
 * A late or staged module's facts; null where not known here. A late module
 * an earlier link read (a query's instance a staged module, already run,
 * hands on) is that link's.
 */
function factsOf(host: LateLinkHost, late: LateGraph, target: LateTarget): ModuleFacts | null {
  if (target.row === undefined) {
    const node = late.modules.get(target.url) ?? lateModules.get(target.url);
    return node === undefined || !node.known ? null : node;
  }
  return moduleFacts(host, target.row);
}

/**
 * ECMA-262 ResolveExport of `name` of `target`: its binding, null where it
 * has no such export, AMBIGUOUS where its `export *`s reach two different
 * bindings of it, undefined where its names are not known here.
 */
function resolveExport(host: LateLinkHost, late: LateGraph, target: LateTarget | null, name: string, resolving: SafeSet<string>): Binding | null | typeof AMBIGUOUS | undefined {
  if (target === null) return undefined;
  if (target.names !== undefined) return arrayIncludes(target.names, name) ? { module: `u${target.url}`, binding: name } : null;
  const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
  if (target.row !== undefined && host.rowKind(target.row) !== 'module') {
    const names = rowNames(host, target.row);
    return names === null ? undefined : arrayIncludes(names, name) ? { module, binding: name } : null;
  }
  // A circular import request: nothing more to find this way.
  if (resolving.has(`${module}\0${name}`)) return null;
  resolving.add(`${module}\0${name}`);
  const facts = factsOf(host, late, target);
  if (facts === null) return undefined;
  for (let i = 0; i < facts.reexports.length; i++) {
    const entry = facts.reexports[i];
    if (entry[0] !== name) continue;
    const from = entry[1];
    const imported = entry[2];
    if (imported !== null) return resolveExport(host, late, from, imported, resolving);
    if (from === null) return undefined;
    return { module: from.row !== undefined ? `r${from.row}` : `u${from.url}`, binding: '*' };
  }
  for (let i = 0; i < facts.locals.length; i++) {
    const entry = facts.locals[i];
    if (entry[0] === name) return { module, binding: entry[1] };
  }
  if (name === 'default') return null;
  let found: Binding | null = null;
  let incomplete = false;
  for (let i = 0; i < facts.stars.length; i++) {
    const resolution = resolveExport(host, late, facts.stars[i], name, resolving);
    if (resolution === AMBIGUOUS) return resolution;
    if (resolution === undefined) incomplete = true;
    else if (resolution === null) continue;
    else if (found === null) found = resolution;
    else if (found.module !== resolution.module || found.binding !== resolution.binding) return AMBIGUOUS;
  }
  return incomplete ? undefined : found;
}

/** ECMA-262 GetExportedNames of `target`: its own names, and its `export *`s' but `default`; null where not known here. */
function exportedNames(host: LateLinkHost, late: LateGraph, target: LateTarget | null, seen: SafeSet<string>): readonly string[] | null {
  if (target === null) return null;
  if (target.names !== undefined) return target.names;
  if (target.row !== undefined && host.rowKind(target.row) !== 'module') return rowNames(host, target.row);
  const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
  if (seen.has(module)) return [];
  seen.add(module);
  const facts = factsOf(host, late, target);
  if (facts === null) return null;
  const names = new SafeSet<string>();
  for (let i = 0; i < facts.exports.length; i++) names.add(facts.exports[i]);
  for (let i = 0; i < facts.stars.length; i++) {
    const starred = exportedNames(host, late, facts.stars[i], seen);
    if (starred === null) return null;
    for (let n = 0; n < starred.length; n++) if (starred[n] !== 'default') names.add(starred[n]);
  }
  const out = new SafeList<string>();
  names.forEach((name) => { out[out.length] = name; });
  return out;
}
