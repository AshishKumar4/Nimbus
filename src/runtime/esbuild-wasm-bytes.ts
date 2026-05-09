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
 * Synthetic L2 cache key for the esbuild-wasm asset. Versioned via
 * ESBUILD_WASM_ASSET_PATH so each esbuild upgrade lands a fresh entry
 * and old entries naturally evict on TTL.
 *
 * Exported so the test endpoint at /api/_test/cache/wasm/reset can
 * purge the entry between probe runs (otherwise wrangler dev's
 * persistent caches.default.state preserves the L2 hit across sessions
 * and the cold path is unobservable).
 */
export const ESBUILD_WASM_L2_KEY = `https://nimbus-cache.invalid/_assets/esbuild-${ESBUILD_VERSION}.wasm`;

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
export async function fetchEsbuildWasmBytes(env: EsbuildWasmFetchEnv): Promise<ArrayBuffer> {
  // ── L2 fast path ────────────────────────────────────────────────
  try {
    const c: any = (globalThis as any).caches;
    if (c?.default) {
      const hit = await c.default.match(new Request(ESBUILD_WASM_L2_KEY));
      if (hit && hit.ok) {
        return await hit.arrayBuffer();
      }
    }
  } catch { /* fall through to ASSETS */ }

  // ── L4 path (env.ASSETS) ────────────────────────────────────────
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
  // Read the bytes once (Response body is a one-shot stream). The
  // caller needs the ArrayBuffer to hand to workerd's LOADER; we
  // also use it to write through to L2.
  const ab = await res.arrayBuffer();
  // ── L2 write-back ──────────────────────────────────────────────
  // Eternal immutable TTL: the URL is version-pinned so a new
  // ESBUILD_VERSION lands a fresh cache entry; the old one naturally
  // evicts on TTL. The cache layer holds its own copy (workerd
  // structured-clones the body during put), so the supervisor's
  // reference to `ab` is unaffected.
  // Best-effort: a write failure does NOT block the caller.
  try {
    const c: any = (globalThis as any).caches;
    if (c?.default) {
      // We pass a fresh Uint8Array view over the same buffer; the
      // cache stores a copy at put time. Returning `ab` to the
      // caller stays valid because Response constructor doesn't
      // detach the buffer (only ReadableStream consumption would).
      const writeBack = new Response(new Uint8Array(ab), {
        headers: {
          'Content-Type': 'application/wasm',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
      // Awaited so subsequent reads strictly hit L2 (no
      // double-fetch race). The wasm payload is 12 MiB; workerd
      // structured-clones it into the cache, ~1-5 ms locally.
      await c.default.put(new Request(ESBUILD_WASM_L2_KEY), writeBack);
    }
  } catch { /* silent */ }
  return ab;
}
