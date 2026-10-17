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
import { type ModuleScope } from '@nimbus-sh/core/runtime/module-format.js';
/**
 * One row of a launch's ES module table, by id (a meta instance's query):
 * a staged ES module (the cell at a VFS key) with the ids of the rows its
 * static imports load (for a refused one, -2 less the number of its refusal
 * in EsmStage.missing: every negative is no row), the facade of the CommonJS
 * cell at a key, the facade of a builtin or a package the process provides,
 * or the JSON module of the file at a key. A row's map module is its name
 * (esmRowName): its cell's module for a staged module, else its facade by id.
 */
export type EsmModuleRow = readonly [kind: 'module', key: string, targets: readonly number[], flags?: number, packageJson?: string] | readonly [kind: 'commonjs', key: string] | readonly [kind: 'builtin', builtin: string] | readonly [kind: 'json', key: string];
/** The map module of row `id` (node-shims' __nimbusEsmName reads it so). */
export declare function esmRowName(row: EsmModuleRow, id: number): string;
/**
 * A row's export names, as the late link reads them (ESM_BINDINGS_MODULE,
 * core runtime/esm-late-link.ts): a facade's or a JSON module's, which
 * staging already knows; null for a staged module, whose names the late
 * link reads from its source if it ever needs them.
 */
export type EsmRowBindings = readonly string[] | null;
/** A specifier Node's loader refuses: the error its import fails with. */
export interface EsmMissing {
    readonly name: string;
    readonly code: string;
    readonly message: string;
    /** The URL Node's resolution error carries (a module or directory not found). */
    readonly url?: string;
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
    /** Each row's export names, by id (EsmRowBindings). */
    readonly bindings: EsmRowBindings[];
    /** How long staging took, in milliseconds: the launch's debug line. */
    readonly ms: number;
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
    /** A directory's entries by name with their types (readdir's), or null: one listing answers for every name in it. */
    entries?(dir: string): Promise<ReadonlyMap<string, string> | null>;
    /** The text the launch already holds for a VFS key (its map's cell), or undefined: read before the filesystem. */
    held?(key: string): string | undefined;
}
/**
 * Stage `cells`, the launch's ES modules (their code and import sites, by VFS
 * key), resolving under the program's `conditions`. `isCode(key)` is whether
 * the launch carries the cell at a key as code.
 */
export declare function stageEsModules(fs: EsmStageFs, cells: ReadonlyMap<string, {
    readonly code: string;
    readonly sites: ImportSites;
}>, { conditions, cwd, isCode, gate, emitted, scope, stripsTypes, typeScript }: {
    /** Node strips TypeScript's types (node-cli.ts typeScriptStripOptions): it refuses TypeScript under node_modules. */
    stripsTypes?: boolean;
    /** A TypeScript file has a format (EsmResolverOptions.stripTypes): not under `--no-experimental-strip-types`. */
    typeScript?: boolean;
    conditions: readonly string[];
    /** Whose resolution the modules link by: Node's ESM_RESOLVE, or Bun's, which falls back to require()'s probing. */
    scope?: ModuleScope;
    /** The process's working directory (EsmResolverOptions.cwd). */
    cwd: string;
    isCode(key: string): boolean;
    /** Whether the registry needs each module gated: workerd (native-esm.ts). */
    gate: boolean;
    /** A member's text as it becomes known, before the next filesystem question. */
    emitted?(path: string, text: string): void;
}): Promise<EsmStage>;
//# sourceMappingURL=esm-stage.d.ts.map