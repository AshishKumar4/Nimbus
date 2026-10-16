/**
 * Node's ESM resolver, for the process's `import()` (dynamic-import-rewrite.ts
 * turns each `import(x)` into a call of the shims' loader, which resolves
 * here). The algorithm, its conditions and its error codes and messages are
 * Node 22's (lib/internal/modules/esm/resolve.js, get_format.js), checked
 * against real node by tests/unit/esm-resolver-matches-node.mjs:
 *
 *   - relative and absolute specifiers resolve as URLs, with no extension or
 *     index probing; a directory is ERR_UNSUPPORTED_DIR_IMPORT, a miss
 *     ERR_MODULE_NOT_FOUND, each with the "Did you mean" hint Node derives
 *     from what `require` would have found;
 *   - `#name` resolves through the package scope's `imports`, a bare name
 *     through the package's own name (self-reference), then node_modules,
 *     then `exports` (conditions `node`, `import`, `module-sync`, `default`,
 *     and the program's own from `--conditions`, taken in the map's own key
 *     order) or the legacy main;
 *   - `file:`, `node:` and `data:` URLs; every other scheme is refused.
 *
 * The node shims embed it as source (scripts/bundle-facet-workers.mjs
 * compiles it into loaders/generated-workers.ts), so the resolver is one
 * self-contained function: nothing inside may refer to this module.
 */

import { invalidArgType, nodeError } from './node-error.js';
import { createNodePackageMapPolicy, DEFAULT_ESM_CONDITIONS, nativeResolutionError, packageJsonText, selectPackageMap } from './exports-resolver.js';

type MaybePromise<T> = T | Promise<T>;
/**
 * One step of resolution. The algorithm is written once, as generators that
 * yield each question for the host; `resolveSync` answers them in place (the
 * process's synchronous filesystem, and `import.meta.resolve`, which is
 * synchronous in Node) and `resolve` awaits them (the launch's walk over the
 * supervisor).
 */
type Step<T> = Generator<unknown, T, unknown>;

/**
 * What the resolver needs of a filesystem. Paths are absolute. Answers may be
 * promises: the process's loader asks its synchronous filesystem, the launch's
 * module-map walk the supervisor's.
 */
export interface EsmResolverHost {
  /** What is at `path`, following links, or null. */
  kind(path: string): MaybePromise<'file' | 'directory' | null>;
  /** Where `path` is with every link resolved (it exists). */
  realpath(path: string): MaybePromise<string>;
  /** A file's text, or null. */
  readText(path: string): MaybePromise<string | null>;
  /**
   * Node's `module.isBuiltin`: whether a specifier names a builtin, bare
   * (`fs`) or with its scheme (`node:fs`; some, like `node:test`, only so).
   */
  isBuiltin(specifier: string): boolean;
  /** What `require(specifier)` from `parentPath` would load, or null (for hints). */
  cjsResolve(specifier: string, parentPath: string): MaybePromise<string | null>;
}

/** `unknown`: an extension Node's loaders know no format of, which loading refuses (EsmResolver.assertLoadable). */
export type EsmFormat = 'builtin' | 'module' | 'commonjs' | 'json' | 'detect' | 'data' | 'unknown';

export interface EsmResolution {
  url: string;
  /** The file, for a `file:` URL. */
  path?: string;
  /** The builtin's name, for a `node:` URL. */
  builtin?: string;
  format: EsmFormat;
}

export interface EsmResolver {
  resolve(specifier: string, parentUrl: string): Promise<EsmResolution>;
  /** `resolve` over a host whose every answer is immediate. */
  resolveSync(specifier: string, parentUrl: string): EsmResolution;
  /** Node's `import.meta.resolve`, over a host whose every answer is immediate. */
  metaResolveSync(specifier: string, parentUrl: string): string;
  /** Node's import-attribute check, for the format a resolution loads as. */
  validateAttributes(url: string, format: EsmFormat, attributes: Record<string, unknown>): void;
  /** Node's defaultLoad: a resolution of an `unknown` format, which Node resolves, does not load. */
  assertLoadable(resolution: EsmResolution): void;
  /**
   * Node's getPackageScopeConfig for a file: URL, over a host whose every
   * answer is immediate: the package.json path its scope reads, and the
   * "type" it declares.
   */
  packageScopeSync(url: string): PackageScope;
  /** packageScopeSync over a host whose answers may be promises. */
  packageScope(url: string): Promise<PackageScope>;
}

/** Node's package scope of a file: whether a package.json governs it, its path, and the "type" it declares. */
export interface PackageScope {
  readonly exists: boolean;
  readonly pjsonPath: string;
  readonly type: 'module' | 'commonjs' | 'none';
}

/** Node's ERR_UNKNOWN_FILE_EXTENSION message for the file at `path`. */
export function unknownFileExtensionMessage(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return `Unknown file extension "${dot > 0 ? base.slice(dot) : ''}" for ${path}`;
}

/** What a resolver is created with beyond its host. */
export interface EsmResolverOptions {
  /** The program's own conditions (`node --conditions`, `-C`, NODE_OPTIONS'), beside Node's defaults. */
  conditions?: readonly string[];
  /** False under `--no-experimental-strip-types`: a TypeScript file has no format. */
  stripTypes?: boolean;
  /** The process's working directory, which a miss's CommonJS hint resolves a relative specifier from. */
  cwd?: () => string;
}

export function createEsmResolver(host: EsmResolverHost, options: EsmResolverOptions = {}): EsmResolver {
  const conditions = new Set([...DEFAULT_ESM_CONDITIONS, ...(options.conditions ?? [])]);

  // The host's questions, each yielded as-is and typed by what it answers.
  const ask = {
    *kind(path: string): Step<'file' | 'directory' | null> {
      const kind = yield host.kind(path);
      return kind === 'file' || kind === 'directory' ? kind : null;
    },
    *readText(path: string): Step<string | null> {
      const text = yield host.readText(path);
      return typeof text === 'string' ? text : null;
    },
    *realpath(path: string): Step<string> {
      const real = yield host.realpath(path);
      return typeof real === 'string' ? real : path;
    },
    *cjsResolve(specifier: string, parentPath: string): Step<string | null> {
      const found = yield host.cjsResolve(specifier, parentPath);
      return typeof found === 'string' ? found : null;
    },
  };

  const codeOf = (error: unknown): unknown =>
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const filePath = (url: URL | string): string => decodeURIComponent((typeof url === 'string' ? new URL(url) : url).pathname);
  const fileUrl = (path: string): URL => {
    const url = new URL('file://');
    url.pathname = path;
    return url;
  };

  function isRelativeSpecifier(specifier: string): boolean {
    if (specifier[0] !== '.') return false;
    if (specifier.length === 1 || specifier[1] === '/') return true;
    return specifier[1] === '.' && (specifier.length === 2 || specifier[2] === '/');
  }
  const isRelativeOrAbsolute = (specifier: string): boolean =>
    specifier !== '' && (specifier[0] === '/' || isRelativeSpecifier(specifier));

  interface PackageConfig {
    exists: boolean;
    pjsonPath: string;
    name?: string;
    main?: string;
    exports?: unknown;
    imports?: unknown;
    type: 'module' | 'commonjs' | 'none';
  }

  // Each package.json read once, as Node's reader holds the ones it read for
  // the process (src/node_modules.cc GetPackageJSON): a graph's modules share
  // their scopes, and asked them again per import (a launch over pi's 1074
  // modules). Like Node's, it holds no absence (a package.json written later
  // is read), and one that does not parse is read again, its refusal naming
  // each import.
  const packageConfigs = new Map<string, PackageConfig>();
  function* readPackageConfig(pjsonPath: string, specifier: string, base: string | undefined): Step<PackageConfig> {
    const known = packageConfigs.get(pjsonPath);
    if (known !== undefined) return known;
    const text = (yield* ask.kind(pjsonPath)) === 'file' ? yield* ask.readText(pjsonPath) : null;
    if (text === null) return { exists: false, pjsonPath, type: 'none' };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(packageJsonText(text));
    } catch {
      // Node's message names the file and the import, not the parse error; its C++ throws it.
      throw nativeResolutionError(
        'ERR_INVALID_PACKAGE_CONFIG',
        `Invalid package config ${pjsonPath}` +
          (base ? ` while importing ${JSON.stringify(specifier)} from ${base}` : '') + '.',
      );
    }
    const config: PackageConfig = { exists: true, pjsonPath, type: 'none' };
    packageConfigs.set(pjsonPath, config);
    if (parsed === null || typeof parsed !== 'object') return config;
    if (typeof parsed.name === 'string') config.name = parsed.name;
    if (typeof parsed.main === 'string') config.main = parsed.main;
    if ('exports' in parsed) config.exports = parsed.exports;
    if (parsed.imports !== null && typeof parsed.imports === 'object') config.imports = parsed.imports;
    if (parsed.type === 'module' || parsed.type === 'commonjs') config.type = parsed.type;
    return config;
  }

  function* packageScopeConfig(resolved: URL): Step<PackageConfig> {
    let pjsonUrl = new URL('./package.json', resolved);
    while (true) {
      if (pjsonUrl.pathname.endsWith('node_modules/package.json')) break;
      const config = yield* readPackageConfig(filePath(pjsonUrl), resolved.href, undefined);
      if (config.exists) return config;
      const last = pjsonUrl;
      pjsonUrl = new URL('../package.json', pjsonUrl);
      if (pjsonUrl.pathname === last.pathname) break;
    }
    return { exists: false, pjsonPath: filePath(pjsonUrl), type: 'none' };
  }

  function exportsNotFound(subpath: string, pjsonUrl: URL, base: string): Error {
    const pkgPath = filePath(new URL('.', pjsonUrl));
    return nodeError(
      Error,
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      subpath === '.'
        ? `No "exports" main defined in ${pkgPath}package.json imported from ${base}`
        : `Package subpath '${subpath}' is not defined by "exports" in ${pkgPath}package.json imported from ${base}`,
    );
  }

  function* packageExportsResolve(pjsonUrl: URL, subpath: string, config: PackageConfig, base: string): Step<URL> {
    const policy = createNodePackageMapPolicy(pjsonUrl, base, false, (target) => packageResolve(target, pjsonUrl.href));
    const result = yield* selectPackageMap(config.exports, subpath, conditions, policy);
    if (result == null) throw exportsNotFound(subpath, pjsonUrl, base);
    return result;
  }

  function* packageImportsResolve(name: string, baseUrl: string): Step<URL> {
    const base = filePath(baseUrl);
    if (name === '#' || name.startsWith('#/') || name.endsWith('/')) {
      throw nodeError(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${name}" is not a valid internal imports specifier name imported from ${base}`);
    }
    const config = yield* packageScopeConfig(new URL(baseUrl));
    if (config.exists && config.imports) {
      const pjsonUrl = fileUrl(config.pjsonPath);
      const policy = createNodePackageMapPolicy(pjsonUrl, base, true, (target) => packageResolve(target, pjsonUrl.href));
      const result = yield* selectPackageMap(config.imports, name, conditions, policy);
      if (result != null) return result;
    }
    const where = config.exists ? ` in package ${filePath(new URL('.', fileUrl(config.pjsonPath)))}package.json` : '';
    throw nodeError(TypeError, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${name}" is not defined${where} imported from ${base}`);
  }

  function* legacyMainResolve(pjsonUrl: URL, config: PackageConfig, base: string): Step<URL> {
    const tries: string[] = [];
    if (config.main !== undefined) {
      for (const suffix of ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node']) tries.push(`./${config.main}${suffix}`);
    }
    tries.push('./index.js', './index.json', './index.node');
    for (const candidate of tries) {
      const url = new URL(candidate, pjsonUrl);
      if ((yield* ask.kind(filePath(url))) === 'file') return url;
    }
    // Named by its main, or index.js, in the package's directory (a path, so
    // an empty package name's `node_modules//` is `node_modules/`).
    const dir = fileUrl(filePath(new URL('.', pjsonUrl)).replace(/\/+/g, '/'));
    const missing = filePath(new URL(config.main ?? 'index.js', dir));
    throw nativeResolutionError('ERR_MODULE_NOT_FOUND', `Cannot find package '${missing}' imported from ${base}`);
  }

  function* packageResolve(specifier: string, baseUrl: string): Step<URL> {
    if (host.isBuiltin(specifier)) return new URL('node:' + specifier);
    const base = filePath(baseUrl);
    let separator = specifier.indexOf('/');
    let valid = true;
    let scoped = false;
    if (specifier[0] === '@') {
      scoped = true;
      if (separator === -1 || specifier.length === 0) valid = false;
      else separator = specifier.indexOf('/', separator + 1);
    }
    const name = separator === -1 ? specifier : specifier.slice(0, separator);
    if (/^\.|%|\\/.test(name)) valid = false;
    if (!valid) {
      throw nodeError(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${specifier}" is not a valid package name imported from ${base}`);
    }
    const subpath = '.' + (separator === -1 ? '' : specifier.slice(separator));

    const self = yield* packageScopeConfig(new URL(baseUrl));
    if (self.exists && self.exports != null && self.name === name) {
      return yield* packageExportsResolve(fileUrl(self.pjsonPath), subpath, self, base);
    }

    let pjsonUrl = new URL('./node_modules/' + name + '/package.json', baseUrl);
    let pjsonPath = filePath(pjsonUrl);
    let lastPath: string;
    do {
      if ((yield* ask.kind(pjsonPath.slice(0, pjsonPath.length - 13))) !== 'directory') {
        lastPath = pjsonPath;
        pjsonUrl = new URL((scoped ? '../../../../node_modules/' : '../../../node_modules/') + name + '/package.json', pjsonUrl);
        pjsonPath = filePath(pjsonUrl);
        continue;
      }
      const config = yield* readPackageConfig(pjsonPath, specifier, base);
      if (config.exports != null) return yield* packageExportsResolve(pjsonUrl, subpath, config, base);
      if (subpath === '.') return yield* legacyMainResolve(pjsonUrl, config, base);
      return new URL(subpath, pjsonUrl);
    } while (pjsonPath.length !== lastPath.length);
    throw nodeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find package '${name}' imported from ${base}`);
  }

  function* formatOf(url: URL, path: string): Step<EsmFormat> {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot) : '';
    const typeScript = options.stripTypes !== false;
    if (ext === '.mjs' || (ext === '.mts' && typeScript)) return 'module';
    if (ext === '.cjs' || (ext === '.cts' && typeScript)) return 'commonjs';
    if (ext === '.json') return 'json';
    if (ext === '.js' || (ext === '.ts' && typeScript) || ext === '') {
      const type = (yield* packageScopeConfig(url)).type;
      if (type === 'module') return 'module';
      if (type === 'commonjs') return 'commonjs';
      return 'detect';
    }
    return 'unknown';
  }

  /** A resolution before loading: its URL, and the file or builtin it names. */
  interface Resolved { url: string; path?: string; builtin?: string }

  function* finalizeResolution(resolved: URL, baseUrl: string): Step<Resolved> {
    const base = filePath(baseUrl);
    if (/%2f|%5c/i.test(resolved.pathname)) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module "${resolved.pathname}" must not include encoded "/" or "\\" characters imported from ${base}`,
      );
    }
    const path = filePath(resolved);
    // Node stats the path's last character when it ends in "/", which is
    // always a directory: a trailing slash is a directory import.
    const kind = path.endsWith('/') ? 'directory' : yield* ask.kind(path);
    // These two carry the URL they were resolving: import.meta.resolve
    // answers with it, where import() rejects.
    if (kind === 'directory') {
      throw Object.assign(
        nodeError(Error, 'ERR_UNSUPPORTED_DIR_IMPORT', `Directory import '${path}' is not supported resolving ES modules imported from ${base}`),
        { url: resolved.href },
      );
    }
    if (kind !== 'file') {
      throw Object.assign(
        nodeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find module '${path}' imported from ${base}`),
        { url: resolved.href },
      );
    }
    // The module is its real file, as node's loader names it; the query and
    // fragment stay the specifier's.
    const real = yield* ask.realpath(path);
    const url = fileUrl(real);
    url.search = resolved.search;
    url.hash = resolved.hash;
    return { url: url.href, path: real };
  }

  function* moduleResolve(specifier: string, parentUrl: string): Step<Resolved> {
    let resolved: URL;
    if (isRelativeOrAbsolute(specifier)) resolved = new URL(specifier, parentUrl);
    else if (specifier[0] === '#') resolved = yield* packageImportsResolve(specifier, parentUrl);
    else {
      try { resolved = new URL(specifier); } catch { resolved = yield* packageResolve(specifier, parentUrl); }
    }
    if (resolved.protocol === 'node:') return { url: 'node:' + resolved.pathname, builtin: resolved.pathname };
    if (resolved.protocol !== 'file:') return { url: resolved.href };
    return yield* finalizeResolution(resolved, parentUrl);
  }

  /** What loading a resolution checks first: its scheme, builtin and format. */
  function* loadable(resolved: Resolved): Step<EsmResolution> {
    if (resolved.builtin !== undefined) {
      if (!host.isBuiltin('node:' + resolved.builtin)) {
        throw nodeError(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: node:${resolved.builtin}`);
      }
      return { url: resolved.url, builtin: resolved.builtin, format: 'builtin' };
    }
    if (resolved.url.startsWith('data:')) return { url: resolved.url, format: 'data' };
    if (resolved.path === undefined) {
      throw nodeError(
        Error,
        'ERR_UNSUPPORTED_ESM_URL_SCHEME',
        `Only URLs with a scheme in: file and data are supported by the default ESM loader. Received protocol '${new URL(resolved.url).protocol}'`,
      );
    }
    return { url: resolved.url, path: resolved.path, format: yield* formatOf(new URL(resolved.url), resolved.path) };
  }

  /**
   * Node's resolveAsCommonJS: the hint an ESM miss carries. Its CommonJS
   * module has no filename, so Node's require resolves a relative
   * specifier from the working directory (Module._resolveLookupPaths' ['.'])
   * and the hint is that file relative to the importer.
   */
  function* commonJsHint(specifier: string, parentUrl: string): Step<string | null> {
    const cwd = options.cwd?.();
    const from = isRelativeSpecifier(specifier) && cwd !== undefined ? `${cwd.replace(/\/+$/, '')}/[cwd]` : filePath(parentUrl);
    let found = yield* ask.cjsResolve(specifier, from);
    if (found === null) return null;
    if (isRelativeSpecifier(specifier)) {
      const from = parentUrl.slice('file://'.length, parentUrl.lastIndexOf('/')).split('/').filter(Boolean);
      const to = fileUrl(found).pathname.split('/').filter(Boolean);
      let common = 0;
      while (common < from.length && common < to.length && from[common] === to[common]) common++;
      found = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
      if (!found.startsWith('../')) found = `./${found}`;
    } else if (specifier[0] && specifier[0] !== '/' && specifier[0] !== '.') {
      const slash = specifier.indexOf('/');
      const pkg = slash === -1 ? specifier : specifier.slice(0, slash);
      const needle = `/node_modules/${pkg}/`;
      const at = found.lastIndexOf(needle);
      found = at !== -1
        ? pkg + '/' + found.slice(at + needle.length).split('/').map(encodeURIComponent).join('/')
        : fileUrl(found).href;
    }
    return found;
  }

  function* resolveWithHint(specifier: string, parentUrl: string): Step<Resolved> {
      try {
        return yield* moduleResolve(specifier, parentUrl);
      } catch (error) {
        const code = codeOf(error);
        if (error instanceof Error && (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT')) {
          const asGiven = specifier.startsWith('file://') ? filePath(specifier) : specifier;
          const found = yield* commonJsHint(asGiven, parentUrl);
          if (found && found !== asGiven) error.message += `\nDid you mean to import ${JSON.stringify(found)}?`;
        }
        throw error;
      }
  }

  function* importTarget(specifier: string, parentUrl: string): Step<EsmResolution> {
    return yield* loadable(yield* resolveWithHint(specifier, parentUrl));
  }

  /** Node's import.meta.resolve: the URL, even of a file or directory that will not load. */
  function* metaResolve(specifier: string, parentUrl: string): Step<string> {
    try {
      return (yield* moduleResolve(specifier, parentUrl)).url;
    } catch (error) {
      const code = codeOf(error);
      if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT')
        && error !== null && typeof error === 'object' && 'url' in error && typeof error.url === 'string') return error.url;
      throw error;
    }
  }

  function runSync<T>(steps: Step<T>): T {
    let next = steps.next();
    while (!next.done) {
      if (next.value instanceof Promise) throw new Error('resolveSync: the host answered asynchronously');
      next = steps.next(next.value);
    }
    return next.value;
  }

  async function runAsync<T>(steps: Step<T>): Promise<T> {
    let next = steps.next();
    while (!next.done) {
      let answer: unknown;
      try {
        answer = await next.value;
      } catch (error) {
        next = steps.throw(error);
        continue;
      }
      next = steps.next(answer);
    }
    return next.value;
  }

  return {
    resolve: (specifier, parentUrl) => runAsync(importTarget(specifier, parentUrl)),
    resolveSync: (specifier, parentUrl) => runSync(importTarget(specifier, parentUrl)),
    metaResolveSync: (specifier, parentUrl) => runSync(metaResolve(specifier, parentUrl)),
    packageScopeSync(url) {
      const { exists, pjsonPath, type } = runSync(packageScopeConfig(new URL(url)));
      return { exists, pjsonPath, type };
    },
    async packageScope(url) {
      const { exists, pjsonPath, type } = await runAsync(packageScopeConfig(new URL(url)));
      return { exists, pjsonPath, type };
    },
    assertLoadable({ format, path }) {
      if (format !== 'unknown' || path === undefined) return;
      throw nodeError(TypeError, 'ERR_UNKNOWN_FILE_EXTENSION', unknownFileExtensionMessage(path));
    },
    validateAttributes(url, format, attributes) {
      for (const key of Object.keys(attributes)) {
        if (key !== 'type') {
          throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "${key}" with value "${attributes[key]}" is not supported in ${url}`);
        }
      }
      const type = attributes.type;
      // Keep the data-URL loading route, but validate its media type like
      // the equivalent file format. application/json still requires type.
      if (format === 'json' || (format === 'data' && /^data:application\/json(?:;[^,]*)?,/.test(url))) {
        if (type === 'json') return;
        if (!('type' in attributes)) {
          throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_MISSING', `Module "${url}" needs an import attribute of "type: json"`);
        }
      } else if (type == null) {
        return;
      }
      if (typeof type !== 'string') {
        throw invalidArgType('type', 'string', type);
      }
      if (type !== 'json') {
        throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "type" with value "${type}" is not supported in ${url}`);
      }
      throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${url}" is not of type "json"`);
    },
  };
}
