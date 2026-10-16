/**
 * One Node CommonJS resolution algorithm. Generators yield metadata questions;
 * sync guests/lifo and the async launch walker drive exactly the same steps.
 * Filesystem access, module loading, builtins and require-stack assembly remain
 * host/loader policy. NODE_PATH and Node's global folders are not discovered.
 */
import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import {
  createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, packageJsonText, packageSelfReferenceSubpath, resolutionError, selectPackageMap,
  resolvePackageEntry, type PackageMapPolicy, type PackageMapSteps, type ResolvablePackageJson, type SelfReferencingPackageJson,
} from '../_shared/exports-resolver.js';
import { TYPESCRIPT_INDEX_CANDIDATES, typescriptFallbackCandidates } from '../_shared/typescript-specifiers.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';
import type { PackageType } from './module-format.js';

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
export type WalkProgress = (work: number) => Promise<void>;
export const METADATA_CANDIDATE_WORK = 256;

export interface RequireResolverHost {
  /** Absolute paths, following links. */
  kind(path: string): Awaitable<'file' | 'directory' | null>;
  readText(path: string): Awaitable<string | null>;
  realpath(path: string): Awaitable<string>;
  isBuiltin?(specifier: string): boolean;
}
export interface RequireResolutionPolicy {
  readonly name: string;
  readonly typescriptFallback?: boolean;
  /** Lifo's explicitly supported product-global package directories, not NODE_PATH. */
  readonly globalFolders?: readonly string[];
}
export const NODE_REQUIRE_POLICY: RequireResolutionPolicy = { name: 'node-commonjs' };
/**
 * Nimbus source execution accepts Bun/NodeNext .js -> .ts and index.ts only
 * after Node's ordinary candidates miss. Package-map targets remain exact.
 */
export const NIMBUS_TYPESCRIPT_REQUIRE_POLICY: RequireResolutionPolicy = {
  name: 'nimbus-typescript-source-fallback', typescriptFallback: true,
};
export interface RequireResolverOptions {
  conditions?: readonly string[];
  policy?: RequireResolutionPolicy;
  progress?: WalkProgress;
  /** Staged guests already carry format facts; only loaders needing type rediscovery collect it. */
  collectPackageScope?: boolean;
}
type PackageConfig = ResolvablePackageJson & SelfReferencingPackageJson & { type?: unknown };
export interface RequirePackageScope {
  dir: string;
  packageJsonPath: string;
  pkg: PackageConfig;
  type: PackageType;
}
export interface CommonJsResolution {
  path?: string;
  builtin?: string;
  /** The final real file's classified scope, not the requesting module's. */
  scope: RequirePackageScope | null;
  packageType: PackageType;
}
export interface RequireResolveOptions {
  /** Already absolute. Undefined is the parent lookup, [] is no lookup. */
  paths?: readonly string[];
  /**
   * The requiring module's filename, which an imports ("#name") refusal says
   * it is imported from, as Node's Module._resolveFilename passes the
   * parent's path; the directory resolved from where there is none.
   */
  parent?: string;
}

const codeOf = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
const absolute = (path: string): string => '/' + stripLeadingSlashes(normalizeVfsPath(path));
const parentDir = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const relativeRequest = (id: string): boolean => id === '.' || id === '..' || id.startsWith('./') || id.startsWith('../');
const fileUrl = (path: string): URL => {
  const url = new URL('file://');
  url.pathname = path;
  return url;
};
const error = resolutionError;
/** A module require() did not find: a plain Error, its code MODULE_NOT_FOUND, as Node's CJS loader makes it. */
const moduleNotFound = (message: string, props: Record<string, string>): Error =>
  Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' }, props);

/** Node's node_modules lookup paths, with no node_modules/node_modules. */
export function requireNodeModulePaths(fromDir: string): string[] {
  const paths: string[] = [];
  for (let dir = absolute(fromDir); ; dir = parentDir(dir)) {
    if (dir.slice(dir.lastIndexOf('/') + 1) !== 'node_modules') paths.push((dir === '/' ? '' : dir) + '/node_modules');
    if (dir === '/') return paths;
  }
}

export function createRequireResolver(host: RequireResolverHost, options: RequireResolverOptions = {}) {
  const conditions = new Set([...DEFAULT_CJS_CONDITIONS, ...(options.conditions ?? [])]);
  const policy = options.policy ?? NODE_REQUIRE_POLICY;
  type Step<T> = PackageMapSteps<T>;
  const ask = {
    *kind(path: string): Step<'file' | 'directory' | null> {
      if (options.progress) yield options.progress(METADATA_CANDIDATE_WORK + path.length);
      try {
        const kind = yield host.kind(path);
        return kind === 'file' || kind === 'directory' ? kind : null;
      } catch (err) {
        if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return null;
        throw err;
      }
    },
    *text(path: string): Step<string | null> {
      const text = yield host.readText(path);
      if (typeof text !== 'string') return null;
      if (options.progress) yield options.progress(text.length);
      return text;
    },
    *realpath(path: string): Step<string> {
      const real = yield host.realpath(path);
      if (typeof real !== 'string') throw new Error('The CommonJS host must answer realpath with a path');
      return absolute(real);
    },
  };

  /** One request's metadata cache; never retain it across filesystem changes. */
  interface State { configs: Map<string, PackageConfig | null> }
  function* readPackage(path: string, state: State, scope = false): Step<PackageConfig | null> {
    if (state.configs.has(path)) return state.configs.get(path) ?? null;
    let kind: 'file' | 'directory' | null;
    try { kind = yield* ask.kind(path); }
    catch (err) {
      // Named authority policy shared with packageJsonVisible: an inaccessible
      // enclosing directory is not a package scope of this principal.
      if (scope && codeOf(err) === 'EACCES') return null;
      throw err;
    }
    if (kind !== 'file') { state.configs.set(path, null); return null; }
    const text = yield* ask.text(path);
    if (text === null) { state.configs.set(path, null); return null; }
    let pkg: unknown;
    try { pkg = JSON.parse(packageJsonText(text)); }
    catch { throw error('ERR_INVALID_PACKAGE_CONFIG', 'Invalid package config ' + path + '.'); }
    const config: PackageConfig = pkg !== null && typeof pkg === 'object' ? pkg as PackageConfig : {};
    state.configs.set(path, config);
    return config;
  }
  function* nearestPackageScope(fromDir: string, state: State): Step<RequirePackageScope | null> {
    for (let dir = absolute(fromDir); ; dir = parentDir(dir)) {
      if (dir.slice(dir.lastIndexOf('/') + 1) === 'node_modules') return null;
      const packageJsonPath = (dir === '/' ? '' : dir) + '/package.json';
      const pkg = yield* readPackage(packageJsonPath, state, true);
      if (pkg) return {
        dir, packageJsonPath, pkg,
        type: pkg.type === 'module' || pkg.type === 'commonjs' ? pkg.type : null,
      };
      if (dir === '/') return null;
    }
  }
  function* loadAsFile(path: string): Step<string | null> {
    for (const suffix of ['', '.js', '.json', '.node']) {
      const candidate = absolute(path + suffix);
      if ((yield* ask.kind(candidate)) === 'file') return candidate;
    }
    return null;
  }
  function* loadIndex(path: string): Step<string | null> {
    for (const suffix of ['/index.js', '/index.json', '/index.node']) {
      const candidate = absolute(path + suffix);
      if ((yield* ask.kind(candidate)) === 'file') return candidate;
    }
    return null;
  }
  function* loadAsDirectory(path: string, state: State): Step<string | null> {
    if ((yield* ask.kind(path)) !== 'directory') return null;
    const pkgPath = (path === '/' ? '' : path) + '/package.json';
    const pkg = yield* readPackage(pkgPath, state);
    if (typeof pkg?.main === 'string' && pkg.main) {
      const main = absolute(pkg.main.startsWith('/') ? pkg.main : path + '/' + pkg.main);
      // Node does not read a second package.json at main: it tries main as
      // a file and then main/index, never recursively LOAD_AS_DIRECTORY.
      const found = (yield* loadAsFile(main)) ?? (yield* loadIndex(main)) ?? (yield* loadIndex(path));
      if (found) return found;
      if (policy.typescriptFallback) {
        const source = (yield* typeScriptFallback(main)) ?? (yield* typeScriptFallback(path));
        if (source) return source;
      }
      throw moduleNotFound(
        "Cannot find module '" + main + "'. Please verify that the package.json has a valid \"main\" entry",
        { path: pkgPath, requestPath: path });
    }
    return yield* loadIndex(path);
  }
  function* resolveFile(path: string, state: State, trailingSlash = false): Step<string | null> {
    const normalized = absolute(path);
    const found = (!trailingSlash ? yield* loadAsFile(normalized) : null) ?? (yield* loadAsDirectory(normalized, state));
    return found ?? (policy.typescriptFallback ? yield* typeScriptFallback(normalized) : null);
  }
  function* typeScriptFallback(path: string): Step<string | null> {
    for (const candidate of typescriptFallbackCandidates(path)) {
      if ((yield* ask.kind(candidate)) === 'file') return candidate;
    }
    if ((yield* ask.kind(path)) === 'directory') {
      for (const suffix of TYPESCRIPT_INDEX_CANDIDATES) {
        if ((yield* ask.kind(path + suffix)) === 'file') return path + suffix;
      }
    }
    return null;
  }
  function exportsNotFound(subpath: string, pjsonPath: string): Error {
    return error('ERR_PACKAGE_PATH_NOT_EXPORTED', subpath === '.'
      ? 'No "exports" main defined in ' + pjsonPath
      : "Package subpath '" + subpath + "' is not defined by \"exports\" in " + pjsonPath);
  }
  function* resolveMap(
    field: unknown, name: string, pjsonPath: string, fromDir: string, internal: boolean, state: State,
  ): Step<URL | null | undefined> {
    const url = fileUrl(pjsonPath);
    const mapPolicy = createNodePackageMapPolicy(url, fromDir, internal,
      (target) => resolveBareTarget(target, parentDir(pjsonPath), state));
    return yield* selectPackageMap(field, name, conditions, mapPolicy);
  }
  /** ESM PACKAGE_RESOLVE for a bare imports target, under require's conditions. */
  function* resolveBareTarget(name: string, fromDir: string, state: State): Step<URL> {
    if (host.isBuiltin?.(name)) return new URL(name.startsWith('node:') ? name : 'node:' + name);
    const split = packageName(name);
    if (!split || /^\.|%|\\/.test(split.name)) {
      throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + name + '" is not a valid package name imported from ' + fromDir, TypeError);
    }
    const self = yield* nearestPackageScope(fromDir, state);
    const selfSubpath = packageSelfReferenceSubpath(self?.pkg, name);
    if (self && selfSubpath !== null) {
      const target = yield* resolveMap(self.pkg.exports, selfSubpath, self.packageJsonPath, fromDir, false, state);
      if (target == null) throw exportsNotFound(selfSubpath, self.packageJsonPath);
      return target;
    }
    for (const folder of requireNodeModulePaths(fromDir)) {
      const dir = folder + '/' + split.name;
      if ((yield* ask.kind(dir)) !== 'directory') continue;
      const pjsonPath = dir + '/package.json';
      const pkg = yield* readPackage(pjsonPath, state);
      if (pkg?.exports != null) {
        const target = yield* resolveMap(pkg.exports, split.subpath, pjsonPath, fromDir, false, state);
        if (target == null) throw exportsNotFound(split.subpath, pjsonPath);
        return target;
      }
      if (split.subpath !== '.') return new URL(split.subpath, fileUrl(pjsonPath));
      const found = yield* loadAsDirectory(dir, state);
      if (found) return fileUrl(found);
      throw error('ERR_MODULE_NOT_FOUND', "Cannot find package '" + dir + "/index.js' imported from " + fromDir);
    }
    throw error('ERR_MODULE_NOT_FOUND', "Cannot find package '" + split.name + "' imported from " + fromDir);
  }
  function packageName(id: string): { name: string; subpath: string } | null {
    let slash = id.indexOf('/');
    if (id.startsWith('@')) {
      if (slash === -1) return null;
      slash = id.indexOf('/', slash + 1);
    }
    return { name: slash === -1 ? id : id.slice(0, slash), subpath: slash === -1 ? '.' : '.' + id.slice(slash) };
  }
  function* finalizeTarget(target: URL, pjsonPath: string): Step<string> {
    if (target.protocol !== 'file:') throw error('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file', TypeError);
    if (/%2f|%5c/i.test(target.pathname)) {
      throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + target.pathname + '" must not include encoded "/" or "\\" characters', TypeError);
    }
    const path = decodeURIComponent(target.pathname);
    if ((yield* ask.kind(path)) !== 'file') {
      throw moduleNotFound("Cannot find module '" + path + "'", { path: pjsonPath });
    }
    return absolute(path);
  }
  function* loadPackageSelf(name: string, fromDir: string, state: State): Step<string | null> {
    const scope = yield* nearestPackageScope(fromDir, state);
    const subpath = packageSelfReferenceSubpath(scope?.pkg, name);
    if (!scope || subpath === null) return null;
    const target = yield* resolveMap(scope.pkg.exports, subpath, scope.packageJsonPath, fromDir, false, state);
    if (target == null) throw exportsNotFound(subpath, scope.packageJsonPath);
    return yield* finalizeTarget(target, scope.packageJsonPath);
  }
  function* loadNodeModules(name: string, folders: readonly string[], fromDir: string, state: State): Step<string | null> {
    const split = packageName(name);
    for (const folder of folders) {
      if (split && split.name !== '' && !name.includes('\\')) {
        const pjsonPath = absolute(folder + '/' + split.name + '/package.json');
        const pkg = yield* readPackage(pjsonPath, state);
        if (pkg?.exports != null) {
          const target = yield* resolveMap(pkg.exports, split.subpath, pjsonPath, fromDir, false, state);
          if (target == null) throw exportsNotFound(split.subpath, pjsonPath);
          return yield* finalizeTarget(target, pjsonPath);
        }
      }
      const found = yield* resolveFile(folder + '/' + name, state, name.endsWith('/'));
      if (found) return found;
    }
    return null;
  }
  function* resolvePath(id: string, fromDir: string, request: RequireResolveOptions, state: State): Step<string | URL | null> {
    const dir = absolute(fromDir);
    if (id === '') return null;
    if (host.isBuiltin?.(id)) return new URL(id.startsWith('node:') ? id : 'node:' + id);
    if (id.startsWith('/')) return yield* resolveFile(id, state, id.endsWith('/'));
    if (relativeRequest(id)) {
      for (const origin of request.paths ?? [dir]) {
        const found = yield* resolveFile(origin + '/' + id, state, id.endsWith('/') || id === '.' || id === '..' || id.endsWith('/.') || id.endsWith('/..'));
        if (found) return found;
      }
      return null;
    }
    if (id.startsWith('#')) {
      const scope = yield* nearestPackageScope(dir, state);
      if (scope && scope.pkg.imports != null) {
        const from = request.parent ?? dir;
        if (id === '#' || id.startsWith('#/') || id.endsWith('/')) {
          throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + id + '" is not a valid internal imports specifier name imported from ' + from, TypeError);
        }
        let target: URL | null | undefined;
        try { target = yield* resolveMap(scope.pkg.imports, id, scope.packageJsonPath, from, true, state); }
        catch (err) {
          // Node's CJS boundary translates an ESM PACKAGE_RESOLVE miss to
          // its own MODULE_NOT_FOUND, with this require's stack.
          if (codeOf(err) === 'ERR_MODULE_NOT_FOUND') return null;
          throw err;
        }
        if (target != null) return yield* finalizeTarget(target, scope.packageJsonPath);
        throw error('ERR_PACKAGE_IMPORT_NOT_DEFINED', 'Package import specifier "' + id + '" is not defined in package ' + scope.packageJsonPath + ' imported from ' + from, TypeError);
      }
    }
    const self = yield* loadPackageSelf(id, dir, state);
    if (self) return self;
    const folders = [...new Set((request.paths ?? [dir]).flatMap(requireNodeModulePaths))];
    folders.push(...(policy.globalFolders ?? []));
    return yield* loadNodeModules(id, folders, dir, state);
  }
  function* resolve(id: string, fromDir: string, request: RequireResolveOptions = {}): Step<CommonJsResolution | null> {
    const state: State = { configs: new Map() };
    const found = yield* resolvePath(id, fromDir, request, state);
    if (found === null) return null;
    if (found instanceof URL) return { builtin: found.pathname, scope: null, packageType: null };
    const path = yield* ask.realpath(found);
    const scope = options.collectPackageScope === false ? null : yield* nearestPackageScope(parentDir(path), state);
    return { path, scope, packageType: scope?.type ?? null };
  }
  function* resolveFilePath(path: string): Step<string | null> {
    const found = yield* resolveFile(path, { configs: new Map() }, path.endsWith('/'));
    return found === null ? null : yield* ask.realpath(found);
  }
  function runSync<T>(steps: Step<T>): T {
    let next = steps.next();
    while (!next.done) {
      if (next.value instanceof Promise) throw new Error('resolveSync: the CommonJS host answered asynchronously');
      next = steps.next(next.value);
    }
    return next.value;
  }
  async function runAsync<T>(steps: Step<T>): Promise<T> {
    let next = steps.next();
    while (!next.done) {
      let answer: unknown;
      try { answer = await next.value; }
      catch (err) { next = steps.throw(err); continue; }
      next = steps.next(answer);
    }
    return next.value;
  }
  return {
    resolve: (id: string, dir: string, request?: RequireResolveOptions) => runAsync(resolve(id, dir, request)),
    resolveSync: (id: string, dir: string, request?: RequireResolveOptions) => runSync(resolve(id, dir, request)),
    resolveFile: (path: string) => runAsync(resolveFilePath(path)),
    resolveFileSync: (path: string) => runSync(resolveFilePath(path)),
    packageScope: (dir: string) => runAsync(nearestPackageScope(dir, { configs: new Map() })),
    packageScopeSync: (dir: string) => runSync(nearestPackageScope(dir, { configs: new Map() })),
  };
}

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
  const url = fileUrl('/package.json');
  const policy = createNodePackageMapPolicy(url, '/', false, function* () { throw new Error('An exports target cannot be bare'); });
  const steps = selectPackageMap(pkg.exports, subpath, new Set([...DEFAULT_CJS_CONDITIONS, ...conditions]), policy);
  const next = steps.next();
  if (!next.done) throw new Error('Package entry selection must be synchronous');
  return next.value == null ? null : '.' + next.value.pathname + next.value.search + next.value.hash;
}
