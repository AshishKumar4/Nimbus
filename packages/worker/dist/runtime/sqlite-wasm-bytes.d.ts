/**
 * sqlite-wasm-bytes.ts — supervisor-side fetcher for the sql.js wasm
 * binary backing the node:sqlite shim. The bytes live in the
 * static-assets layer (env.ASSETS); this module hands them to the caller
 * as an ArrayBuffer when a facet imports node:sqlite.
 *
 * The caller (FacetManager) feeds these bytes into the Worker Loader
 * module map as a `wasm` module so workerd compiles them into a
 * WebAssembly.Module ahead of facet dispatch. The shim then drives sql.js
 * via its `instantiateWasm` hook with that pre-compiled module —
 * request-time WebAssembly.compile(bytes) is blocked inside facets.
 *
 * Mirrors esbuild-wasm-bytes.ts: NO module-scope cache (no supervisor
 * residency), L2 colo cache via caches.default keyed by the version-pinned
 * asset URL, ASSETS as the source of truth, and a sha-256 integrity check on
 * both tiers so a stale or tampered asset never gets compiled.
 */
/**
 * Path inside env.ASSETS where the sql.js wasm binary lives. Versioned so
 * a future sql.js bump produces a different asset name and forces a fresh
 * fetch. Staged at public/_assets/sqljs-<version>.wasm by
 * scripts/bundle-sqlite-wasm.mjs at predeploy time.
 */
export declare const SQLITE_WASM_ASSET_PATH = "/_assets/sqljs-1.14.1.wasm";
/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface SqliteWasmFetchEnv {
    ASSETS: {
        fetch(req: Request): Promise<Response>;
    };
}
/**
 * Synthetic L2 cache key for the sql.js wasm asset. Version-pinned so each
 * sql.js upgrade lands a fresh entry and old entries evict on TTL.
 */
export declare const SQLITE_WASM_L2_KEY = "https://nimbus-cache.invalid/_assets/sqljs-1.14.1.wasm";
/**
 * Fetch the sql.js wasm bytes from the static-assets layer.
 *
 * L2 (caches.default) fast path; ASSETS on miss with write-back. Cache
 * failures are silent — ASSETS is always the source of truth. A non-200
 * from ASSETS, or a digest mismatch on either tier, throws.
 */
export declare function fetchSqliteWasmBytes(env: SqliteWasmFetchEnv): Promise<ArrayBuffer>;
//# sourceMappingURL=sqlite-wasm-bytes.d.ts.map