/**
 * esm-stage.ts — a launch's ES modules as its process's registry evaluates
 * them (core runtime/native-esm.ts): each static specifier resolved as Node's
 * ESM loader resolves it, and the module staged to name what that resolution
 * loads in the map: another staged ES module, the facade of a CommonJS module
 * or a builtin, a JSON module, or nothing at all for a specifier Node's
 * loader refuses, so the whole graph fails to link before any of it runs, as
 * Node's does, and the process names the refusal Node would.
 *
 * The facades and the meta instances join the map beside the staged modules,
 * and the process reads the launch's table of them (EsmModuleRow) by each
 * meta instance's id.
 */

import { commonJsCellModuleName } from '@nimbus-sh/core/_shared/commonjs-cell.js';
import { createEsmResolver, type EsmResolution } from '@nimbus-sh/core/_shared/esm-resolver.js';
import { FACET_PROVIDED_PACKAGES } from '@nimbus-sh/core/constants.js';
import { cjsModuleExportNamesAsync } from '@nimbus-sh/core/runtime/cjs-module-exports.js';
import type { ImportSites } from '@nimbus-sh/core/runtime/dynamic-import-rewrite.js';
import {
  builtinFacadeModule, commonJsFacadeModule, ESM_FACADE_DIR, ESM_HOST_MODULE, ESM_HOST_SOURCE, ESM_META_MODULE, metaModuleSource,
  stageEsModule, type StagedEsModule,
} from '@nimbus-sh/core/runtime/native-esm.js';
import { NODE_BUILTIN_EXPORTS } from '@nimbus-sh/core/runtime/node-builtin-exports.js';
import { resolveRequireEx, type BridgeRequireFs } from '@nimbus-sh/core/runtime/require-resolution.js';
import { stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';

/**
 * One row of a launch's ES module table, by its meta instance's id: a staged
 * ES module (the cell at a VFS key), the facade of the CommonJS cell at a
 * key, or the facade of a builtin or of a package the process provides.
 */
export type EsmModuleRow =
  | readonly [kind: 'module', key: string]
  | readonly [kind: 'commonjs', key: string]
  | readonly [kind: 'builtin', name: string];

/** A non-code member of the map: an ES module's text, or a JSON module's value. */
export type EsmMapMember = { readonly js: string } | { readonly json: unknown };

/** What a launch stages for its ES modules. */
export interface EsmStage {
  /** Each ES module cell's staged module, by its VFS key. */
  readonly modules: Map<string, StagedEsModule>;
  /** The map's other members the modules link to: the meta and host modules, facades, JSON modules. */
  readonly members: Record<string, EsmMapMember>;
  /** The process's ES module table, by meta id. */
  readonly table: EsmModuleRow[];
  /** What each specifier Node's loader refuses fails with, by its missing module's number (EsmMissing). */
  readonly missing: EsmMissing[];
}

/** A specifier Node's loader refuses: the error its import fails with. */
export interface EsmMissing {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

/** Where a refused specifier points, by its number: a name no map member has, so the graph fails to link. */
export const ESM_MISSING_DIR = 'nimbus/missing/';

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
}

/**
 * Stage `cells`, the launch's ES modules (their code and import sites, by VFS
 * key), resolving under the program's `conditions`. `isCode(key)` is whether
 * the launch carries the cell at a key; `isEsModule(key)` whether it is one
 * of `cells`.
 */
export async function stageEsModules(
  fs: EsmStageFs,
  cells: ReadonlyMap<string, { readonly code: string; readonly sites: ImportSites }>,
  { conditions, isCode, gate }: {
    conditions: readonly string[];
    isCode(key: string): boolean;
    /** Whether the registry needs each module gated: workerd (native-esm.ts). */
    gate: boolean;
  },
): Promise<EsmStage> {
  const table: EsmModuleRow[] = [];
  const members: Record<string, EsmMapMember> = {
    [ESM_HOST_MODULE]: { js: ESM_HOST_SOURCE },
    [ESM_META_MODULE]: { js: metaModuleSource(gate) },
  };
  const missing: EsmMissing[] = [];
  // A cell's id is its place among `cells`: the table's first rows.
  for (const key of cells.keys()) table.push(['module', key]);
  const facades = new Map<string, string>();
  const jsonModules = new Map<string, string>();
  const names = new Map<string, Set<string>>();
  const facade = (row: EsmModuleRow, source: (id: number) => string): string => {
    const at = `${row[0]}:${row[1]}`;
    let name = facades.get(at);
    if (name === undefined) {
      const id = table.length;
      table.push(row);
      name = `${ESM_FACADE_DIR}${id}.js`;
      members[name] = { js: source(id) };
      facades.set(at, name);
    }
    return name;
  };
  const refuse = (error: unknown): string => {
    const name = `${ESM_MISSING_DIR}${missing.length}.js`;
    const failure = error instanceof Error ? error : new Error(String(error));
    const code = Reflect.get(failure, 'code');
    missing.push({ name: failure.name, code: typeof code === 'string' ? code : '', message: failure.message });
    return name;
  };
  const readText = async (path: string): Promise<string | null> => {
    try { return await fs.files.readFileString(stripLeadingSlashes(path)); } catch { return null; }
  };
  const requireResolve = async (specifier: string, fromPath: string): Promise<string | null> => {
    const fromDir = stripLeadingSlashes(fromPath.slice(0, fromPath.lastIndexOf('/')));
    const found = await resolveRequireEx(fs.files, specifier, fromDir, undefined, undefined, conditions);
    return found === null ? null : '/' + stripLeadingSlashes(found.resolved);
  };
  const resolver = createEsmResolver({
    async kind(path) {
      const key = stripLeadingSlashes(path);
      if (!(await fs.files.exists(key))) return null;
      return (await fs.files.isDirectory(key)) ? 'directory' : 'file';
    },
    realpath: (path) => fs.realpath(path),
    readText,
    isBuiltin: (specifier) => isNodeBuiltin(specifier) || FACET_PROVIDED_PACKAGES.includes(specifier),
    cjsResolve: requireResolve,
  }, { conditions });
  const exportNames = (path: string) => cjsModuleExportNamesAsync(path, { source: readText, resolve: requireResolve }, names);

  /** The map module a resolution loads, from an importer, with `attributes`. */
  const target = async (resolution: EsmResolution, attributes: Readonly<Record<string, string>>): Promise<string> => {
    resolver.validateAttributes(resolution.url, resolution.format, attributes);
    resolver.assertLoadable(resolution);
    if (resolution.format === 'builtin') {
      const builtin = resolution.builtin ?? resolution.url;
      const name = builtin.replace(/^node:/, '');
      return facade(['builtin', name], (id) => builtinFacadeModule(id, NODE_BUILTIN_EXPORTS[name] ?? []));
    }
    if (resolution.path === undefined) throw new Error(`Nimbus: ${resolution.url} has no file to stage`);
    const key = stripLeadingSlashes(resolution.path);
    if (cells.has(key)) return commonJsCellModuleName(key);
    if (resolution.format === 'json') {
      const known = jsonModules.get(key);
      if (known !== undefined) return known;
      const text = await readText(resolution.path);
      if (text === null) throw new Error(`Nimbus: ${resolution.path} was resolved and cannot be read`);
      const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      const name = `${ESM_FACADE_DIR}json/${jsonModules.size}.json`;
      members[name] = { json: value };
      jsonModules.set(key, name);
      return name;
    }
    // CommonJS by Node's format for it; a module the launch does not carry
    // loads nothing, and the link fails naming it.
    if (!isCode(key)) throw Object.assign(new Error(`Cannot find module '${resolution.path}': it was resolved but this launch did not stage it`), { code: 'ERR_MODULE_NOT_FOUND' });
    const exported = [...await exportNames(resolution.path)];
    return facade(['commonjs', key], (id) => commonJsFacadeModule(id, exported));
  };

  const modules = new Map<string, StagedEsModule>();
  let id = 0;
  for (const [key, { code, sites }] of cells) {
    const parentUrl = new URL('file://');
    parentUrl.pathname = '/' + key;
    const targets: string[] = [];
    for (const site of sites.statics) {
      let name: string;
      try {
        // A package the process provides loads as the process's own, with the names Node finds in its installed copy.
        if (FACET_PROVIDED_PACKAGES.includes(site.specifier)) {
          const installed = await requireResolve(site.specifier, parentUrl.pathname);
          if (installed === null) throw Object.assign(new Error(`Cannot find package '${site.specifier}' imported from ${parentUrl.pathname}`), { code: 'ERR_MODULE_NOT_FOUND' });
          const exported = [...await exportNames(installed)];
          name = facade(['builtin', site.specifier], (id) => builtinFacadeModule(id, exported));
        } else {
          name = await target(await resolver.resolve(site.specifier, parentUrl.href), site.attributes);
        }
      } catch (error) {
        name = refuse(error);
      }
      targets.push(name);
    }
    modules.set(key, stageEsModule(code, sites, { id: id++, name: commonJsCellModuleName(key), targets }));
  }
  return { modules, members, table, missing };
}
