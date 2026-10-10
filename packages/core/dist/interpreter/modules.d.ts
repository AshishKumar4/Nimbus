/**
 * modules.ts — an ES module as a launch's map runs one: Node's CommonJS
 * wrapper function, linked as runtime/esm-interop.ts says, the way the next
 * launch's cell (async-module-lowering.ts) links the same text. Its imports
 * are requires and its exports the getters of module.exports. compile.ts
 * makes the plan (Compiler.modulePlan); this runs it, with the interop
 * helpers the launch compiled from esm-interop.ts's text (InterpreterHost).
 */
import type { Code } from './code.js';
import type { HostOperators, NativeFunction } from './host-ops.js';
import { type Env } from './runtime.js';
/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;
/** esm-interop.ts's helpers, compiled from their text (ESM_MODULE_HELPERS). */
export interface ModuleHelpers {
    readonly exports: NativeFunction;
    readonly interop: NativeFunction;
    readonly namespace: NativeFunction;
    readonly star: NativeFunction;
}
/**
 * What an export's getter reads: its value from the evaluation's frame, or a
 * re-exported namespace (`export * as`), made into `slot` from the module in
 * `from` when first read.
 */
export type ModuleExport = {
    readonly kind: 'read';
    readonly name: string;
    readonly read: (env: Env) => unknown;
} | {
    readonly kind: 'namespace';
    readonly name: string;
    readonly slot: number;
    readonly from: number;
};
/** A module, compiled. */
export interface ModulePlan {
    /** The module scope's frame (runtime.ts frameTemplate). */
    readonly frame: Env;
    /** Slots of the wrapper's arguments. */
    readonly exportsSlot: number;
    readonly requireSlot: number;
    readonly moduleSlot: number;
    readonly filenameSlot: number;
    readonly dirnameSlot: number;
    /** The export getters, in the order they are installed. */
    readonly exports: readonly ModuleExport[];
    /** Each requested module, required in order: the slots it goes to, and those its interop goes to (a default import's). */
    readonly requests: readonly {
        readonly source: string;
        readonly module: readonly number[];
        readonly interop: readonly number[];
    }[];
    /** Each import's namespace, made into `slot` from the module in `from` once every request is required. */
    readonly namespaces: readonly {
        readonly slot: number;
        readonly from: number;
    }[];
    /** Slots of the modules whose names `export *` copies. */
    readonly stars: readonly number[];
    /** Instantiation: the module scope's function declarations made, its lexical bindings in their TDZ. */
    readonly instantiate: ((env: Env) => Env) | null;
    /** The module's statements, as an async function body (top-level await). */
    readonly body: Code;
}
/** The wrapper function that runs `plan`. */
export declare function moduleCell(plan: ModulePlan, ops: HostOperators, helpers: ModuleHelpers): ModuleCell;
//# sourceMappingURL=modules.d.ts.map