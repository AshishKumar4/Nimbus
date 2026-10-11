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
 * A build is of one upstream version and loads only under its owner at that
 * version, so a binding may be staged at several (`<name>@<version>`, a
 * build's key): a launch carries the builds of the versions the program
 * installed, and node-shims answers a require with the one its owner's
 * package.json names.
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
    /** `<name>@<version>`: the build, as specs.mjs keys it and a launch names it. */
    readonly key: string;
    /** The build's module-map name in a node facet. */
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
/** The staged build `key` (`<name>@<version>`); a key no build produced is a programming error. */
export declare function stagedBinding(key: string): StagedBinding;
/**
 * Keys of the staged builds a closure requires, in table order: a module
 * that names a binding's package, at the version of the owner package the
 * module is in (its package.json, which the walk stages beside it). A
 * version with no staged build is none: node-shims names it when it is
 * required.
 */
export declare function stagedBindingsRequiredBy(cells: Iterable<readonly [string, unknown]>): string[];
/** Most filesystem questions stagedBindingsDeclaredBy asks: package.json reads and node_modules probes. */
export declare const DECLARED_BINDING_PROBES = 1024;
/** What the declared-dependency walk asks, by absolute path: a file's text, whether a path exists, and its real location; null or false where there is none. */
export interface DeclaredBindingFs {
    readText(path: string): Promise<string | null>;
    exists(path: string): Promise<boolean>;
    realpath(path: string): Promise<string | null>;
}
/**
 * Keys of the staged builds a launched bin's own dependency tree installs,
 * in table order: a binding's owner at a version it is built for, reached through
 * the declared dependencies (dependencies, optionalDependencies,
 * peerDependencies) of the bin's package and of every package those resolve
 * to. Each name resolves as Node's resolver finds it, from the package that
 * declares it: its own node_modules, then each ancestor's, through links to
 * where the package really is. So the version matched is the one installed
 * where the requiring code would load it (__loadStagedBinding checks the
 * same), and a nested copy at another version is not taken for a hoisted
 * one.
 *
 * A closure names a binding only when its owner is in it, and a program can
 * reach the owner by a specifier no walk follows: Nuxt 4 loads its builder
 * with `if (builder === "@nuxt/vite-builder") return await import(builder)`,
 * and Vite then loads rolldown. The binding is compiled with the launch or not
 * at all, so a launch decided by its closure alone failed `nuxt dev` on its
 * first run ("Cannot find native binding"). Registering a binding creates
 * nothing (stagedBindingsFacetImport); only a require of it does.
 *
 * Asks at most `limit` questions (a package.json read, or whether a
 * directory has node_modules), and stops once every binding is found; a
 * declared name that is a binding's owner is checked when it is declared,
 * not when the breadth-first walk reaches it. A bin outside node_modules (a
 * program of the user's own) declares nothing here.
 */
export declare function stagedBindingsDeclaredBy(fs: DeclaredBindingFs, scriptPath: string | undefined, limit?: number, 
/** Filled in with the questions asked, for a launch's diagnostics. */
stats?: {
    probes: number;
}): Promise<string[]>;
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
 * The main-module block that registers the builds `keys`. It imports the
 * shared loader and trampoline and each build, and hands node-shims one
 * factory per build, registered under every package name its binding is
 * required by, by version; nothing is instantiated until the program
 * actually requires it.
 */
export declare function stagedBindingsFacetImport(keys: readonly string[] | undefined): string;
//# sourceMappingURL=staged-bindings.d.ts.map