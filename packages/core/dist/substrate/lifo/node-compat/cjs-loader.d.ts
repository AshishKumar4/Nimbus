import { type NodeContext } from './index.js';
import { type RequireFunction } from './module.js';
export type PackageType = 'module' | 'commonjs' | null;
/** Node's error for a module `require` cannot find: its message and its code. */
export declare function moduleNotFound(name: string): Error;
/** Strip a shebang line (`#!/usr/bin/env node`), leaving a blank line so line numbers hold. */
export declare function stripShebang(src: string): string;
/**
 * Whether `source` is an ES module by its syntax, as Node's detection reads
 * it: a top-level import or export declaration (not `import(`, not one
 * inside a string), or an `import.meta`.
 */
export declare function isEsmSource(source: string): boolean;
/** A package.json's "type", when it declares one. */
export declare function declaredPackageType(packageJson: string): PackageType;
/** Whether a module runs as an ES module: .mjs always, .cjs never, a .js by its package's type, else by its syntax. */
export declare function treatAsEsm(source: string, filename: string, declared: () => PackageType): boolean;
/** `source`, ESM lowered when `esm`, as the module wrapper's function text. Throws a SyntaxError for an ES module that does not parse. */
export declare function moduleWrapper(source: string, esm: boolean, async?: boolean): string;
/** What one module's wrapper receives as console and process. */
export interface ModuleScope {
    readonly console: unknown;
    readonly process: unknown;
}
export interface CjsLoader {
    /** The built-ins `require` serves; `module`'s createRequire is this loader's. */
    readonly moduleMap: Record<string, () => unknown>;
    /** `require` as a module in `dir` has it. */
    requireFrom(dir: string): RequireFunction;
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
export declare function createCjsLoader(context: NodeContext, scope: (filename: string) => ModuleScope): CjsLoader;
//# sourceMappingURL=cjs-loader.d.ts.map