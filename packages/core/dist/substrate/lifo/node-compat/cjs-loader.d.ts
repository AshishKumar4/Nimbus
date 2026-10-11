/**
 * The lifo node's CommonJS loader: how `require` resolves a name, runs the
 * module it names and caches it, for the node command's programs and the
 * lifo command runtime's packages alike.
 *
 * A name is a built-in (`fs`, `node:fs`), a `#` import of the nearest
 * package.json's "imports", a relative or absolute file (Node's exact, `.js`,
 * `.json`, `.node` and main/index probing), or a package: the nearest
 * node_modules up from the requiring module's directory, then the global
 * /usr/lib/node_modules and the legacy /usr/share/pkg/node_modules, its
 * entry from "exports" (by the shared resolver, _shared/exports-resolver.ts,
 * under require's conditions), else "main", then
 * index.js; a `#` name likewise from "imports". A module runs once, cached
 * by its path before it runs (so a cycle sees its partial exports); an ES
 * module (.mjs, a .js under "type": "module", or ESM syntax) goes to the
 * realm's native ES module loader, not the CommonJS wrapper.
 */
import { type NodeContext } from './index.js';
import { type RequireFunction } from './module.js';
import { type RequireResolverOptions } from '../../../runtime/require-resolution.js';
/** Node's error for a module `require` cannot find: its message and its code. */
export declare function moduleNotFound(name: string): Error;
/** Strip a shebang line (`#!/usr/bin/env node`), leaving a blank line so line numbers hold. */
export declare function stripShebang(src: string): string;
/**
 * A CommonJS body as written, but for import() calls routed to the native
 * loader. The extra parameter cannot collide with a source's own name,
 * including a Unicode-escaped spelling.
 */
export declare function moduleWrapper(source: string, parentUrl: string): string;
/** What one module's wrapper receives as console and process. */
export interface ModuleScope {
    readonly console: unknown;
    readonly process: unknown;
}
/** The native loader installed for this CommonJS loader's module graph. */
export interface NativeModuleLoader {
    importModule(specifier: string, parentUrl: string, options?: unknown): Promise<unknown>;
    requireModule(filename: string, parentFilename?: string): unknown;
}
export interface CjsLoader {
    /** The built-ins `require` serves; `module`'s createRequire is this loader's. */
    readonly moduleMap: Record<string, () => unknown>;
    /** `require` as a module in `dir` has it. */
    requireFrom(dir: string): RequireFunction;
    /** A resolver or facade uses the same cache and builtins as require(). */
    resolveFilename(specifier: string, dir: string): string | null;
    /** Installed before a node program runs; lifo commands install it in their own URL scope. */
    setNativeLoader(loader: NativeModuleLoader): void;
    /**
     * The module at `filename`, run once and cached. `preread` is its source,
     * and whether it is an ES module, when the caller has read it already (a
     * lifo entry, read through the async view a mount may require).
     */
    load(filename: string, preread?: {
        readonly source: string;
        readonly esm: boolean;
    }): unknown;
    /** The arguments a module's wrapper is called with, `require` its own. */
    wrapperArguments(filename: string, module: {
        exports: unknown;
    }, scope: ModuleScope): unknown[];
}
/**
 * A loader over `context`'s filesystem. `scope` gives each module its
 * console and process (each module has its own, as the node command's
 * modules always have had).
 */
export declare function createCjsLoader(context: NodeContext, scope: (filename: string) => ModuleScope, options?: RequireResolverOptions): CjsLoader;
//# sourceMappingURL=cjs-loader.d.ts.map