/**
 * require-resolution.ts — Node's CommonJS resolution over a filesystem that
 * answers metadata questions (exists, isDirectory, a package.json's text):
 * LOAD_AS_FILE, LOAD_AS_DIRECTORY through each `main`, node_modules lookup,
 * `exports` and `imports` maps and self-reference, mirroring node-shims.ts's
 * runtime resolver so a walk and the process pick the same file.
 *
 * It reads no module source. Its callers are the module-map walk
 * (require-resolver.ts, which stages what it resolves) and the data plan
 * (worker facets/data-plan.ts, which only names files).
 */

import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import {
  resolvePackageEntry as sharedResolvePackageEntry,
  resolveExports as sharedResolveExports,
  packageSelfReferenceSubpath,
  DEFAULT_CJS_CONDITIONS,
  DEFAULT_ESM_CONDITIONS,
  type ResolvablePackageJson,
  type SelfReferencingPackageJson,
} from '../_shared/exports-resolver.js';
import {
  TYPESCRIPT_INDEX_CANDIDATES,
  typescriptFallbackCandidates,
} from '../_shared/typescript-specifiers.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';

/**
 * The filesystem questions resolution needs; held-cell reuse can additionally
 * check current read authority without rereading bytes. A missing path is
 * false, false, a throw, and null.
 */
export interface RequireFs {
  exists(path: string): Awaitable<boolean>;
  isDirectory(path: string): Awaitable<boolean>;
  readFileString(path: string): Awaitable<string>;
  stat(path: string): Awaitable<{ size: number } | null>;
  /** Revalidate held content through the same principal without rereading its bytes. */
  assertReadable?(path: string): Awaitable<void>;
}

/**
 * The resolver's filesystem over a bound process bridge (supervisor RPC or
 * in-process), plus the two reads a launch builder needs. Every probe answers
 * a missing path (ENOENT, however the bridge reports it) with null or false;
 * other errors are the bridge's.
 */
export interface BridgeRequireFs extends RequireFs {
  stat(path: string): Promise<RuntimeVfsStat | null>;
  /** The entry itself, a final link not followed. */
  lstat(path: string): Promise<RuntimeVfsStat | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
}

export function requireFsOverBridge(bridge: RuntimeFsBridge): BridgeRequireFs {
  const decoder = new TextDecoder();
  const absent = <T>(read: () => Awaitable<T | null>): Promise<T | null> => (async () => {
    try {
      return await read();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  })();
  const stat = (path: string) => absent(() => bridge.stat(path));
  const readBytes = (path: string) => absent(() => bridge.readFile(path));
  return {
    exists: async (path) => (await stat(path)) !== null,
    isDirectory: async (path) => (await stat(path))?.type === 'directory',
    readFileString: async (path) => {
      const bytes = await readBytes(path);
      if (bytes === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return decoder.decode(bytes);
    },
    stat,
    assertReadable: path => bridge.access(path, 4),
    lstat: (path) => absent(() => bridge.stat(path, { followSymlinks: false })),
    readBytes,
  };
}

/**
 * Sink for package.json files consulted during LOAD_AS_DIRECTORY
 * resolution. The runtime resolver (`__resolveFile` in node-shims.ts)
 * re-derives a directory require's target by reading that directory's
 * package.json#main; if prefetch resolves a subpath through a nested
 * package.json (e.g. web-streams-polyfill's `ponyfill/package.json`
 * declaring `main: "../dist/ponyfill"`), only the FINAL file gets
 * added to the bundle — the runtime then can't repeat the resolution
 * because the intermediate package.json's content was never shipped
 * (and, for npx-cache trees outside cwd, isn't in the manifest either).
 * Recording every consulted package.json lets the prefetch walker add
 * its content so prefetch and runtime agree.
 */
export type PkgJsonSink = (pkgJsonPath: string) => Awaitable<string | null>;
export type WalkProgress = (work: number) => Promise<void>;

// Work weight, not a storage or transfer size: even a missing candidate costs
// path resolution and metadata queries. A fixed charge bounds metadata-only
// walks; path length also accounts for traversal of long ancestor chains.
export const METADATA_CANDIDATE_WORK = 256;

async function packageText(vfs: RequireFs, path: string, progress?: WalkProgress): Promise<string | null> {
  if (progress) await progress(METADATA_CANDIDATE_WORK + path.length);
  let text: string;
  try { text = await vfs.readFileString(path); } catch { return null; }
  if (progress) await progress(text.length);
  return text;
}

/**
 * Extension-list probe; mirrors node-shims.ts:__resolveFile so prefetch
 * picks the same on-disk file the runtime require will pick.
 *
 * Mirrors Node's LOAD_AS_FILE + LOAD_AS_DIRECTORY (require_2 spec):
 *   1. LOAD_AS_FILE: base, base.js, base.mjs, base.cjs, base.json.
 *   2. LOAD_AS_DIRECTORY (if base resolves to a directory):
 *      a. <base>/package.json#main → recurse.
 *      b. <base>/index.{js,cjs,mjs,json}.
 *
 * Bug class C (audit 2026-05-11): step 2a was missing, so prefetch
 * silently dropped any file reachable only via package.json#main from
 * a directory-style require (e.g. `require('./mod')` where mod has
 * main='entry.js' and no index.js).
 */
export async function resolveFile(vfs: RequireFs, base: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<string | null> {
  const fileExts = ['', '.js', '.mjs', '.cjs', '.json'];
  for (const ext of fileExts) {
    const p = normalizeVfsPath(base + ext);
    if (progress) await progress(METADATA_CANDIDATE_WORK + p.length);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  // LOAD_AS_DIRECTORY: prefer package.json#main over index.*
  const baseTrim = base.replace(/\/+$/, '');
  const pkgJsonPath = normalizeVfsPath(baseTrim + '/package.json');
  if (progress) await progress(METADATA_CANDIDATE_WORK + pkgJsonPath.length);
  if ((await vfs.exists(pkgJsonPath)) && !(await vfs.isDirectory(pkgJsonPath))) {
    let pkg: ResolvablePackageJson | null = null;
    const text = sink ? await sink(pkgJsonPath) : await packageText(vfs, pkgJsonPath, progress);
    try { pkg = JSON.parse(text ?? ''); } catch { /* fall through */ }
    if (pkg && typeof pkg.main === 'string' && pkg.main.length > 0) {
      // Record this package.json so the bundle carries the content the
      // runtime resolver needs to repeat this directory resolution.
      const mainStripped = pkg.main.replace(/^\.\/+/, '').replace(/^\/+/, '');
      const mainBase = baseTrim + '/' + mainStripped;
      // Guard against pkg.main === '.' or empty → would re-enter same base.
      if (mainBase !== base && mainBase !== baseTrim) {
        const resolved = (await resolveFile(vfs, mainBase, sink, progress));
        if (resolved) return resolved;
      }
    }
  }
  const indexExts = ['/index.js', '/index.cjs', '/index.mjs', '/index.json'];
  for (const ext of indexExts) {
    const p = normalizeVfsPath(base + ext);
    if (progress) await progress(METADATA_CANDIDATE_WORK + p.length);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  // TypeScript sources, probed only once every candidate above has missed —
  // so the specifiers whose resolution changes are exactly those that resolve
  // to nothing today. See _shared/typescript-specifiers.ts for the scope.
  for (const candidate of typescriptFallbackCandidates(baseTrim)) {
    const p = normalizeVfsPath(candidate);
    if (progress) await progress(METADATA_CANDIDATE_WORK + p.length);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  for (const ext of TYPESCRIPT_INDEX_CANDIDATES) {
    const p = normalizeVfsPath(baseTrim + ext);
    if (progress) await progress(METADATA_CANDIDATE_WORK + p.length);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  return null;
}

/**
 * Result shape for `resolvePkgSubpathEx`. A legacy subpath directory with
 * its own package.json (`react-remove-scroll-bar/constants/package.json`
 * with `main: "../dist/constants.js"`) is Node's LOAD_AS_DIRECTORY, which
 * `resolveFile` and the runtime resolver both perform through `main`.
 */
export interface ResolveSubpathResult {
  /** Canonical resolved path to the real file. */
  resolved: string;
}

/**
 * Resolve a package's entry-point file via the SHARED resolver. The
 * pre-W2.6a implementation here had a hand-rolled `pkg.exports['.']`
 * lookup that ignored conditions, wildcards, and nested condition maps
 * — diverging from runtime semantics. Now both use the same impl.
 *
 * Returns null when no resolution is possible.
 */

/**
 * Resolution order:
 *   1. `package.json#exports[<subpath>]` via shared resolver, condition=require.
 *   2. For root subpath ('.'): `pkg.main` then `<pkgDir>/index.{js,…}`.
 *   3. For non-root subpath: `<pkgDir>/<subpath>` as a file, then as a
 *      directory (its package.json `main`, then its index).
 */
async function resolvePkgSubpathEx(vfs: RequireFs, pkgDir: string, subpath: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<ResolveSubpathResult | null> {
  const pkgJsonPath = pkgDir + '/package.json';
  if (progress) await progress(METADATA_CANDIDATE_WORK + pkgJsonPath.length);
  if (!(await vfs.exists(pkgJsonPath))) {
    // No package.json — direct probe (matches node-shims fallback).
    if (subpath === '.') {
      const r = (await resolveFile(vfs, pkgDir + '/index', sink, progress));
      return r ? { resolved: r } : null;
    }
    const r = (await resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''), sink, progress));
    return r ? { resolved: r } : null;
  }
  let pkg: ResolvablePackageJson;
  const text = sink ? await sink(pkgJsonPath) : await packageText(vfs, pkgJsonPath, progress);
  try { pkg = JSON.parse(text ?? ''); }
  catch {
    const r = (await resolveFile(vfs, pkgDir + '/index', sink, progress));
    return r ? { resolved: r } : null;
  }
  // The runtime resolver reads this package.json unconditionally to walk
  // exports/main; record it so its content ships in the bundle.
  let entry = sharedResolvePackageEntry(pkg, subpath, DEFAULT_CJS_CONDITIONS);
  if (entry == null && pkg.exports != null) {
    entry = sharedResolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
  if (entry != null) {
    const resolved = (await resolveFile(vfs, pkgDir + '/' + entry.replace(/^\.\//, ''), sink, progress));
    if (resolved) return { resolved };
    // W2.6a D2 (mirror of node-shims:__resolvePkgSubpath): exports/main
    // yielded a path that doesn't exist on disk. Fall through to the
    // direct-probe path so prefetch and runtime stay in lockstep on
    // packages whose declared entry is unfindable.
  }
  if (subpath === '.') {
    if (typeof pkg.main === 'string') {
      const r = (await resolveFile(vfs, pkgDir + '/' + pkg.main.replace(/^\.\//, ''), sink, progress));
      if (r) return { resolved: r };
    }
    const idx = (await resolveFile(vfs, pkgDir + '/index', sink, progress));
    return idx ? { resolved: idx } : null;
  }
  // Non-root subpath: the file, or the directory (resolveFile reads its main).
  const direct = (await resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''), sink, progress));
  return direct ? { resolved: direct } : null;
}

/** Bare-spec resolver: the node_modules walk from `fromDir`. */
async function resolveNodeModuleEx(vfs: RequireFs, name: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<ResolveSubpathResult | null> {
  let pkgName: string;
  let subpath: string;
  if (name.startsWith('@')) {
    const parts = name.split('/');
    if (parts.length < 2) return null;
    pkgName = parts.slice(0, 2).join('/');
    subpath = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
  } else {
    const slashIdx = name.indexOf('/');
    if (slashIdx > 0) {
      pkgName = name.substring(0, slashIdx);
      subpath = './' + name.substring(slashIdx + 1);
    } else {
      pkgName = name;
      subpath = '.';
    }
  }

  let dir = stripLeadingSlashes(fromDir);
  const visited = new Set<string>();
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const nmDir = (dir ? dir + '/' : '') + 'node_modules/' + pkgName;
    if (progress) await progress(METADATA_CANDIDATE_WORK + nmDir.length);
    if ((await vfs.exists(nmDir))) {
      const r = (await resolvePkgSubpathEx(vfs, nmDir, subpath, sink, progress));
      if (r) return r;
    }
    if (!dir) break;
    const lastSlash = dir.lastIndexOf('/');
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : '';
  }
  return null;
}

/** The require resolver `prefetchForRequire` walks with. */
export async function resolveRequireEx(vfs: RequireFs, id: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<ResolveSubpathResult | null> {
  if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
    const base = id.startsWith('/')
      ? stripLeadingSlashes(id)
      : normalizeVfsPath(stripLeadingSlashes(fromDir) + '/' + id);
    const r = (await resolveFile(vfs, base, sink, progress));
    return r ? { resolved: r } : null;
  }
  // package.json#imports field — `#name` specifiers resolved against
  // the nearest enclosing package.json's `imports` map. Mirrors the
  // runtime __resolveImportsField at node-shims.ts:2635. Without this
  // branch, prefetch would fall through to resolveNodeModuleEx (which
  // treats `#name` as a node_module name → never finds the file),
  // and the imports-field target would never be shipped into the
  // bundle. At runtime, __resolveImportsField would correctly compute
  // the target path, but __resolveFile would then return null because
  // the file wasn't bundled — surfacing as a misleading
  // "Cannot find module '#name' (from ...)" error.
  //
  if (id.startsWith('#')) {
    const r = (await resolveImportsField(vfs, id, fromDir, sink, progress));
    return r ? { resolved: r } : null;
  }
  // The enclosing package's own name resolves through its exports map
  // (Node's LOAD_PACKAGE_SELF), before the node_modules walk. Once the
  // enclosing package claims the name, its map is the whole answer: a
  // subpath it does not expose is not found, never a node_modules copy's.
  // Mirrors node-shims.ts:__resolvePackageSelf.
  const self = await resolvePackageSelf(vfs, id, fromDir, sink, progress);
  if (self) return self.resolved ? { resolved: self.resolved } : null;
  return (await resolveNodeModuleEx(vfs, id, fromDir, sink, progress));
}

/**
 * Node's "package scope" of a directory (`readPackageScope`): the nearest
 * enclosing package.json walking up from `fromDir`. The FIRST one found is
 * the scope, even when it lacks the field the caller wants — the imports
 * field and the self-reference rule both belong to the importing module's
 * own package, never to an ancestor past it. The walk never crosses a
 * `node_modules` directory: a file that sits directly under one belongs to
 * no package, not to the project above it. Mirrors
 * node-shims.ts:__nearestPackageScope. The package.json is recorded with
 * `sink` so the runtime can repeat the same lookup from the bundle.
 */
async function nearestPackageScope(
  vfs: RequireFs,
  fromDir: string,
  sink?: PkgJsonSink,
  progress?: WalkProgress,
): Promise<{ dir: string; pkg: (ResolvablePackageJson & SelfReferencingPackageJson) | null } | null> {
  let dir = stripLeadingSlashes(fromDir);
  while (true) {
    if (dir === 'node_modules' || dir.endsWith('/node_modules')) return null;
    const pkgJsonPath = (dir ? dir + '/' : '') + 'package.json';
    if (progress) await progress(METADATA_CANDIDATE_WORK + pkgJsonPath.length);
    if ((await vfs.exists(pkgJsonPath)) && !(await vfs.isDirectory(pkgJsonPath))) {
      let pkg: (ResolvablePackageJson & SelfReferencingPackageJson) | null = null;
      const text = sink ? await sink(pkgJsonPath) : await packageText(vfs, pkgJsonPath, progress);
      try { pkg = JSON.parse(text ?? ''); } catch { /* malformed */ }
      return { dir, pkg };
    }
    if (!dir) return null;
    const lastSlash = dir.lastIndexOf('/');
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : '';
  }
}

/**
 * Resolve an imports-field specifier `#name` against the nearest
 * enclosing package.json. Returns the resolved file path (or null
 * if not found). Mirrors node-shims.ts:__resolveImportsField.
 */
async function resolveImportsField(
  vfs: RequireFs,
  name: string,
  fromDir: string,
  sink?: PkgJsonSink,
  progress?: WalkProgress,
): Promise<string | null> {
  // First package.json wins (Node spec), even if no imports field.
  const scope = await nearestPackageScope(vfs, fromDir, sink, progress);
  if (!scope || !scope.pkg || !scope.pkg.imports) return null;
  const dir = scope.dir;
  const target = sharedResolveExports(scope.pkg.imports, name, DEFAULT_CJS_CONDITIONS);
  if (!target || typeof target !== 'string') return null;
  // imports targets are relative to the package root (`dir`).
  if (target.startsWith('./')) {
    const base = (dir ? dir + '/' : '') + target.slice(2);
    return (await resolveFile(vfs, normalizeVfsPath(base), sink, progress));
  }
  if (target.startsWith('/')) {
    return (await resolveFile(vfs, stripLeadingSlashes(target), sink, progress));
  }
  // Bare specifier — re-resolve as a node_module from `dir`.
  const r = (await resolveNodeModuleEx(vfs, target, dir, sink, progress));
  return r ? r.resolved : null;
}

/**
 * Node's LOAD_PACKAGE_SELF: a bare specifier naming the enclosing package
 * itself resolves through that package's own `exports` map — only when the
 * nearest package.json has `exports` AND its `name` matches, and only
 * through `exports` (no main/index probing). Same condition order as the
 * node_modules walk: CJS first, ESM when the map exposes the subpath only
 * under `import`. Mirrors node-shims.ts:__resolvePackageSelf.
 *
 * Tri-state, as in Node: `null` when the rule does not apply (the caller
 * walks node_modules); `{ resolved: null }` when the enclosing package
 * claims the name but its map does not expose the subpath or the target
 * is missing — Node throws ERR_PACKAGE_PATH_NOT_EXPORTED / MODULE_NOT_FOUND
 * there and never consults node_modules, so neither does the caller.
 */
async function resolvePackageSelf(
  vfs: RequireFs,
  name: string,
  fromDir: string,
  sink?: PkgJsonSink,
  progress?: WalkProgress,
): Promise<{ resolved: string | null } | null> {
  const scope = await nearestPackageScope(vfs, fromDir, sink, progress);
  if (!scope || !scope.pkg) return null;
  const subpath = packageSelfReferenceSubpath(scope.pkg, name);
  if (subpath === null) return null;
  let entry = sharedResolveExports(scope.pkg.exports, subpath, DEFAULT_CJS_CONDITIONS);
  if (entry == null) entry = sharedResolveExports(scope.pkg.exports, subpath, DEFAULT_ESM_CONDITIONS);
  if (entry == null) return { resolved: null };
  const resolved = await resolveFile(vfs, normalizeVfsPath(`${scope.dir ? `${scope.dir}/` : ''}${entry.replace(/^\.\//, '')}`), sink, progress);
  return { resolved };
}
