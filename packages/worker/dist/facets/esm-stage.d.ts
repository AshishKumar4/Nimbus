/**
 * esm-stage.ts — a launch's ES modules as its process's registry evaluates
 * them (core runtime/native-esm.ts): each static specifier resolved as Node's
 * ESM loader resolves it, and the module staged to name what that resolution
 * loads in the map: another staged ES module, the facade of a CommonJS module
 * or a builtin, a JSON module, or a module the map does not have for a
 * specifier Node's loader refuses, so the whole graph fails to link before
 * any of it runs, as Node's does, and the process names the refusal Node
 * would (EsmStage.missing).
 *
 * The facades, JSON modules and meta instances join the map beside the
 * staged modules, and the process reads the launch's table of them
 * (EsmModuleRow) by each meta instance's id.
 */
import type { ImportSites } from '@nimbus-sh/core/runtime/dynamic-import-rewrite.js';
import { type StagedEsModule } from '@nimbus-sh/core/runtime/native-esm.js';
import { type BridgeRequireFs } from '@nimbus-sh/core/runtime/require-resolution.js';
/**
 * One row of a launch's ES module table, by id (a meta instance's query):
 * a staged ES module (the cell at a VFS key) with the ids of the rows its
 * static imports load (-1 for a refused one), the facade of the CommonJS
 * cell at a key, the facade of a builtin or a package the process provides,
 * or the JSON module of the file at a key. Each names its map module.
 */
export type EsmModuleRow = readonly [kind: 'module', key: string, name: string, targets: readonly number[], bunScope?: 1] | readonly [kind: 'commonjs', key: string, name: string] | readonly [kind: 'builtin', builtin: string, name: string] | readonly [kind: 'json', key: string, name: string];
/** A specifier Node's loader refuses: the error its import fails with. */
export interface EsmMissing {
    readonly name: string;
    readonly code: string;
    readonly message: string;
}
/** What a launch stages for its ES modules. */
export interface EsmStage {
    /** Each ES module cell's staged module, by its VFS key. */
    readonly modules: Map<string, StagedEsModule>;
    /** The map's other members the modules link to, as ES module text: the meta and host modules, facades, JSON modules. */
    readonly members: Record<string, string>;
    /** The process's ES module table, by id. */
    readonly table: EsmModuleRow[];
    /** What each refused specifier fails with, by the number of the missing module it names (ESM_MISSING_DIR). */
    readonly missing: EsmMissing[];
}
/** Where a refused specifier points, by its number: a name no map member has, so the graph fails to link. */
export declare const ESM_MISSING_DIR = "nimbus/missing/";
/**
 * The code a refusal carries for a module Node's loader would load but the
 * launch did not stage (its closure was cut at the map's bound): the
 * process evaluates the importer's graph with the interpreter instead,
 * which loads the module as a file outside the map.
 */
export declare const ESM_NOT_STAGED = "ERR_NIMBUS_NOT_STAGED";
/** What staging reads of the launch's filesystem. */
export interface EsmStageFs {
    readonly files: BridgeRequireFs;
    realpath(path: string): Promise<string>;
}
/**
 * Stage `cells`, the launch's ES modules (their code and import sites, by VFS
 * key), resolving under the program's `conditions`. `isCode(key)` is whether
 * the launch carries the cell at a key as code.
 */
export declare function stageEsModules(fs: EsmStageFs, cells: ReadonlyMap<string, {
    readonly code: string;
    readonly sites: ImportSites;
}>, { conditions, isCode, gate }: {
    conditions: readonly string[];
    isCode(key: string): boolean;
    /** Whether the registry needs each module gated: workerd (native-esm.ts). */
    gate: boolean;
}): Promise<EsmStage>;
//# sourceMappingURL=esm-stage.d.ts.map