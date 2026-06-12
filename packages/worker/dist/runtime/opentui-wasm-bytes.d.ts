/**
 * opentui-wasm-bytes.ts — supervisor-side fetcher for the staged OpenTUI
 * wasm32-wasi reactor artifact backing the in-facet FFI render backend.
 *
 * The bytes live in the static-assets layer (env.ASSETS) at the path the
 * generated constants pin (OPENTUI_WASM_ENTRY). The caller (FacetManager)
 * feeds them into the Worker Loader module map as a `wasm` module so workerd
 * compiles them into a WebAssembly.Module ahead of facet dispatch; the opencode
 * facet runner instantiates that pre-compiled module via OpenTUIWasmBackend —
 * request-time WebAssembly.compile(bytes) is blocked inside facets.
 *
 * Mirrors sqlite-wasm-bytes.ts: NO module-scope cache (no supervisor
 * residency), an L2 colo cache via caches.default keyed by the build-id-pinned
 * asset URL, ASSETS as the source of truth. The fetched bytes are integrity-
 * checked against OPENTUI_WASM_SHA256 so a stale/corrupt asset never reaches
 * the backend.
 */
/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface OpenTUIWasmFetchEnv {
    ASSETS: {
        fetch(req: Request): Promise<Response>;
    };
}
/**
 * Fetch the staged OpenTUI wasm bytes and verify their SHA-256 against the
 * generated digest.
 *
 * L2 (caches.default) fast path; ASSETS on miss with write-back. Cache
 * failures are silent — ASSETS is always the source of truth. A non-200 from
 * ASSETS, or a digest mismatch, throws.
 */
export declare function fetchOpenTUIWasmBytes(env: OpenTUIWasmFetchEnv): Promise<ArrayBuffer>;
//# sourceMappingURL=opentui-wasm-bytes.d.ts.map