/**
 * esm-stage.ts — a launch's ES modules as its process's registry evaluates
 * them (core runtime/native-esm.ts): each static specifier resolved as Node's
 * ESM loader resolves it, and the module staged to name what that resolution
 * loads in the map: another staged ES module, the facade of a CommonJS module
 * or a builtin, a JSON module, or a module the map does not have for a
 * specifier Node's loader refuses, so the whole graph fails to link before
 * any of it runs, as Node's does, and the process names the refusal Node
 * would (EsmStage.missing).
 *
 * The facades, JSON modules and meta instances join the map beside the
 * staged modules, and the process reads the launch's table of them
 * (EsmModuleRow) by each meta instance's id.
 */

import { commonJsCellModuleName } from '@nimbus-sh/core/_shared/commonjs-cell.js';
import { createEsmResolver, type EsmResolution } from '@nimbus-sh/core/_shared/esm-resolver.js';
import { FACET_PROVIDED_PACKAGES } from '@nimbus-sh/core/constants.js';
import { cjsModuleExportNamesAsync } from '@nimbus-sh/core/runtime/cjs-module-exports.js';
import type { ImportSites } from '@nimbus-sh/core/runtime/dynamic-import-rewrite.js';
import {
  builtinFacadeModule, commonJsFacadeModule, jsonFacadeModule, ESM_BUN_SCOPE, ESM_FACADE_DIR, ESM_TOP_LEVEL_AWAIT, ESM_TYPELESS, ESM_HOST_MODULE, ESM_HOST_SOURCE, ESM_META_MODULE, metaModuleSource,
  stageEsModule, type StagedEsModule,
} from '@nimbus-sh/core/runtime/native-esm.js';
import { NODE_BUILTIN_EXPORTS } from '@nimbus-sh/core/runtime/node-builtin-exports.js';
import { UNDICI_SHIM_EXPORTS } from '@nimbus-sh/core/runtime/undici-shim.js';
import { resolveRequireEx, type BridgeRequireFs } from '@nimbus-sh/core/runtime/require-resolution.js';
import { typeScriptUnderNodeModules, type ModuleScope } from '@nimbus-sh/core/runtime/module-format.js';
import { nodeModulesRefusal } from '@nimbus-sh/core/runtime/typescript-refusal.js';
import { stripsTypeScript } from '@nimbus-sh/core/_shared/typescript-specifiers.js';
import { stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';

/**
 * One row of a launch's ES module table, by id (a meta instance's query):
 * a staged ES module (the cell at a VFS key) with the ids of the rows its
 * static imports load (for a refused one, -2 less the number of its refusal
 * in EsmStage.missing: every negative is no row), the facade of the CommonJS
 * cell at a key, the facade of a builtin or a package the process provides,
 * or the JSON module of the file at a key. A row's map module is its name
 * (esmRowName): its cell's module for a staged module, else its facade by id.
 */
export type EsmModuleRow =
  | readonly [kind: 'module', key: string, targets: readonly number[], flags?: number, packageJson?: string]
  | readonly [kind: 'commonjs', key: string]
  | readonly [kind: 'builtin', builtin: string]
  | readonly [kind: 'json', key: string];

/** The map module of row `id` (node-shims' __nimbusEsmName reads it so). */
export function esmRowName(row: EsmModuleRow, id: number): string {
  return row[0] === 'module' ? commonJsCellModuleName(row[1]) : `${ESM_FACADE_DIR}${id}.js`;
}

/**
 * A row's export names, as the late link reads them (ESM_BINDINGS_MODULE,
 * core runtime/esm-late-link.ts): a facade's or a JSON module's, which
 * staging already knows; null for a staged module, whose names the late
 * link reads from its source if it ever needs them.
 */
export type EsmRowBindings = readonly string[] | null;

/** A specifier Node's loader refuses: the error its import fails with. */
export interface EsmMissing {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  /** The URL Node's resolution error carries (a module or directory not found). */
  readonly url?: string;
}

/** What a launch stages for its ES modules. */
export interface EsmStage {
  /** Each ES module cell's staged module, by its VFS key. */
  readonly modules: Map<string, StagedEsModule>;
  /** The map's other members the modules link to, as ES module text: the meta and host modules, facades, JSON modules. */
  readonly members: Record<string, string>;
  /** The process's ES module table, by id. */
  readonly table: EsmModuleRow[];
  /** What each refused specifier fails with, by the number of the missing module it names (ESM_MISSING_DIR). */
  readonly missing: EsmMissing[];
  /** Each row's export names, by id (EsmRowBindings). */
  readonly bindings: EsmRowBindings[];
  /** How long staging took, in milliseconds: the launch's debug line. */
  readonly ms: number;
}

/** Where a refused specifier points, by its number: a name no map member has, so the graph fails to link. */
export const ESM_MISSING_DIR = 'nimbus/missing/';

/**
 * The code a refusal carries for a module Node's loader would load but the
 * launch did not stage (its closure was cut at the map's bound): the
 * process evaluates the importer's graph with the interpreter instead,
 * which loads the module as a file outside the map.
 */
export const ESM_NOT_STAGED = 'ERR_NIMBUS_NOT_STAGED';

/** The names each package the process provides has beside `default` (constants.ts FACET_PROVIDED_PACKAGES). */
const PROVIDED_PACKAGE_EXPORTS: Readonly<Record<string, readonly string[]>> = { undici: UNDICI_SHIM_EXPORTS };

/** Builtins Node names only with their scheme (module.isBuiltin('test') is false). */
const SCHEME_ONLY_BUILTINS: Readonly<Record<string, true>> = { sea: true, sqlite: true, test: true, 'test/reporters': true };

/** module.isBuiltin, by Node 22.22.3's builtin table. */
function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return Object.hasOwn(NODE_BUILTIN_EXPORTS, specifier.slice(5));
  return Object.hasOwn(NODE_BUILTIN_EXPORTS, specifier) && !SCHEME_ONLY_BUILTINS[specifier];
}

/** What staging reads of the launch's filesystem. */
export interface EsmStageFs {
  readonly files: BridgeRequireFs;
  realpath(path: string): Promise<string>;
  /** A directory's entries by name with their types (readdir's), or null: one listing answers for every name in it. */
  entries?(dir: string): Promise<ReadonlyMap<string, string> | null>;
  /** The text the launch already holds for a VFS key (its map's cell), or undefined: read before the filesystem. */
  held?(key: string): string | undefined;
}

/** `make()`'s promise, once per key of `cache`. */
function once<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let found = cache.get(key);
  if (found === undefined) {
    found = make();
    cache.set(key, found);
  }
  return found;
}

/** A refusal's error, as the process rebuilds it. */
function refusal(error: unknown): EsmMissing {
  const failure = error instanceof Error ? error : new Error(String(error));
  const code = Reflect.get(failure, 'code');
  const url = Reflect.get(failure, 'url');
  return { name: failure.name, code: typeof code === 'string' ? code : '', message: failure.message, ...(typeof url === 'string' ? { url } : {}) };
}

/**
 * Stage `cells`, the launch's ES modules (their code and import sites, by VFS
 * key), resolving under the program's `conditions`. `isCode(key)` is whether
 * the launch carries the cell at a key as code.
 */
export async function stageEsModules(
  fs: EsmStageFs,
  cells: ReadonlyMap<string, { readonly code: string; readonly sites: ImportSites }>,
  { conditions, cwd, isCode, gate, scope = 'node', stripsTypes = false, typeScript = true }: {
    /** Node strips TypeScript's types (node-cli.ts typeScriptStripOptions): it refuses TypeScript under node_modules. */
    stripsTypes?: boolean;
    /** A TypeScript file has a format (EsmResolverOptions.stripTypes): not under `--no-experimental-strip-types`. */
    typeScript?: boolean;
    conditions: readonly string[];
    /** Whose resolution the modules link by: Node's ESM_RESOLVE, or Bun's, which falls back to require()'s probing. */
    scope?: ModuleScope;
    /** The process's working directory (EsmResolverOptions.cwd). */
    cwd: string;
    isCode(key: string): boolean;
    /** Whether the registry needs each module gated: workerd (native-esm.ts). */
    gate: boolean;
  },
): Promise<EsmStage> {
  const started = Date.now();
  const table: EsmModuleRow[] = [];
  const members: Record<string, string> = {
    [ESM_HOST_MODULE]: ESM_HOST_SOURCE,
    [ESM_META_MODULE]: metaModuleSource(gate),
  };
  const missing: EsmMissing[] = [];
  // A cell's id is its place among `cells`: the table's first rows, its targets filled as it is staged.
  const targetIds: number[][] = [];
  for (const [key, { sites }] of cells) {
    const targets: number[] = [];
    targetIds.push(targets);
    const flags = (sites.commonJsNames?.length ? ESM_BUN_SCOPE : 0) | (sites.topLevelAwait ? ESM_TOP_LEVEL_AWAIT : 0);
    table.push(flags === 0 ? ['module', key, targets] : ['module', key, targets, flags]);
  }
  const ids = new Map<string, number>();
  for (let id = 0; id < table.length; id++) ids.set(`module:${table[id]![1]}`, id);
  const names = new Map<string, Set<string>>();
  const bindings: EsmRowBindings[] = [];
  /** The row of a facade or JSON module, which exports `exported` beside `default`, added the first time it is named. */
  const member = (kind: 'commonjs' | 'builtin' | 'json', key: string, exported: readonly string[], source: (id: number, name: string) => string): number => {
    let id = ids.get(`${kind}:${key}`);
    if (id === undefined) {
      id = table.length;
      const row: EsmModuleRow = [kind, key];
      const name = esmRowName(row, id);
      table.push(row);
      members[name] = source(id, name);
      bindings[id] = ['default', ...exported];
      ids.set(`${kind}:${key}`, id);
    }
    return id;
  };
  // Each filesystem question once per staging, the launch's own cells
  // first: a graph's modules share their directories, packages and
  // manifests, and asks them thousands of times.
  const kinds = new Map<string, Promise<'file' | 'directory' | null>>();
  const reals = new Map<string, Promise<string>>();
  const listings = new Map<string, Promise<ReadonlyMap<string, string> | null>>();
  const listing = (dir: string) => once(listings, dir, () => fs.entries!(dir));
  // What is at VFS key `key`, by its directory's listing where there is
  // one. Most questions are of names that are not there (each node_modules
  // a bare specifier is looked for in, up the tree; each package.json of a
  // package scope), and a listing per directory answers them all, where a
  // question per name walked the path again from the root. A link, or an
  // entry the listing cannot type, is asked of the filesystem, which follows it.
  const kind = (key: string): Promise<'file' | 'directory' | null> => once(kinds, key, async () => {
    if (fs.held?.(key) !== undefined) return 'file';
    if (key === '') return 'directory';
    if (fs.entries !== undefined) {
      const at = key.lastIndexOf('/');
      const dir = at === -1 ? '' : key.slice(0, at);
      if ((await kind(dir)) !== 'directory') return null;
      const listed = await listing('/' + dir);
      if (listed !== null) {
        const type = listed.get(key.slice(at + 1));
        if (type === undefined) return null;
        if (type === 'file' || type === 'directory') return type;
      }
    }
    if (!(await fs.files.exists(key))) return null;
    return (await fs.files.isDirectory(key)) ? 'directory' : 'file';
  });
  const realpath = (path: string): Promise<string> => once(reals, path, async () => {
    // A file that is no link is where its directory's realpath puts it:
    // a listing and a realpath per directory, not a walk per file.
    const at = path.lastIndexOf('/');
    if (fs.entries !== undefined && at > 0) {
      const dir = path.slice(0, at);
      const name = path.slice(at + 1);
      const type = (await listing(dir))?.get(name);
      if (type === 'file') return `${await once(reals, dir, () => fs.realpath(dir))}/${name}`;
    }
    return fs.realpath(path);
  });
  const texts = new Map<string, Promise<string | null>>();
  const requires = new Map<string, Promise<string | null>>();
  const readText = (path: string): Promise<string | null> => {
    const key = stripLeadingSlashes(path);
    return once(texts, key, async () => {
      const held = fs.held?.(key);
      if (held !== undefined) return held;
      // A file that is not there (most package scopes' package.json) is not read for.
      if (fs.entries !== undefined && (await kind(key)) !== 'file') return null;
      try { return await fs.files.readFileString(key); } catch { return null; }
    });
  };
  // require()'s resolution (a CommonJS facade's names, a missing import's
  // hint, Bun's probing) asks the same questions through the same answers:
  // a launch whose imports are not installed asked each node_modules up the
  // tree again per specifier, on every launch (a terminal `node -e` 2x main's).
  const requireFiles: BridgeRequireFs = {
    ...fs.files,
    exists: async (path) => (await kind(stripLeadingSlashes(path))) !== null,
    isDirectory: async (path) => (await kind(stripLeadingSlashes(path))) === 'directory',
    readFileString: async (path) => {
      const text = await readText(path);
      if (text === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    realpath: (path) => realpath('/' + stripLeadingSlashes(path)),
  };
  const requireResolve = (specifier: string, fromPath: string): Promise<string | null> => {
    const fromDir = stripLeadingSlashes(fromPath.slice(0, fromPath.lastIndexOf('/')));
    return once(requires, `${fromDir}\n${specifier}`, async () => {
      const found = await resolveRequireEx(requireFiles, specifier, fromDir, undefined, undefined, conditions);
      return found === null ? null : '/' + stripLeadingSlashes(found.resolved);
    });
  };
  const resolver = createEsmResolver({
    kind: (path) => kind(stripLeadingSlashes(path)),
    realpath,
    readText,
    isBuiltin: (specifier) => isNodeBuiltin(specifier) || FACET_PROVIDED_PACKAGES.includes(specifier),
    cjsResolve: requireResolve,
  }, { conditions, cwd: () => cwd, stripTypes: typeScript });
  const exportNames = async (path: string) => [...await cjsModuleExportNamesAsync(path, { source: readText, resolve: requireResolve }, names)];
  // A valid module the registry does not carry: its url is what the interpreter loads in its place.
  const notStaged = (path: string, url: string) => Object.assign(
    new Error(`Cannot find module '${path}': it was resolved, and this launch did not stage it`), { code: ESM_NOT_STAGED, url },
  );

  /** The row an import with `attributes` of what `resolution` names loads. */
  const target = async (resolution: EsmResolution, attributes: Readonly<Record<string, string>>): Promise<number> => {
    resolver.validateAttributes(resolution.url, resolution.format, attributes);
    resolver.assertLoadable(resolution);
    if (resolution.format === 'builtin') {
      const builtin = (resolution.builtin ?? resolution.url).replace(/^node:/, '');
      // A package the process provides loads as the process's own module, with its names.
      const exported = (FACET_PROVIDED_PACKAGES.includes(builtin) ? PROVIDED_PACKAGE_EXPORTS[builtin] : NODE_BUILTIN_EXPORTS[builtin]) ?? [];
      return member('builtin', builtin, exported, (id, name) => builtinFacadeModule(name, id, exported));
    }
    // A data: URL's module is the runtime's to make (node-shims' data loader), as an import of it at runtime is.
    if (resolution.format === 'data') throw notStaged(resolution.url, resolution.url);
    if (resolution.path === undefined) throw new Error(`Nimbus: ${resolution.url} has no file to stage`);
    // A query's or fragment's module is an instance of its own (Node keys
    // modules by URL), which a row by path cannot be: the importer's graph
    // is the interpreter's, which keeps each URL's instance.
    const { search, hash } = new URL(resolution.url);
    if (search !== '' || hash !== '') throw notStaged(resolution.url, resolution.url);
    const key = stripLeadingSlashes(resolution.path);
    // Node's loader refuses to strip a TypeScript file under node_modules when it loads it.
    if (stripsTypes && stripsTypeScript(key) && typeScriptUnderNodeModules(key)) {
      const refused = nodeModulesRefusal(resolution.path);
      throw Object.assign(new Error(refused.message), { code: refused.code });
    }
    const staged = ids.get(`module:${key}`);
    if (staged !== undefined) return staged;
    if (resolution.format === 'json') {
      const text = await readText(resolution.path);
      if (text === null) throw notStaged(resolution.path, resolution.url);
      // Node's JSON translator: the object require() gives for the same
      // file, one in require.cache whichever loads it first.
      return member('json', key, [], (id, name) => jsonFacadeModule(name, id));
    }
    // CommonJS by Node's format for it, loaded by require().
    if (!isCode(key)) throw notStaged(resolution.path, resolution.url);
    const exported = await exportNames(resolution.path);
    return member('commonjs', key, exported, (id, name) => commonJsFacadeModule(name, id, exported));
  };

  // A `.js` that is a module by its syntax alone, outside node_modules,
  // under a package.json with no "type": Node's loader warns of it (ESM_TYPELESS).
  for (let at = 0; at < targetIds.length; at++) {
    const row = table[at]!;
    if (row[0] !== 'module') continue;
    const key = row[1];
    if (!key.endsWith('.js') || key.split('/').includes('node_modules')) continue;
    const url = new URL('file://');
    url.pathname = '/' + key;
    const scope = await resolver.packageScope(url.href);
    if (scope.exists && scope.type === 'none') table[at] = ['module', key, row[2], (row[3] ?? 0) | ESM_TYPELESS, scope.pjsonPath];
  }

  // Each module's static imports, as the registry links them.
  const targetNames: string[][] = [];
  let id = 0;
  for (const [key, { sites }] of cells) {
    const parentUrl = new URL('file://');
    parentUrl.pathname = '/' + key;
    const targets: string[] = [];
    const rowTargets = targetIds[id]!;
    for (const site of sites.statics) {
      try {
        // A provided package by its bare name is the process's own, never an installed copy.
        const resolution = FACET_PROVIDED_PACKAGES.includes(site.specifier)
          ? { url: site.specifier, format: 'builtin' as const, builtin: site.specifier }
          : await resolver.resolve(site.specifier, parentUrl.href).catch(async (error: unknown) => {
            // Bun's resolution probes what Node's refuses (a `.js` naming its `.ts`, an extensionless path).
            const probed = scope === 'bun' ? await requireResolve(site.specifier, parentUrl.pathname) : null;
            if (probed === null) throw error;
            const url = new URL('file://');
            url.pathname = probed;
            return { url: url.href, path: probed, format: cells.has(stripLeadingSlashes(probed)) ? 'module' as const : 'commonjs' as const };
          });
        const row = await target(resolution, site.attributes);
        rowTargets.push(row);
        targets.push(esmRowName(table[row]!, row));
      } catch (error) {
        rowTargets.push(-2 - missing.length);
        targets.push(`${ESM_MISSING_DIR}${missing.length}.js`);
        missing.push(refusal(error));
      }
    }
    targetNames.push(targets);
    id++;
  }

  // The require() calls a module's top level can make static imports
  // (core runtime/esm-require-hoist.ts): each while its target is a staged
  // ES module whose graph neither holds the module nor awaits at its top
  // level, so the registry evaluates it, before the body, where Node's
  // require() would. The first that cannot be hoisted is left to its call,
  // and every later one with it, to keep Node's order.
  const hoisted: string[][] = [];
  id = 0;
  for (const [key, { sites }] of cells) {
    const names: string[] = [];
    for (const specifier of sites.requires ?? []) {
      const found = await requireResolve(specifier, '/' + key);
      const target = found === null ? undefined : ids.get(`module:${stripLeadingSlashes(found)}`);
      if (target === undefined || !hoistable(table, id, target)) break;
      targetIds[id]!.push(target);
      names.push(esmRowName(table[target]!, target));
    }
    hoisted.push(names);
    id++;
  }

  const modules = new Map<string, StagedEsModule>();
  id = 0;
  for (const [key, { code, sites }] of cells) {
    modules.set(key, stageEsModule(code, sites, {
      id, name: commonJsCellModuleName(key), targets: targetNames[id]!,
      ...(hoisted[id]!.length > 0 ? { hoisted: hoisted[id] } : {}),
      ...(sites.commonJsNames ? { commonJsNames: sites.commonJsNames } : {}),
    }));
    id++;
  }
  for (let row = 0; row < table.length; row++) bindings[row] ??= null;
  return { modules, members, table, missing, bindings, ms: Date.now() - started };
}

/**
 * Whether the module of row `requirer` may import row `target` in place of
 * requiring it: no module of `target`'s graph is `requirer` or awaits at its
 * top level.
 */
function hoistable(table: readonly EsmModuleRow[], requirer: number, target: number): boolean {
  const seen = new Set<number>();
  const stack = [target];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (at < 0 || seen.has(at)) continue;
    seen.add(at);
    if (at === requirer) return false;
    const row = table[at]!;
    if (row[0] !== 'module') continue;
    if (((row[3] ?? 0) & ESM_TOP_LEVEL_AWAIT) !== 0) return false;
    stack.push(...row[2]);
  }
  return true;
}
