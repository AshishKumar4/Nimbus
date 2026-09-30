/**
 * esbuild-wasm-bytes.ts — supervisor-side fetcher for the staged artifacts
 * the esbuild facet is built from: the JS adapter that drives the wasm, and
 * the runner of the `esbuild` command. Both live in the static-assets layer
 * (env.ASSETS); this module hands them to the caller when needed.
 *
 * The wasm itself is not staged. The host Worker bundles it (core's
 * EsbuildService imports `esbuild-wasm/esbuild.wasm`), workerd compiles it
 * at startup, and facets are handed that compiled module
 * (runtime/host-wasm.ts). It was staged here as 12 MiB of bytes, fetched,
 * verified and compiled again by every facet that used it.
 *
 * The JS adapter is staged for the reason the wasm once was, at a smaller
 * scale: the supervisor already imports esbuild-wasm's browser build as a
 * module for its own transforms, so carrying the same 117 KiB again as a
 * string literal for facets doubled it in the Worker bundle. The CLI runner
 * (32 KiB of Go glue and fs shim) only ever runs in the facet, so it is
 * staged too; its name carries a prefix of its digest, because unlike the
 * adapter it changes without an esbuild upgrade.
 *
 * Cache strategy
 * ──────────────
 * - NO module-scope cache: the texts are small, and a facet's loader cache
 *   holds the only long-lived copy.
 * - L2 colo cache via `caches.default`: the paths are version-pinned
 *   (`/_assets/esbuild-<ESBUILD_VERSION>.js`, the runner by build id), so an
 *   `immutable` cache entry is correct.
 *
 * Failure model
 * ─────────────
 * Cache lookup failure (any throw) → fall through to ASSETS.
 * ASSETS fetch returning non-200 → throw (deploy bug, surface loudly).
 * Digest mismatch on either tier → throw (the texts are evaluated as facet
 * code, so they are verified against the digest the generator recorded
 * before returning).
 */
/**
 * The minimal env shape this module needs. Defined narrowly so the
 * caller can pass any env with an ASSETS Fetcher binding without
 * dragging in the full Workers env type.
 */
export interface EsbuildWasmFetchEnv {
    ASSETS: {
        fetch(req: Request): Promise<Response>;
    };
}
/**
 * Synthetic L2 cache keys for the staged esbuild artifacts. Versioned via
 * the asset paths so each esbuild upgrade lands fresh entries and old ones
 * naturally evict on TTL.
 */
export declare const ESBUILD_JS_L2_KEY: string;
/** The CLI runner's key names its build id, so each rebuild lands a fresh entry. */
export declare const ESBUILD_CLI_L2_KEY: string;
/**
 * Fetch the esbuild-wasm JS adapter: the function body that, wrapped in
 * `new Function(...)()`, returns the esbuild namespace. Facet sources
 * splice it in verbatim, so it is verified before it is evaluated.
 */
export declare function fetchEsbuildJsFnBody(env: EsbuildWasmFetchEnv): Promise<string>;
/**
 * Fetch the `esbuild` command's runner: Go's wasm_exec.js and the typed fs
 * shim, a script that installs `globalThis.__esbuildCliRun` when the esbuild
 * facet evaluates it. Verified like the adapter it sits beside.
 */
export declare function fetchEsbuildCliRunner(env: EsbuildWasmFetchEnv): Promise<string>;
//# sourceMappingURL=esbuild-wasm-bytes.d.ts.map