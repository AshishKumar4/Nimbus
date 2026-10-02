/**
 * modules.ts — an ES module as a launch's map runs one: Node's CommonJS
 * wrapper function, as esbuild lowers a module for the map. Its imports are
 * requires and its exports the getters of one object, module.exports.
 * compile.ts makes the plan (Compiler.modulePlan); this runs it.
 */
import type { Code } from './code.js';
import { type Env } from './runtime.js';
/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;
/** Where an exported name reads its value. */
export type ExportRead = 
/** A binding of the module, read live (in its TDZ until its declaration runs: a cycle can read it early). */
{
    readonly kind: 'binding';
    readonly read: (env: Env) => unknown;
}
/** `export { name } from 'm'`: m's export `name`; its `default` is m itself unless m is an ES module. */
 | {
    readonly kind: 'reexport';
    readonly slot: number;
    readonly name: string;
}
/** `export * as name from 'm'`: m's namespace object. */
 | {
    readonly kind: 'namespace';
    readonly slot: number;
};
/** An import declaration or a re-export's source, required in source order. */
export interface ModuleImport {
    readonly source: string;
    /** The slot the required module is kept in, for a re-export to read; null for an import declaration. */
    readonly slot: number | null;
    /** An import declaration's bindings: the module, or (a namespace import) its namespace object. */
    readonly bindings: readonly {
        readonly slot: number;
        readonly namespace: boolean;
    }[];
}
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
    readonly imports: readonly ModuleImport[];
    /** The exported names, in order; the first of a name wins. */
    readonly exports: readonly {
        readonly name: string;
        readonly read: ExportRead;
    }[];
    /** Slots of `export * from` modules, whose names join the exports after the imports are evaluated. */
    readonly stars: readonly number[];
    /** Instantiation: the module scope's function declarations made, its lexical bindings in their TDZ. */
    readonly instantiate: ((env: Env) => Env) | null;
    /** The module's statements, as an async function body (top-level await). */
    readonly body: Code;
}
/** The wrapper function that runs `plan`. */
export declare function moduleCell(plan: ModulePlan): ModuleCell;
//# sourceMappingURL=modules.d.ts.map