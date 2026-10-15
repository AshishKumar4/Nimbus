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
export const PROVIDED_PACKAGES = ['rimraf', 'esbuild'];
const provided = new Set(PROVIDED_PACKAGES);
/**
 * Factory for createRequire — needs the module map from index.ts at runtime.
 * Called from createModuleMap() so it has access to the lazily-built map.
 */
export function makeCreateRequire(moduleMap) {
    return function createRequire(_filename) {
        const cache = {};
        const req = function require(id) {
            const name = id.startsWith('node:') ? id.slice(5) : id;
            if (cache[name])
                return cache[name];
            if (moduleMap[name]) {
                const mod = moduleMap[name]();
                cache[name] = mod;
                return mod;
            }
            throw new Error(`Cannot find module '${id}'`);
        };
        req.resolve = (id) => {
            const name = id.startsWith('node:') ? id.slice(5) : id;
            if (moduleMap[name])
                return name;
            throw new Error(`Cannot find module '${id}'`);
        };
        req.cache = cache;
        return req;
    };
}
/**
 * Minimal Module class matching the shape code typically expects.
 */
export class Module {
    id;
    filename;
    exports;
    parent;
    children;
    loaded;
    paths;
    constructor(id = '', parent = null) {
        this.id = id;
        this.filename = id;
        this.exports = {};
        this.parent = parent;
        this.children = [];
        this.loaded = false;
        this.paths = [];
    }
    require(_id) {
        throw new Error('Module.require() is not supported — use createRequire() instead');
    }
    // Each `module` built-in's class has its own (createModuleShim), as its builtinModules and isBuiltin.
    static createRequire;
    static _resolveFilename(request) {
        return request;
    }
    static _cache = {};
}
/**
 * The `module` built-in over a module map: its builtinModules are the map's
 * names, and createRequire is `createRequire` (the CommonJS loader's, which
 * resolves files and packages too) or, for a bare map, one that serves the
 * map's built-ins alone.
 */
export function createModuleShim(moduleMap, createRequire = makeCreateRequire(moduleMap)) {
    // The map's core names: the one inventory of builtinModules, isBuiltin and Module's own.
    const names = Object.keys(moduleMap).filter((name) => !provided.has(name));
    const isMapBuiltin = (specifier) => names.includes(specifier.startsWith('node:') ? specifier.slice(5) : specifier);
    // This built-in's own class: what its loader sets on it (createRequire,
    // _resolveFilename, ...) is that loader's, never another loader's, as each
    // of them loads `module` in the one realm.
    class LoaderModule extends Module {
        static createRequire = createRequire;
        static _cache = {};
        static builtinModules = names;
        static isBuiltin = isMapBuiltin;
    }
    return {
        Module: LoaderModule,
        builtinModules: names,
        isBuiltin: isMapBuiltin,
        createRequire,
        default: LoaderModule,
    };
}
