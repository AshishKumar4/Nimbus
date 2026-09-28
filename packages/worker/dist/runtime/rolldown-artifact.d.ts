/**
 * rolldown-artifact.ts — the staged single-threaded rolldown binding.
 *
 * rolldown's N-API binding ships as platform `.node` shards plus one wasm
 * build for wasm32-wasip1-threads; a Worker isolate can run neither.
 * scripts/rolldown/build-binding.mjs builds the same binding for plain
 * wasm32-wasip1 (tokio on a current-thread runtime the loader pumps from the
 * event loop, emnapi's non-threaded N-API, Nimbus's WASI filesystem codec),
 * and scripts/bundle-rolldown.mjs stages it under
 * public/_assets/rolldown/<version>/ with every file's SHA-256 pinned.
 *
 * A node process whose closure requires the binding carries three module-map
 * members: the loader (ESM), the wasi trampoline, and the binding itself —
 * by value in a one-shot, by kernel-owned VFS path in a resident process,
 * where a 13 MB member held inline would stay in the coordinator's heap for
 * the process's life. The generated main module registers them on
 * `globalThis.__nimbusStagedBindings`, and node-shims answers the binding's
 * `require` from there (see __loadStagedBinding in node-shims.ts).
 *
 * Every byte is verified against its pinned digest on both cache tiers
 * before it is compiled or evaluated, as for the opencode artifact.
 */
import { type StagedSourceEnv } from './staged-source.js';
/** The package name rolldown's JavaScript requires its wasm binding by. */
export declare const ROLLDOWN_BINDING_PACKAGE = "@rolldown/binding-wasm32-wasi";
/** Module-map names the three members ride under in a node facet. */
export declare const ROLLDOWN_BINDING_MODULE = "nimbus-rolldown-binding.wasm";
export declare const ROLLDOWN_TRAMPOLINE_MODULE = "nimbus-rolldown-trampoline.wasm";
export declare const ROLLDOWN_LOADER_MODULE = "nimbus-rolldown-loader.js";
/**
 * Where a resident process's boot spec names the binding. Kernel-owned and
 * versioned: written once per session, read by path when a facet loads. A
 * copy at full size (ROLLDOWN_BINDING_BYTES) is a complete one: the write
 * only grows the file from offset zero.
 */
export declare const ROLLDOWN_BINDING_VFS_PATH: string;
/**
 * Whether a program's closure requires the binding: rolldown's generated
 * loader names the wasm package in a string literal (its WASI candidate), so
 * a closure that holds rolldown holds that literal.
 */
export declare const ROLLDOWN_BINDING_SPECIFIER_RE: RegExp;
/** One staged file: where ASSETS serves it and the digest it must match. */
export interface RolldownAsset {
    path: string;
    sha256: string;
}
export declare const ROLLDOWN_BINDING_ASSET: RolldownAsset;
export declare const ROLLDOWN_TRAMPOLINE_ASSET: RolldownAsset;
export declare const ROLLDOWN_LOADER_ASSET: RolldownAsset;
/** Fetch one staged file, verified against its pinned digest. */
export declare function fetchRolldownAsset(env: StagedSourceEnv, asset: RolldownAsset): Promise<ArrayBuffer>;
/**
 * The main-module block that registers the staged binding. It imports the
 * three members and hands node-shims a factory; nothing is instantiated until
 * the program actually requires the binding.
 */
export declare const ROLLDOWN_FACET_IMPORT: string;
//# sourceMappingURL=rolldown-artifact.d.ts.map