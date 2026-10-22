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
export declare const PROVIDED_PACKAGES: readonly ['rimraf', 'esbuild'];
/** Whether the module map's `name` is a provided npm package rather than a core module. */
export declare function isProvidedPackage(name: string): boolean;
/**
 * The module map's name for `specifier`, or null when the map serves no such
 * module: `node:` names a core module only (`node:esbuild` is no module, as
 * in Node), a bare name a core module or a provided package.
 */
export declare function servedName(moduleMap: Record<string, () => unknown>, specifier: string): string | null;
export type RequireFunction = ((id: string) => unknown) & {
    resolve: ((id: string, options?: {
        paths?: string[];
    }) => string) & {
        paths?: (id: string) => string[] | null;
    };
    cache: Record<string, unknown>;
};
/**
 * Factory for createRequire — needs the module map from index.ts at runtime.
 * Called from createModuleMap() so it has access to the lazily-built map.
 */
export declare function makeCreateRequire(moduleMap: Record<string, () => unknown>): (filename: string | URL) => RequireFunction;
/**
 * Minimal Module class matching the shape code typically expects.
 */
export declare class Module {
    id: string;
    filename: string;
    exports: unknown;
    parent: Module | null;
    children: Module[];
    loaded: boolean;
    paths: string[];
    constructor(id?: string, parent?: Module | null);
    require(_id: string): unknown;
    static createRequire: (filename: string | URL) => RequireFunction;
    static _resolveFilename(request: string): string;
    static _cache: Record<string, unknown>;
}
/**
 * The `module` built-in over a module map, as Node's is its Module class
 * (module.exports = Module, and Module.Module is Module): its builtinModules
 * are the map's core names, and createRequire is `createRequire` (the
 * CommonJS loader's, which resolves files and packages too) or, for a bare
 * map, one that serves the map's built-ins alone.
 */
export declare function createModuleShim(moduleMap: Record<string, () => unknown>, createRequire?: (filename: string | URL) => RequireFunction): {
    new (id?: string, parent?: Module | null): {
        id: string;
        filename: string;
        exports: unknown;
        parent: Module | null;
        children: Module[];
        loaded: boolean;
        paths: string[];
        require(_id: string): unknown;
    };
    createRequire: (filename: string | URL) => RequireFunction;
    _cache: Record<string, unknown>;
    builtinModules: string[];
    isBuiltin: (specifier: string) => boolean;
    Module: /*elided*/ any;
    _resolveFilename(request: string): string;
};
//# sourceMappingURL=module.d.ts.map