/**
 * modules.ts — an ES module the interpreter evaluates (one a program produced
 * after its launch began, or a staged one the registry could not evaluate
 * with Node's semantics: node-shims' adoption), as Node's CommonJS wrapper
 * function, linked as runtime/esm-interop.ts says. Its imports are calls of
 * the require it is given, told each is an import (ESM_LOAD_HELPER), which
 * the loader resolves, checks and links as Node's ESM loader does, giving
 * each module's namespace; its exports are the getters of module.exports.
 * compile.ts makes the plan (Compiler.modulePlan); this runs it, with the
 * helpers the launch compiled from esm-interop.ts's text (InterpreterHost).
 */
import type { Code } from './code.js';
import type { HostOperators, NativeFunction } from './host-ops.js';
import { type Env } from './runtime.js';
import { type StackInfo } from './stack.js';
/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;
/**
 * An ES module cell's ExecuteModule, once it is linked: its body, answering
 * undefined, or (top-level await) the promise of its completion.
 */
export type ModuleExecution = () => unknown;
/**
 * An ES module cell's InitializeEnvironment (runtime/esm-graph.ts): its
 * frame made, its function declarations hoisted, its exports published, its
 * imports bound (each request through the require it is given) and its
 * `export *`s copied, none of its body run; answers its ExecuteModule.
 */
export type ModuleLink = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => ModuleExecution;
/** The link of `cell`, an ES module's cell; null for any other. */
export declare function moduleLink(cell: ModuleCell): ModuleLink | null;
/** esm-interop.ts's helpers, compiled from their text (ESM_MODULE_HELPERS). */
export interface ModuleHelpers {
    readonly exports: NativeFunction;
    readonly star: NativeFunction;
    readonly conflicts: NativeFunction;
    readonly load: NativeFunction;
}
/** An export's getter: `read` of the evaluation's frame. */
export interface ModuleExport {
    readonly name: string;
    readonly read: (env: Env) => unknown;
}
/** A module, compiled. */
export interface ModulePlan {
    readonly stack: StackInfo;
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
    /**
     * Each requested module, required in order with its `type` attribute
     * (which the loader checks): the slot its namespace goes to, -1 for none.
     */
    readonly requests: readonly {
        readonly source: string;
        readonly type: string | null;
        readonly module: number;
    }[];
    /** Slots of the modules whose names `export *` copies. */
    readonly stars: readonly number[];
    /** Instantiation: the module scope's function declarations made, its lexical bindings in their TDZ. */
    readonly instantiate: ((env: Env) => Env) | null;
    /** The module's statements, as an async function body (top-level await). */
    readonly body: Code;
}
/**
 * The wrapper function that runs `plan`: its link, then its execution, as
 * one call (a module whose body suspends rejecting for a failure linking
 * it, rather than throwing); its link alone is moduleLink's.
 */
export declare function moduleCell(plan: ModulePlan, ops: HostOperators, helpers: ModuleHelpers): ModuleCell;
//# sourceMappingURL=modules.d.ts.map