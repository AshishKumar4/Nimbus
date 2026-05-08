/**
 * esbuild-wasm-bytes.ts — supervisor-side fetcher for the esbuild-wasm
 * binary. The bytes live in the static-assets layer (env.ASSETS); this
 * module hands them to the caller as an ArrayBuffer when needed and
 * holds NO supervisor-side cache.
 *
 * Why no cache (Phase 2 A'.5)
 * ───────────────────────────
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
 * (inside dynamic-worker isolates that need it).
 *
 * Each call to `fetchEsbuildWasmBytes(env)` does:
 *   - one env.ASSETS.fetch() — internal binding, microsecond-scale
 *   - one Response.arrayBuffer() — 12 MiB ArrayBuffer in supervisor
 *     heap, briefly
 *   - returns to the caller (npm-installer pool construction), which
 *     hands the bytes to NimbusLoaderPool.wasmModules and drops its own
 *     reference shortly after
 *
 * After pool construction returns, the bytes only live inside
 * workerd's loader cache (where they should). Supervisor heap
 * residency: zero.
 *
 * Why no caching even within one install
 * ──────────────────────────────────────
 * npm-installer constructs at most three pools per install (resolve,
 * fetch, pre-bundle). Each pool construction does the fetch once. The
 * cost is ~3 internal-binding fetches per install — invisible against
 * the install's ~seconds of wall time. Caching the bytes between
 * pool constructions would re-introduce the supervisor residency.
 *
 * Failure model
 * ─────────────
 * If env.ASSETS.fetch() returns non-200, this throws. There is NO
 * fallback. A missing wasm asset is a deploy bug — the file is
 * required to exist at public/_assets/esbuild-<ESBUILD_VERSION>.wasm.
 * Surface the error loudly so deploy regressions are obvious.
 */

import { ESBUILD_VERSION } from '../constants.js';

/**
 * Path inside env.ASSETS where the esbuild-wasm binary lives.
 * Versioned so a future esbuild-wasm bump produces a different asset
 * name and forces a fresh fetch (no stale-cache risk). The matching
 * file is staged at public/_assets/esbuild-<version>.wasm by
 * scripts/bundle-esbuild-wasm.mjs at predeploy time.
 */
export const ESBUILD_WASM_ASSET_PATH = `/_assets/esbuild-${ESBUILD_VERSION}.wasm`;

/**
 * The minimal env shape this module needs. Defined narrowly so the
 * caller can pass any env with an ASSETS Fetcher binding without
 * dragging in the full Workers env type.
 */
export interface EsbuildWasmFetchEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/**
 * Fetch the esbuild-wasm bytes from the static-assets layer.
 *
 * The supervisor briefly holds the 12 MiB ArrayBuffer between this
 * call and the caller's hand-off to workerd's LOADER. After the
 * caller's reference goes out of scope, GC reclaims it; supervisor
 * residency drops back to zero.
 */
export async function fetchEsbuildWasmBytes(env: EsbuildWasmFetchEnv): Promise<ArrayBuffer> {
  const url = `https://nimbus-internal.invalid${ESBUILD_WASM_ASSET_PATH}`;
  // Construct a synthetic request — env.ASSETS routes by pathname only;
  // the host is ignored. Using `.invalid` per RFC-2606 makes it
  // unambiguous that this URL is internal-binding-only.
  const res = await env.ASSETS.fetch(new Request(url));
  if (!res.ok) {
    throw new Error(
      `esbuild-wasm asset fetch failed: ${res.status} ${res.statusText} ` +
      `for ${ESBUILD_WASM_ASSET_PATH} — deploy is missing the wasm asset`,
    );
  }
  return res.arrayBuffer();
}
