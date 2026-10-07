import { type NodeContext } from './index.js';
import { type RequireFunction } from './module.js';
/** Node's error for a module `require` cannot find: its message and its code. */
export declare function moduleNotFound(name: string): Error;
/** Strip a shebang line (`#!/usr/bin/env node`), leaving a blank line so line numbers hold. */
export declare function stripShebang(src: string): string;
/**
 * `source` as the module wrapper's function text: a CommonJS body as written
 * but for its import() calls, or an ES module lowered (ESM when `esm`).
 *
 * The loader's values reach the body under names drawn, with the emitter's
 * own, from one generatedNames over the source, so none is a name the
 * source holds: import.meta, import() (which loads through this loader, from
 * the workspace, in either body), and the require and module the lowering's
 * lines use. A lowered module is one block, so its own bindings (`const
 * __dirname`, `import process from`, `const require = createRequire(...)`)
 * shadow the wrapper's parameters as module scope does.
 *
 * Throws a SyntaxError for an ES module that does not parse.
 */
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