/**
 * One Node CommonJS resolution algorithm. Generators yield metadata questions;
 * sync guests/lifo and the async launch walker drive exactly the same steps.
 * Filesystem access, module loading, builtins and require-stack assembly remain
 * host/loader policy. NODE_PATH and Node's global folders are not discovered.
 *
 * The guest's require() resolves here after a program may have replaced
 * built-ins, so it calls only those the launch captured (primordials.ts), as
 * Node's loader calls its primordials, and reads a parsed package.json's own
 * fields alone, as Node's reader does (tests/unit/primordials-audit.mjs).
 * runtime/require-resolution.ts re-exports it beside the launch's adapters.
 */
import {
  codeOf, createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, nativeResolutionError, packageJsonText, packageSelfReferenceSubpath,
  resolutionError, selectPackageMap, urlPathname, urlProtocol, urlSetPathname, type PackageMapSteps,
} from './package-map.js';
import {
  arrayIsArray, dataDescriptor, decodeURIComponentOf, Error, generatorNext, generatorThrow, JSONParse, newURL, objectHasOwn,
  ownField, PromiseConstructor, reflectApply, reflectDefineProperty, regExpExec, SafeList, SafeMap, SafeSet,
  safeGenerator, stringEndsWith, stringIncludes, stringIndexOf, stringLastIndexOf, stringSlice, stringStartsWith, TypeError,
} from './primordials.js';
import { TYPESCRIPT_INDEX_CANDIDATES, typescriptFallbackCandidates } from './typescript-specifiers.js';

type Awaitable<T> = T | Promise<T>;
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
/** A package scope's "type" (runtime/module-format.ts PackageType). */
export type PackageType = 'module' | 'commonjs' | null;
/** A package.json's fields resolution reads, each the file's own. */
export interface PackageConfig {
  name: string | undefined;
  main: string | undefined;
  exports: unknown;
  imports: unknown;
  type: unknown;
}
export interface RequirePackageScope {
  dir: string;
  packageJsonPath: string;
  pkg: PackageConfig;
  type: PackageType;
}
/** Every field its own: a loader that reads one finds no inherited value. */
export interface CommonJsResolution {
  path: string | undefined;
  builtin: string | undefined;
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

/** A spelling `absolute` changes beyond a leading slash: a trailing slash, an empty segment, or a `.`/`..` segment. */
const NOT_NORMAL = /\/$|\/\/|(?:^|\/)\.\.?(?:\/|$)/;

/**
 * `path` as an absolute VFS path: empty and `.` segments dropped, `..`
 * popping one (never past the root), no trailing slash (vfs/path.ts
 * normalizeVfsPath's rule, on the captures).
 */
export function absolute(path: string): string {
  // Already normal (most are: a directory and a name), as vfs/path.ts plainVfsPath finds it.
  if (regExpExec(NOT_NORMAL, path) === null) return path[0] === '/' ? path : `/${path}`;
  const out = new SafeList<string>();
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i < path.length && path[i] !== '/') continue;
    const segment = stringSlice(path, start, i);
    start = i + 1;
    if (segment === '..') {
      if (out.length > 0) out.length = out.length - 1;
    } else if (segment !== '.' && segment !== '') out[out.length] = segment;
  }
  let joined = '';
  for (let i = 0; i < out.length; i++) joined += `/${out[i]}`;
  return joined === '' ? '/' : joined;
}
const parentDir = (path: string): string => stringSlice(path, 0, stringLastIndexOf(path, '/')) || '/';
const relativeRequest = (id: string): boolean => id === '.' || id === '..' || stringStartsWith(id, './') || stringStartsWith(id, '../');
const fileUrl = (path: string): URL => {
  const url = newURL('file://');
  urlSetPathname(url, path);
  return url;
};
const error = resolutionError;
/** A module require() did not find: a plain Error, its code MODULE_NOT_FOUND, then `props`, as Node's CJS loader makes it. */
function moduleNotFound(message: string, path: string, requestPath: string | undefined): Error {
  const made = new Error(message);
  reflectDefineProperty(made, 'code', dataDescriptor('MODULE_NOT_FOUND', true, true, true));
  reflectDefineProperty(made, 'path', dataDescriptor(path, true, true, true));
  if (requestPath !== undefined) reflectDefineProperty(made, 'requestPath', dataDescriptor(requestPath, true, true, true));
  return made;
}
const ENCODED_SEPARATOR = /%2f|%5c/i;
const FILE_SUFFIXES = ['', '.js', '.json', '.node'];
const INDEX_SUFFIXES = ['/index.js', '/index.json', '/index.node'];

/** A package name Node refuses: one starting with `.`, or holding `%` or `\`. */
function invalidPackageName(name: string): boolean {
  if (name[0] === '.') return true;
  for (let i = 0; i < name.length; i++) if (name[i] === '%' || name[i] === '\\') return true;
  return false;
}

/** Node's node_modules lookup paths, with no node_modules/node_modules. */
export function requireNodeModulePaths(fromDir: string): string[] {
  // An ordinary array, the program's (Module._nodeModulePaths returns it), written as Node's push writes it.
  const paths: string[] = [];
  for (let dir = absolute(fromDir); ; dir = parentDir(dir)) {
    if (stringSlice(dir, stringLastIndexOf(dir, '/') + 1) !== 'node_modules') paths[paths.length] = (dir === '/' ? '' : dir) + '/node_modules';
    if (dir === '/') return paths;
  }
}

/** One request's metadata cache; never retain it across filesystem changes. */
interface State { readonly configs: SafeMap<string, PackageConfig | null> }

export function createRequireResolver(host: RequireResolverHost, options: RequireResolverOptions = {}) {
  // The options and the host read as the caller gave them, not as an object they inherit from has them.
  const conditions = new SafeSet<string>();
  for (let i = 0; i < DEFAULT_CJS_CONDITIONS.length; i++) conditions.add(DEFAULT_CJS_CONDITIONS[i]);
  const given = ownField(options, 'conditions');
  if (arrayIsArray(given)) {
    const extra: readonly unknown[] = given;
    for (let i = 0; i < extra.length; i++) {
      const condition = extra[i];
      if (typeof condition === 'string') conditions.add(condition);
    }
  }
  const policy = ownField(options, 'policy');
  const policyObject = policy !== null && typeof policy === 'object' ? policy : NODE_REQUIRE_POLICY;
  const typescriptFallback = ownField(policyObject, 'typescriptFallback') === true;
  const globalFolders = ownField(policyObject, 'globalFolders');
  const progressOf = ownField(options, 'progress');
  const progress = typeof progressOf === 'function' ? (work: number): unknown => reflectApply(progressOf, options, [work]) : null;
  const collectPackageScope = ownField(options, 'collectPackageScope') !== false;
  const isBuiltinOf = ownField(host, 'isBuiltin');
  const isBuiltin = (specifier: string): boolean => typeof isBuiltinOf === 'function' && reflectApply(isBuiltinOf, host, [specifier]) === true;
  type Step<T> = PackageMapSteps<T>;
  const ask = {
    kind: safeGenerator(function* (path: string): Step<'file' | 'directory' | null> {
      if (progress !== null) yield progress(METADATA_CANDIDATE_WORK + path.length);
      try {
        const kind = yield host.kind(path);
        return kind === 'file' || kind === 'directory' ? kind : null;
      } catch (err) {
        if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return null;
        throw err;
      }
    }),
    text: safeGenerator(function* (path: string): Step<string | null> {
      const text = yield host.readText(path);
      if (typeof text !== 'string') return null;
      if (progress !== null) yield progress(text.length);
      return text;
    }),
    realpath: safeGenerator(function* (path: string): Step<string> {
      const real = yield host.realpath(path);
      if (typeof real !== 'string') throw new Error('The CommonJS host must answer realpath with a path');
      return absolute(real);
    }),
  };

  const readPackage = safeGenerator(function* (path: string, state: State, scope: boolean): Step<PackageConfig | null> {
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
    try { pkg = JSONParse(packageJsonText(text)); }
    catch { throw nativeResolutionError('ERR_INVALID_PACKAGE_CONFIG', 'Invalid package config ' + path + '.'); }
    const object = pkg !== null && typeof pkg === 'object' ? pkg : {};
    const name = ownField(object, 'name');
    const main = ownField(object, 'main');
    const config: PackageConfig = {
      name: typeof name === 'string' ? name : undefined,
      main: typeof main === 'string' ? main : undefined,
      exports: ownField(object, 'exports'),
      imports: ownField(object, 'imports'),
      type: ownField(object, 'type'),
    };
    state.configs.set(path, config);
    return config;
  });
  const nearestPackageScope = safeGenerator(function* (fromDir: string, state: State): Step<RequirePackageScope | null> {
    for (let dir = absolute(fromDir); ; dir = parentDir(dir)) {
      if (stringSlice(dir, stringLastIndexOf(dir, '/') + 1) === 'node_modules') return null;
      const packageJsonPath = (dir === '/' ? '' : dir) + '/package.json';
      const pkg = yield* readPackage(packageJsonPath, state, true);
      if (pkg) return {
        dir, packageJsonPath, pkg,
        type: pkg.type === 'module' || pkg.type === 'commonjs' ? pkg.type : null,
      };
      if (dir === '/') return null;
    }
  });
  const loadAsFile = safeGenerator(function* (path: string): Step<string | null> {
    for (let i = 0; i < FILE_SUFFIXES.length; i++) {
      const candidate = absolute(path + FILE_SUFFIXES[i]);
      if ((yield* ask.kind(candidate)) === 'file') return candidate;
    }
    return null;
  });
  const loadIndex = safeGenerator(function* (path: string): Step<string | null> {
    for (let i = 0; i < INDEX_SUFFIXES.length; i++) {
      const candidate = absolute(path + INDEX_SUFFIXES[i]);
      if ((yield* ask.kind(candidate)) === 'file') return candidate;
    }
    return null;
  });
  const loadAsDirectory = safeGenerator(function* (path: string, state: State): Step<string | null> {
    if ((yield* ask.kind(path)) !== 'directory') return null;
    const pkgPath = (path === '/' ? '' : path) + '/package.json';
    const pkg = yield* readPackage(pkgPath, state, false);
    if (pkg !== null && pkg.main) {
      const main = absolute(stringStartsWith(pkg.main, '/') ? pkg.main : path + '/' + pkg.main);
      // Node does not read a second package.json at main: it tries main as
      // a file and then main/index, never recursively LOAD_AS_DIRECTORY.
      const found = (yield* loadAsFile(main)) ?? (yield* loadIndex(main)) ?? (yield* loadIndex(path));
      if (found) return found;
      if (typescriptFallback) {
        const source = (yield* typeScriptFallback(main)) ?? (yield* typeScriptFallback(path));
        if (source) return source;
      }
      throw moduleNotFound(
        "Cannot find module '" + main + "'. Please verify that the package.json has a valid \"main\" entry", pkgPath, path);
    }
    return yield* loadIndex(path);
  });
  const resolveFile = safeGenerator(function* (path: string, state: State, trailingSlash: boolean): Step<string | null> {
    const normalized = absolute(path);
    const found = (!trailingSlash ? yield* loadAsFile(normalized) : null) ?? (yield* loadAsDirectory(normalized, state));
    return found ?? (typescriptFallback ? yield* typeScriptFallback(normalized) : null);
  });
  const typeScriptFallback = safeGenerator(function* (path: string): Step<string | null> {
    const candidates = typescriptFallbackCandidates(path);
    for (let i = 0; i < candidates.length; i++) {
      if ((yield* ask.kind(candidates[i])) === 'file') return candidates[i];
    }
    if ((yield* ask.kind(path)) === 'directory') {
      for (let i = 0; i < TYPESCRIPT_INDEX_CANDIDATES.length; i++) {
        if ((yield* ask.kind(path + TYPESCRIPT_INDEX_CANDIDATES[i])) === 'file') return path + TYPESCRIPT_INDEX_CANDIDATES[i];
      }
    }
    return null;
  });
  function exportsNotFound(subpath: string, pjsonPath: string): Error {
    return error('ERR_PACKAGE_PATH_NOT_EXPORTED', subpath === '.'
      ? 'No "exports" main defined in ' + pjsonPath
      : "Package subpath '" + subpath + "' is not defined by \"exports\" in " + pjsonPath);
  }
  const resolveMap = safeGenerator(function* (
    field: unknown, name: string, pjsonPath: string, fromDir: string, internal: boolean, state: State,
  ): Step<URL | null | undefined> {
    const url = fileUrl(pjsonPath);
    const mapPolicy = createNodePackageMapPolicy(url, fromDir, internal,
      (target) => resolveBareTarget(target, parentDir(pjsonPath), state));
    return yield* selectPackageMap(field, name, conditions, mapPolicy);
  });
  /** ESM PACKAGE_RESOLVE for a bare imports target, under require's conditions. */
  const resolveBareTarget = safeGenerator(function* (name: string, fromDir: string, state: State): Step<URL> {
    if (isBuiltin(name)) return newURL(stringStartsWith(name, 'node:') ? name : 'node:' + name);
    const split = packageName(name);
    if (!split || invalidPackageName(split.name)) {
      throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + name + '" is not a valid package name imported from ' + fromDir, TypeError);
    }
    const self = yield* nearestPackageScope(fromDir, state);
    const selfSubpath = packageSelfReferenceSubpath(self?.pkg, name);
    if (self && selfSubpath !== null) {
      const target = yield* resolveMap(self.pkg.exports, selfSubpath, self.packageJsonPath, fromDir, false, state);
      if (target == null) throw exportsNotFound(selfSubpath, self.packageJsonPath);
      return target;
    }
    const folders = requireNodeModulePaths(fromDir);
    for (let i = 0; i < folders.length; i++) {
      const dir = folders[i] + '/' + split.name;
      if ((yield* ask.kind(dir)) !== 'directory') continue;
      const pjsonPath = dir + '/package.json';
      const pkg = yield* readPackage(pjsonPath, state, false);
      if (pkg !== null && pkg.exports != null) {
        const target = yield* resolveMap(pkg.exports, split.subpath, pjsonPath, fromDir, false, state);
        if (target == null) throw exportsNotFound(split.subpath, pjsonPath);
        return target;
      }
      if (split.subpath !== '.') return newURL(split.subpath, fileUrl(pjsonPath));
      const found = yield* loadAsDirectory(dir, state);
      if (found) return fileUrl(found);
      // legacyMainResolve's.
      throw nativeResolutionError('ERR_MODULE_NOT_FOUND', "Cannot find package '" + dir + "/index.js' imported from " + fromDir);
    }
    throw error('ERR_MODULE_NOT_FOUND', "Cannot find package '" + split.name + "' imported from " + fromDir);
  });
  function packageName(id: string): { name: string; subpath: string } | null {
    let slash = stringIndexOf(id, '/');
    if (stringStartsWith(id, '@')) {
      if (slash === -1) return null;
      slash = stringIndexOf(id, '/', slash + 1);
    }
    return { name: slash === -1 ? id : stringSlice(id, 0, slash), subpath: slash === -1 ? '.' : '.' + stringSlice(id, slash) };
  }
  const finalizeTarget = safeGenerator(function* (target: URL, pjsonPath: string): Step<string> {
    if (urlProtocol(target) !== 'file:') throw error('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file', TypeError);
    const pathname = urlPathname(target);
    if (regExpExec(ENCODED_SEPARATOR, pathname) !== null) {
      throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + pathname + '" must not include encoded "/" or "\\" characters', TypeError);
    }
    const path = decodeURIComponentOf(pathname);
    if ((yield* ask.kind(path)) !== 'file') throw moduleNotFound("Cannot find module '" + path + "'", pjsonPath, undefined);
    return absolute(path);
  });
  const loadPackageSelf = safeGenerator(function* (name: string, fromDir: string, state: State): Step<string | null> {
    const scope = yield* nearestPackageScope(fromDir, state);
    const subpath = packageSelfReferenceSubpath(scope?.pkg, name);
    if (!scope || subpath === null) return null;
    const target = yield* resolveMap(scope.pkg.exports, subpath, scope.packageJsonPath, fromDir, false, state);
    if (target == null) throw exportsNotFound(subpath, scope.packageJsonPath);
    return yield* finalizeTarget(target, scope.packageJsonPath);
  });
  const loadNodeModules = safeGenerator(function* (name: string, folders: SafeList<string>, fromDir: string, state: State): Step<string | null> {
    const split = packageName(name);
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      if (split && split.name !== '' && !stringIncludes(name, '\\')) {
        const pjsonPath = absolute(folder + '/' + split.name + '/package.json');
        const pkg = yield* readPackage(pjsonPath, state, false);
        if (pkg !== null && pkg.exports != null) {
          const target = yield* resolveMap(pkg.exports, split.subpath, pjsonPath, fromDir, false, state);
          if (target == null) throw exportsNotFound(split.subpath, pjsonPath);
          return yield* finalizeTarget(target, pjsonPath);
        }
      }
      const found = yield* resolveFile(folder + '/' + name, state, stringEndsWith(name, '/'));
      if (found) return found;
    }
    return null;
  });
  /** The request's origins: its own paths (own, as the caller gave them), or the requiring directory. */
  const originsOf = (request: RequireResolveOptions, dir: string): readonly string[] => {
    const paths = ownField(request, 'paths');
    return arrayIsArray(paths) ? paths : [dir];
  };
  const resolvePath = safeGenerator(function* (id: string, fromDir: string, request: RequireResolveOptions, state: State): Step<string | URL | null> {
    const dir = absolute(fromDir);
    if (id === '') return null;
    if (isBuiltin(id)) return newURL(stringStartsWith(id, 'node:') ? id : 'node:' + id);
    if (stringStartsWith(id, '/')) return yield* resolveFile(id, state, stringEndsWith(id, '/'));
    const origins = originsOf(request, dir);
    if (relativeRequest(id)) {
      const trailing = stringEndsWith(id, '/') || id === '.' || id === '..' || stringEndsWith(id, '/.') || stringEndsWith(id, '/..');
      for (let i = 0; i < origins.length; i++) {
        const found = yield* resolveFile(origins[i] + '/' + id, state, trailing);
        if (found) return found;
      }
      return null;
    }
    if (stringStartsWith(id, '#')) {
      const scope = yield* nearestPackageScope(dir, state);
      if (scope && scope.pkg.imports != null) {
        const parent = ownField(request, 'parent');
        const from = typeof parent === 'string' ? parent : dir;
        if (id === '#' || stringStartsWith(id, '#/') || stringEndsWith(id, '/')) {
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
    // Each origin's lookup paths, the first of each kept, then the policy's global folders.
    const folders = new SafeList<string>();
    const seen = new SafeSet<string>();
    for (let i = 0; i < origins.length; i++) {
      // A hole is no origin (Array.prototype.flatMap's skip).
      if (!objectHasOwn(origins, i)) continue;
      const paths = requireNodeModulePaths(origins[i]);
      for (let j = 0; j < paths.length; j++) {
        if (seen.has(paths[j])) continue;
        seen.add(paths[j]);
        folders[folders.length] = paths[j];
      }
    }
    if (arrayIsArray(globalFolders)) {
      const extra: readonly unknown[] = globalFolders;
      for (let i = 0; i < extra.length; i++) {
        const folder = extra[i];
        if (typeof folder === 'string') folders[folders.length] = folder;
      }
    }
    return yield* loadNodeModules(id, folders, dir, state);
  });
  const resolve = safeGenerator(function* (id: string, fromDir: string, request: RequireResolveOptions): Step<CommonJsResolution | null> {
    const state: State = { configs: new SafeMap() };
    const found = yield* resolvePath(id, fromDir, request, state);
    if (found === null) return null;
    if (typeof found !== 'string') return { path: undefined, builtin: urlPathname(found), scope: null, packageType: null };
    const path = yield* ask.realpath(found);
    const scope = !collectPackageScope ? null : yield* nearestPackageScope(parentDir(path), state);
    return { path, builtin: undefined, scope, packageType: scope?.type ?? null };
  });
  const resolveFilePath = safeGenerator(function* (path: string): Step<string | null> {
    const found = yield* resolveFile(path, { configs: new SafeMap() }, stringEndsWith(path, '/'));
    return found === null ? null : yield* ask.realpath(found);
  });
  function runSync<T>(steps: Step<T>): T {
    let next = generatorNext(steps);
    while (!next.done) {
      if (next.value instanceof PromiseConstructor) throw new Error('resolveSync: the CommonJS host answered asynchronously');
      next = generatorNext(steps, next.value);
    }
    return next.value;
  }
  async function runAsync<T>(steps: Step<T>): Promise<T> {
    let next = generatorNext(steps);
    while (!next.done) {
      let answer: unknown;
      try { answer = await next.value; }
      catch (err) { next = generatorThrow(steps, err); continue; }
      next = generatorNext(steps, answer);
    }
    return next.value;
  }
  const noRequest: RequireResolveOptions = {};
  return {
    resolve: (id: string, dir: string, request?: RequireResolveOptions) => runAsync(resolve(id, dir, request ?? noRequest)),
    resolveSync: (id: string, dir: string, request?: RequireResolveOptions) => runSync(resolve(id, dir, request ?? noRequest)),
    resolveFile: (path: string) => runAsync(resolveFilePath(path)),
    resolveFileSync: (path: string) => runSync(resolveFilePath(path)),
    packageScope: (dir: string) => runAsync(nearestPackageScope(dir, { configs: new SafeMap() })),
    packageScopeSync: (dir: string) => runSync(nearestPackageScope(dir, { configs: new SafeMap() })),
  };
}

