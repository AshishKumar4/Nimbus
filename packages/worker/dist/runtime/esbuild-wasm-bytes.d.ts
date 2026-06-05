/**
 * esbuild-wasm-bytes.ts — supervisor-side fetcher for the esbuild-wasm
 * binary. The bytes live in the static-assets layer (env.ASSETS); this
 * module hands them to the caller as an ArrayBuffer when needed.
 *
 * Cache strategy
 * ──────────────
 * - NO module-scope cache (would pin 16 MiB in supervisor heap; the
 *   reason this module exists, see Phase 2 A'.5 below).
 * - L2 colo cache via `caches.default` (cache-and-scrub W-D): the bytes
 *   are version-pinned by URL (`/_assets/esbuild-<ESBUILD_VERSION>.wasm`),
 *   so an `immutable` cache entry is correct. The Cache API holds its
 *   OWN reference outside the supervisor heap, so this does not
 *   re-introduce the residency that A'.5 removed.
 *
 * Why no module-scope cache (Phase 2 A'.5)
 * ────────────────────────────────────────
 * Pre-rebuild this module decoded a 16 MiB base64 string from
 * src/esbuild-wasm-bundle.generated.ts into an ArrayBuffer and cached
 * the result in module scope for the lifetime of the supervisor
 * isolate. The cache contributed 16 MiB resident to the supervisor
 * heap (`esbuildResidentBytes` in src/observability/heap-estimate.ts)
 * AND the base64 string contributed ~21 MiB to the worker bundle
 * baseline.
 *
 * The architecturally correct path is to keep the bytes in the static-
 * assets layer (public/_assets/esbuild-<version>.wasm), fetch on
 * demand, and let workerd's loader own the only long-lived copy
 * (inside dynamic-worker isolates that need it). Cache API entries
 * are stored OUTSIDE the supervisor heap (workerd manages them), so
 * adding L2 wrap doesn't undo this.
 *
 * Each call to `fetchEsbuildWasmBytes(env)` now does:
 *   - one `caches.default.match()` — sub-millisecond on hit
 *   - on miss: one env.ASSETS.fetch() + one cache write-back
 *   - one Response.arrayBuffer() — 12 MiB ArrayBuffer in supervisor
 *     heap, briefly, then GC'd
 *
 * Failure model
 * ─────────────
 * Cache lookup failure (any throw) → fall through to ASSETS.
 * ASSETS fetch returning non-200 → throw (deploy bug, surface loudly).
 */
/**
 * Path inside env.ASSETS where the esbuild-wasm binary lives.
 * Versioned so a future esbuild-wasm bump produces a different asset
 * name and forces a fresh fetch (no stale-cache risk). The matching
 * file is staged at public/_assets/esbuild-<version>.wasm by
 * scripts/bundle-esbuild-wasm.mjs at predeploy time.
 */
export declare const ESBUILD_WASM_ASSET_PATH = "/_assets/esbuild-0.24.2.wasm";
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
 * Synthetic L2 cache key for the esbuild-wasm asset. Versioned via
 * ESBUILD_WASM_ASSET_PATH so each esbuild upgrade lands a fresh entry
 * and old entries naturally evict on TTL.
 *
 * Exported so the test endpoint at /api/_test/cache/wasm/reset can
 * purge the entry between probe runs (otherwise wrangler dev's
 * persistent caches.default.state preserves the L2 hit across sessions
 * and the cold path is unobservable).
 */
export declare const ESBUILD_WASM_L2_KEY = "https://nimbus-cache.invalid/_assets/esbuild-0.24.2.wasm";
/**
 * Fetch the esbuild-wasm bytes from the static-assets layer.
 *
 * The supervisor briefly holds the 12 MiB ArrayBuffer between this
 * call and the caller's hand-off to workerd's LOADER. After the
 * caller's reference goes out of scope, GC reclaims it; supervisor
 * residency drops back to zero.
 *
 * L2 (cache-and-scrub W-D): on hit, returns the bytes from
 * `caches.default` (per-colo, sub-millisecond). On miss, falls through
 * to env.ASSETS and write-back. Cache failures are silent — ASSETS is
 * always the correct source of truth.
 */
export declare function fetchEsbuildWasmBytes(env: EsbuildWasmFetchEnv): Promise<ArrayBuffer>;
//# sourceMappingURL=esbuild-wasm-bytes.d.ts.map