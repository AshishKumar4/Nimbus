/**
 * Node.js `module` shim for Lifo.
 *
 * Provides the commonly used APIs from the `node:module` built-in:
 * - Module class with id, filename, exports, paths, require, etc.
 * - createRequire() — returns a require-like function backed by the module map
 * - builtinModules and isBuiltin() — the module map's core names (createModuleShim)
 */

/**
 * npm packages the module map serves itself (index.ts): required by name, as
 * a built-in is, but no part of Node's core, so not in builtinModules.
 */
export const PROVIDED_PACKAGES = ['rimraf', 'esbuild'] as const;
const provided: ReadonlySet<string> = new Set(PROVIDED_PACKAGES);

/** Whether the module map's `name` is a provided npm package rather than a core module. */
export function isProvidedPackage(name: string): boolean {
  return provided.has(name);
}

/**
 * The module map's name for `specifier`, or null when the map serves no such
 * module: `node:` names a core module only (`node:esbuild` is no module, as
 * in Node), a bare name a core module or a provided package.
 */
export function servedName(moduleMap: Record<string, () => unknown>, specifier: string): string | null {
  const scheme = specifier.startsWith('node:');
  const name = scheme ? specifier.slice(5) : specifier;
  return Object.hasOwn(moduleMap, name) && !(scheme && provided.has(name)) ? name : null;
}

export type RequireFunction = ((id: string) => unknown) & {
  resolve: ((id: string, options?: { paths?: string[] }) => string) & { paths?: (id: string) => string[] | null };
  cache: Record<string, unknown>;
};

/**
 * Factory for createRequire — needs the module map from index.ts at runtime.
 * Called from createModuleMap() so it has access to the lazily-built map.
 */
export function makeCreateRequire(
  moduleMap: Record<string, () => unknown>,
): (filename: string | URL) => RequireFunction {
  return function createRequire(_filename: string | URL): RequireFunction {
    const cache: Record<string, unknown> = {};

    const req = function require(id: string): unknown {
      const name = servedName(moduleMap, id);
      if (name === null) throw new Error(`Cannot find module '${id}'`);
      return cache[name] ??= moduleMap[name]();
    } as RequireFunction;

    req.resolve = (id: string): string => {
      const name = servedName(moduleMap, id);
      if (name === null) throw new Error(`Cannot find module '${id}'`);
      return name;
    };

    req.cache = cache;

    return req;
  };
}

/**
 * Minimal Module class matching the shape code typically expects.
 */
export class Module {
  id: string;
  filename: string;
  exports: unknown;
  parent: Module | null;
  children: Module[];
  loaded: boolean;
  paths: string[];

  constructor(id = '', parent: Module | null = null) {
    this.id = id;
    this.filename = id;
    this.exports = {};
    this.parent = parent;
    this.children = [];
    this.loaded = false;
    this.paths = [];
  }

  require(_id: string): unknown {
    throw new Error('Module.require() is not supported — use createRequire() instead');
  }

  // Each `module` built-in's class has its own (createModuleShim), as its builtinModules and isBuiltin.
  static createRequire: (filename: string | URL) => RequireFunction;

  static _resolveFilename(request: string): string {
    return request;
  }

  static _cache: Record<string, unknown> = {};
}

/**
 * The `module` built-in over a module map, as Node's is its Module class
 * (module.exports = Module, and Module.Module is Module): its builtinModules
 * are the map's core names, and createRequire is `createRequire` (the
 * CommonJS loader's, which resolves files and packages too) or, for a bare
 * map, one that serves the map's built-ins alone.
 */
export function createModuleShim(
  moduleMap: Record<string, () => unknown>,
  createRequire: (filename: string | URL) => RequireFunction = makeCreateRequire(moduleMap),
) {
  // The map's core names: the one inventory of builtinModules, isBuiltin and Module's own.
  const names = Object.keys(moduleMap).filter((name) => !provided.has(name));
  const isMapBuiltin = (specifier: string) => names.includes(specifier.startsWith('node:') ? specifier.slice(5) : specifier);
  // This built-in's own class: what its loader sets on it (createRequire,
  // _resolveFilename, ...) is that loader's, never another loader's, as each
  // of them loads `module` in the one realm.
  class LoaderModule extends Module {
    static createRequire = createRequire;
    static _cache: Record<string, unknown> = {};
    static builtinModules = names;
    static isBuiltin = isMapBuiltin;
    static Module: typeof LoaderModule;
  }
  LoaderModule.Module = LoaderModule;
  return LoaderModule;
}
