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
/** What one module's wrapper receives as console, process and global. */
export interface ModuleScope {
    readonly console: unknown;
    readonly process: unknown;
    /** Every module's `global`: a program's realm's globalThis, as Node's is. */
    readonly global: unknown;
}
/** The native loader installed for this CommonJS loader's module graph. */
export interface NativeModuleLoader {
    importModule(specifier: string, parentUrl: string, options?: unknown): Promise<unknown>;
    requireModule(filename: string, parentFilename?: string): unknown;
    /** module.syncBuiltinESMExports: each builtin's ES module namespace takes its exports' current values. */
    syncBuiltinESMExports(): void;
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
    }): unknown[];
}
/**
 * A loader over `context`'s filesystem. `scope` is the program's console and
 * process, every module's, as Node has one process; require('process') and
 * require('console') are them.
 */
export declare function createCjsLoader(context: NodeContext, scope: ModuleScope, options?: RequireResolverOptions): CjsLoader;
//# sourceMappingURL=cjs-loader.d.ts.map