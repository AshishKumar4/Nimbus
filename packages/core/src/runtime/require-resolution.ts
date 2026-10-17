/**
 * The launch's adapters over Node's CommonJS resolution algorithm
 * (_shared/commonjs-resolver.ts, which the guest's require() runs too):
 * VFS-relative questions, staged cells' text, and the build's entry
 * selection.
 */
import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import {
  codeOf, createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, resolvePackageEntry, selectPackageMap,
  type PackageMapPolicy, type ResolvablePackageJson,
} from '../_shared/exports-resolver.js';
import {
  absolute, createRequireResolver, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, type RequirePackageScope, type RequireResolutionPolicy, type WalkProgress,
} from '../_shared/commonjs-resolver.js';
import { SafeSet } from '../_shared/primordials.js';
import { stripLeadingSlashes } from '../vfs/path.js';
import type { PackageType } from './module-format.js';

export {
  createRequireResolver, METADATA_CANDIDATE_WORK, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, NODE_REQUIRE_POLICY, requireNodeModulePaths,
  type CommonJsResolution, type RequirePackageScope, type RequireResolutionPolicy, type RequireResolveOptions, type RequireResolverHost,
  type RequireResolverOptions, type WalkProgress,
} from '../_shared/commonjs-resolver.js';

/** Launch/filesystem adapter surface, kept for dependency-collector callers. */
export interface RequireFs {
  exists(path: string): Awaitable<boolean>;
  isDirectory(path: string): Awaitable<boolean>;
  readFileString(path: string): Awaitable<string>;
  stat(path: string): Awaitable<{ size: number } | null>;
  assertReadable?(path: string): Awaitable<void>;
  /** Hosts with links must supply this; immutable link-free maps may omit it. */
  realpath?(path: string): Awaitable<string>;
}
/**
 * The filesystem a module map is staged from: its cells copy each file's
 * bytes (fileCell), which readFileString's text (fileText) may not, where
 * the file is not UTF-8.
 */
export interface StagingRequireFs extends RequireFs {
  /** A file's bytes, or null when it does not exist. */
  readBytes(path: string): Awaitable<Uint8Array | null>;
}
export interface BridgeRequireFs extends StagingRequireFs {
  stat(path: string): Promise<RuntimeVfsStat | null>;
  lstat(path: string): Promise<RuntimeVfsStat | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
}

export type PkgJsonSink = (pkgJsonPath: string) => Awaitable<string | null>;

// A file's text keeps a leading byte order mark, which TextDecoder's default
// drops: Node's readFileSync returns it, and its parsers (a JSON require, the
// package.json reader: packageJsonText) are what skip it, once.
const cellDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * A file's bytes as text, as Node's readFileSync(path, 'utf8') answers them:
 * every byte decoded, a leading byte order mark kept. What
 * RequireFs.readFileString answers, and what a resolver parses.
 */
export function fileText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/**
 * A file's bytes as a module map's cell carries them: its text when the
 * bytes are UTF-8, every byte kept, else the bytes.
 */
export function fileCell(bytes: Uint8Array): string | Uint8Array {
  try {
    return cellDecoder.decode(bytes);
  } catch {
    return bytes;
  }
}

/**
 * The text a module walk reads a cell as, or a file's bytes it stages: a
 * text cell is that text; bytes are the file's text (fileText), which is the
 * cell's text when the file is UTF-8 (fileCell). A walk stages, reuses and
 * compares cells through this, in the one representation it reads.
 */
export function heldCellText(cell: string | Uint8Array): string {
  return typeof cell === 'string' ? cell : fileText(cell);
}

export function requireFsOverBridge(bridge: RuntimeFsBridge): BridgeRequireFs {
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
      return fileText(bytes);
    },
    stat,
    realpath: (path) => bridge.realpath(path),
    assertReadable: path => bridge.access(path, 4),
    lstat: (path) => absent(() => bridge.stat(path, { followSymlinks: false })),
    readBytes,
  };
}


/** Adapt VFS-relative launch metadata to the algorithm's absolute questions. */
export function requireResolverOverFs(
  vfs: RequireFs, sink?: PkgJsonSink, progress?: WalkProgress, conditions: readonly string[] = [],
  policy: RequireResolutionPolicy = NIMBUS_TYPESCRIPT_REQUIRE_POLICY,
) {
  const key = stripLeadingSlashes;
  return createRequireResolver({
    async kind(path) {
      const p = key(path);
      return !(await vfs.exists(p)) ? null : (await vfs.isDirectory(p)) ? 'directory' : 'file';
    },
    async readText(path) {
      const p = key(path);
      if (sink) return await sink(p);
      try { return await vfs.readFileString(p); }
      catch (err) {
        if (codeOf(err) === 'ENOENT') return null;
        throw err;
      }
    },
    realpath: (path) => vfs.realpath ? vfs.realpath(key(path)) : path,
  }, { conditions, policy, progress });
}

/** Public launch signatures stay VFS-relative; scope travels with the result. */
export interface ResolveSubpathResult {
  resolved: string;
  scope?: RequirePackageScope | null;
  packageType?: PackageType;
}
/** The launch names reachable files; runtime resolution still reports refusals. */
export function isRequireResolutionError(err: unknown): boolean {
  return ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    'ERR_PACKAGE_IMPORT_NOT_DEFINED', 'ERR_INVALID_MODULE_SPECIFIER', 'ERR_INVALID_PACKAGE_TARGET',
    'ERR_INVALID_PACKAGE_CONFIG', 'ERR_INVALID_URL_SCHEME', 'ERR_UNKNOWN_BUILTIN_MODULE'].includes(String(codeOf(err)));
}
export async function resolveRequireEx(
  vfs: RequireFs, id: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress,
  conditions: readonly string[] = [],
  policy: RequireResolutionPolicy = NIMBUS_TYPESCRIPT_REQUIRE_POLICY,
): Promise<ResolveSubpathResult | null> {
  try {
    const result = await requireResolverOverFs(vfs, sink, progress, conditions, policy).resolve(id, absolute(fromDir));
    if (!result?.path) return null;
    return { resolved: stripLeadingSlashes(result.path), scope: result.scope, packageType: result.packageType };
  } catch (err) {
    if (isRequireResolutionError(err)) return null;
    throw err;
  }
}
export async function resolveFile(vfs: RequireFs, base: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<string | null> {
  try {
    const path = await requireResolverOverFs(vfs, sink, progress).resolveFile(absolute(base));
    return path === null ? null : stripLeadingSlashes(path);
  } catch (err) {
    if (isRequireResolutionError(err)) return null;
    throw err;
  }
}
export async function packageScopeType(vfs: RequireFs, dir: string, progress?: WalkProgress): Promise<PackageType> {
  return (await requireResolverOverFs(vfs, undefined, progress).packageScope(absolute(dir)))?.type ?? null;
}
export async function packageJsonVisible(vfs: RequireFs, path: string): Promise<boolean> {
  try { return await vfs.exists(path); }
  catch (err) { if (codeOf(err) === 'EACCES') return false; throw err; }
}

/** Node selection by default; speculative builds opt into their named map policy. */
export function requirePackageEntry(pkg: ResolvablePackageJson, subpath: string, conditions: readonly string[], buildPolicy?: PackageMapPolicy<string>): string | null {
  if (buildPolicy) return resolvePackageEntry(pkg, subpath, [...DEFAULT_CJS_CONDITIONS, ...conditions], buildPolicy);
  if (pkg.exports == null) return subpath === '.' ? pkg.main ?? null : subpath;
  const url = new URL('file:///package.json');
  const policy = createNodePackageMapPolicy(url, '/', false, function* () { throw new Error('An exports target cannot be bare'); });
  const steps = selectPackageMap(pkg.exports, subpath, new SafeSet([...DEFAULT_CJS_CONDITIONS, ...conditions]), policy);
  const next = steps.next();
  if (!next.done) throw new Error('Package entry selection must be synchronous');
  return next.value == null ? null : '.' + next.value.pathname + next.value.search + next.value.hash;
}
