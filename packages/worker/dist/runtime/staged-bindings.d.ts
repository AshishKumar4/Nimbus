/**
 * staged-bindings.ts — the staged threadless napi-rs bindings.
 *
 * rolldown, satteri and the Astro compiler ship their N-API bindings as
 * platform `.node` shards plus one wasm build for wasm32-wasip1-threads; a
 * Worker isolate can run neither. scripts/napi-wasm/build.mjs builds each for
 * plain wasm32-wasip1 (emnapi's non-threaded N-API, Nimbus's WASI filesystem
 * codec, and for rolldown a tokio current-thread runtime the loader pumps from
 * the event loop), and scripts/bundle-napi-wasm.mjs stages them under
 * public/_assets/napi-wasm/ with every file's SHA-256 pinned.
 *
 * A node process whose closure requires any of them carries the shared loader
 * (ESM), the shared wasi trampoline, and each binding it requires: by value in
 * a one-shot, by kernel-owned VFS path in a resident process, where a
 * multi-megabyte member held inline would stay in the coordinator's heap for
 * the process's life. The generated main module registers each binding on
 * `globalThis.__nimbusStagedBindings` under every package name its owner
 * requires it by, and node-shims answers that `require` from there (see
 * __loadStagedBinding in node-shims.ts).
 *
 * Every byte is verified against its pinned digest on both cache tiers
 * before it is compiled or evaluated, as for the opencode artifact.
 */
import { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, type NapiWasmAsset, type StagedBindingArtifact } from '../napi-wasm-artifacts.generated.js';
import { type StagedSourceEnv } from './staged-source.js';
export { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, type NapiWasmAsset };
/** Module-map names of the members every launch with a staged binding carries. */
export declare const STAGED_BINDING_LOADER_MODULE = "nimbus-napi-wasm-loader.js";
export declare const STAGED_BINDING_TRAMPOLINE_MODULE = "nimbus-napi-wasm-trampoline.wasm";
export interface StagedBinding extends StagedBindingArtifact {
    /** The binding's module-map name in a node facet. */
    readonly moduleName: string;
    /**
     * Where a resident process's boot spec names the binding. Kernel-owned and
     * versioned: written once per session, read by path when a facet loads. A
     * copy at full size (`wasm.bytes`) is a complete one: the write only grows
     * the file from offset zero.
     */
    readonly vfsPath: string;
    /**
     * Whether a program's closure requires the binding: its owner's generated
     * napi-rs loader names each wasm package in a string literal (its WASI
     * candidate), so a closure that holds the owner holds that literal.
     */
    readonly specifier: RegExp;
}
export declare const STAGED_BINDINGS: readonly StagedBinding[];
/** The staged binding named `name`; a name no build produced is a programming error. */
export declare function stagedBinding(name: string): StagedBinding;
/** Names of the staged bindings a closure requires, in table order. */
export declare function stagedBindingsRequiredBy(cells: Iterable<readonly [string, unknown]>): string[];
/**
 * The colo-cache key of one staged file: its path and its own digest. A
 * binding rebuilt at the same version keeps its path, and a key shared with
 * the old bytes (the loader's build id was) found them in a warm colo's cache
 * and refused them as poisoned.
 */
export declare function stagedBindingCacheKey(asset: NapiWasmAsset): string;
/** Fetch one staged file, verified against its pinned digest. */
export declare function fetchStagedBindingAsset(env: StagedSourceEnv, asset: NapiWasmAsset): Promise<ArrayBuffer>;
/**
 * The main-module block that registers `names`. It imports the shared loader
 * and trampoline and each binding, and hands node-shims one factory per
 * binding, registered under every package name it is required by; nothing is
 * instantiated until the program actually requires it.
 */
export declare function stagedBindingsFacetImport(names: readonly string[] | undefined): string;
//# sourceMappingURL=staged-bindings.d.ts.map