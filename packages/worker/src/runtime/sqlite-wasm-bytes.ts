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

import { SQLJS_VERSION } from '../constants.js';
import { SQLITE_WASM_SHA256 } from '../sqlite-wasm-bundle.generated.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';
import { sha256Hex } from '../_shared/crypto.js';

/**
 * Path inside env.ASSETS where the sql.js wasm binary lives. Versioned so
 * a future sql.js bump produces a different asset name and forces a fresh
 * fetch. Staged at public/_assets/sqljs-<version>.wasm by
 * scripts/bundle-sqlite-wasm.mjs at predeploy time.
 */
export const SQLITE_WASM_ASSET_PATH = `/_assets/sqljs-${SQLJS_VERSION}.wasm`;

/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface SqliteWasmFetchEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/**
 * Synthetic L2 cache key for the sql.js wasm asset. Version-pinned so each
 * sql.js upgrade lands a fresh entry and old entries evict on TTL.
 */
export const SQLITE_WASM_L2_KEY = `https://nimbus-cache.invalid/_assets/sqljs-${SQLJS_VERSION}.wasm`;

/**
 * Fetch the sql.js wasm bytes from the static-assets layer.
 *
 * L2 (caches.default) fast path; ASSETS on miss with write-back. Cache
 * failures are silent — ASSETS is always the source of truth. A non-200
 * from ASSETS, or a digest mismatch on either tier, throws.
 */
export async function fetchSqliteWasmBytes(env: SqliteWasmFetchEnv): Promise<ArrayBuffer> {
  const caches = (globalThis as { caches?: { default?: Cache } }).caches;

  // ── L2 fast path ────────────────────────────────────────────────
  let ab: ArrayBuffer | null = null;
  try {
    if (caches?.default) {
      const hit = await caches.default.match(new Request(SQLITE_WASM_L2_KEY));
      if (hit && hit.ok) ab = await hit.arrayBuffer();
    }
  } catch { /* fall through to ASSETS */ }

  const fromCache = ab !== null;
  if (!ab) {
    // ── ASSETS path ───────────────────────────────────────────────
    const url = `https://nimbus-internal.invalid${SQLITE_WASM_ASSET_PATH}`;
    const res = await env.ASSETS.fetch(new Request(url));
    try {
      if (!res.ok) {
        throw new Error(
          `sql.js wasm asset fetch failed: ${res.status} ${res.statusText} ` +
            `for ${SQLITE_WASM_ASSET_PATH} — deploy is missing the wasm asset`,
        );
      }
      ab = await res.arrayBuffer();
    } finally {
      disposeRpcResource(res);
    }
  }

  const digest = await sha256Hex(ab);
  if (digest !== SQLITE_WASM_SHA256) {
    throw new Error(
      `sql.js wasm integrity check failed: expected ${SQLITE_WASM_SHA256}, got ` +
        `${digest} (${fromCache ? 'L2 cache' : 'ASSETS'}) for ${SQLITE_WASM_ASSET_PATH} — ` +
        'the staged asset is corrupt or out of sync; rerun ' +
        'scripts/bundle-sqlite-wasm.mjs and redeploy',
    );
  }

  // ── L2 write-back (best-effort) ─────────────────────────────────
  if (!fromCache) {
    try {
      if (caches?.default) {
        const writeBack = new Response(new Uint8Array(ab), {
          headers: {
            'Content-Type': 'application/wasm',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
        await caches.default.put(new Request(SQLITE_WASM_L2_KEY), writeBack);
      }
    } catch { /* silent */ }
  }

  return ab;
}
