/**
 * Node.js `module` shim for Lifo.
 *
 * Provides the commonly used APIs from the `node:module` built-in:
 * - Module class with id, filename, exports, paths, require, etc.
 * - createRequire() — returns a require-like function backed by the module map
 * - builtinModules — list of shimmed built-in module names
 * - isBuiltin() — check if a module name is a built-in
 */
/** All built-in module names available in the Lifo node-compat layer */
export declare const builtinModules: string[];
/**
 * Check whether a specifier refers to a Node.js built-in module.
 * Handles both bare names ("fs") and the "node:" prefix ("node:fs").
 */
export declare function isBuiltin(specifier: string): boolean;
export type RequireFunction = ((id: string) => unknown) & {
    resolve: (id: string) => string;
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
    static builtinModules: string[];
    static isBuiltin: typeof isBuiltin;
    static createRequire: (filename: string | URL) => RequireFunction;
    static _resolveFilename(request: string): string;
    static _cache: Record<string, unknown>;
}
/**
 * The `module` built-in over a module map: its builtinModules are the map's
 * names, and createRequire is `createRequire` (the CommonJS loader's, which
 * resolves files and packages too) or, for a bare map, one that serves the
 * map's built-ins alone.
 */
export declare function createModuleShim(moduleMap: Record<string, () => unknown>, createRequire?: (filename: string | URL) => RequireFunction): {
    Module: typeof Module;
    builtinModules: string[];
    isBuiltin: (specifier: string) => boolean;
    createRequire: (filename: string | URL) => RequireFunction;
    default: typeof Module;
};
//# sourceMappingURL=module.d.ts.map