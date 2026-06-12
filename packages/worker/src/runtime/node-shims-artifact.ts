/**
 * node-shims-artifact.ts — supervisor-side fetcher for the staged node-compat
 * shim source.
 *
 * The ~230 KiB generateShimsCode() output is staged as a static asset by
 * scripts/bundle-node-shims.mjs (promoted out of the worker bundle for the
 * ≤6 MiB bundle gate). Every node facet's generated worker text interpolates
 * it, so this fetch sits on the exec hot path: the result is memoized at
 * module scope (one fetch per isolate), fronted by L2 (caches.default) keyed
 * on the content-hash build id, with ASSETS as the source of truth and a
 * sha-256 integrity check so a stale or partial asset can never reach a facet.
 *
 * Mirrors opencode-artifact.ts / sqlite-wasm-bytes.ts. ASSETS is already a
 * mandatory embed binding (it serves the shell, sqlite wasm, opencode
 * artifacts); a missing binding fails loud here rather than producing a
 * facet with no node-compat layer.
 */

import {
  NODE_SHIMS_BUILD_ID,
  NODE_SHIMS_ENTRY,
  NODE_SHIMS_SHA256,
} from '../node-shims-artifact.generated.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';

/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface NodeShimsAssetEnv {
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

const L2_KEY = `https://nimbus-cache.invalid${NODE_SHIMS_ENTRY}?build=${NODE_SHIMS_BUILD_ID}`;
const ASSET_URL = `https://nimbus-internal.invalid${NODE_SHIMS_ENTRY}`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let memo: Promise<string> | null = null;

async function fetchAndVerify(env: NodeShimsAssetEnv): Promise<string> {
  if (!env.ASSETS) {
    throw new Error(
      'Nimbus: the node runtime requires an env.ASSETS binding (serves the ' +
        'staged node-compat shim at ' + NODE_SHIMS_ENTRY + ') — add the assets ' +
        'binding from the embed config (see packages/worker README)',
    );
  }

  const caches = (globalThis as { caches?: { default?: Cache } }).caches;
  let text: string | null = null;

  try {
    if (caches?.default) {
      const hit = await caches.default.match(new Request(L2_KEY));
      if (hit && hit.ok) text = await hit.text();
    }
  } catch { /* fall through to ASSETS */ }

  if (text === null) {
    const res = await env.ASSETS.fetch(new Request(ASSET_URL));
    try {
      if (!res.ok) {
        throw new Error(
          `node-shims asset fetch failed: ${res.status} ${res.statusText} for ` +
            `${NODE_SHIMS_ENTRY} — deploy is missing the staged shim ` +
            `(run scripts/bundle-node-shims.mjs)`,
        );
      }
      text = await res.text();
    } finally {
      disposeRpcResource(res);
    }

    try {
      if (caches?.default) {
        await caches.default.put(
          new Request(L2_KEY),
          new Response(text, {
            headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          }),
        );
      }
    } catch { /* silent */ }
  }

  const digest = await sha256Hex(text);
  if (digest !== NODE_SHIMS_SHA256) {
    throw new Error(
      `node-shims asset integrity mismatch for ${NODE_SHIMS_ENTRY}: ` +
        `expected ${NODE_SHIMS_SHA256.slice(0, 16)}…, got ${digest.slice(0, 16)}… — ` +
        'the staged asset is stale; rerun scripts/bundle-node-shims.mjs and redeploy',
    );
  }
  return text;
}

/**
 * The node-compat shim source for facet worker codegen. Memoized per isolate;
 * a failed fetch clears the memo so the next exec retries instead of pinning
 * the error.
 */
export function fetchNodeShimsCode(env: NodeShimsAssetEnv): Promise<string> {
  if (!memo) {
    memo = fetchAndVerify(env).catch((e: unknown) => {
      memo = null;
      throw e;
    });
  }
  return memo;
}
