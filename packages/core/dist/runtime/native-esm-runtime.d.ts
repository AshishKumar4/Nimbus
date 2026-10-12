/**
 * native-esm-runtime.ts — what a program's loader does with a staged ES
 * module (native-esm.ts) while the program runs: place a frame in its
 * source, and shape what require() of it returns. One implementation for
 * both loaders: lifo's imports it, and the worker's guest embeds it compiled
 * (scripts/compile-facet-bodies.mjs; commonjs-cell.ts frames, node-shims'
 * require(esm)).
 */
import type { ColumnMap } from './native-esm.js';
/**
 * A 1-based column of a staged module's line as its source has it, from
 * where the engine places it in the staged text (a first line's past the
 * head): `edits` are the line's ColumnMap entries, in order.
 */
export declare function sourceColumn(edits: ColumnMap | undefined, column: number): number;
/** An evaluated ES module as require() keeps it: its namespace, and the facade it is required as. */
export interface RequiredEsModule {
    readonly namespace: object;
    required?: object;
}
/**
 * Node's require(esm) result (lib/internal/modules/cjs/loader.js
 * loadESMFromCJS): the module's "module.exports" export, else its namespace
 * when it has no default export or exports __esModule itself, else one
 * facade of it per module.
 */
export declare function requiredEsModule(record: RequiredEsModule): unknown;
//# sourceMappingURL=native-esm-runtime.d.ts.map