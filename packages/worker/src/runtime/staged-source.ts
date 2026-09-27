/**
 * staged-source.ts — supervisor-side fetch of a source text a bundle script
 * staged under public/_assets/ instead of inlining it in the Worker bundle.
 *
 * Only facets run these sources, so they belong in the static-assets layer,
 * not the Worker script, which has a size gate
 * (tests/behavioral/assets-fetch/new/worker-bundle-size.mjs). The staging
 * script pins each one by content hash in a `.generated.ts`; this module reads
 * it through L2 (caches.default) keyed on that build id, with ASSETS as the
 * source of truth and a sha-256 check so a stale or partial asset can never
 * reach a facet. L2 is written only with bytes that passed that check, and an
 * entry that fails it is dropped and read from ASSETS again: an immutable
 * entry is served to every later fetch in the colo for the build.
 *
 * ASSETS is a mandatory embed binding (it serves the shell, sqlite wasm,
 * opencode artifacts); a missing binding fails loud here.
 */

import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';

/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface StagedSourceEnv {
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

/** One staged source, as its `.generated.ts` pins it. */
export interface StagedSource {
  /** Names the source in errors, e.g. `node-shims`. */
  label: string;
  /** Asset path, e.g. `/_assets/runtime/node-shims-<buildId>.js`. */
  entry: string;
  /** Content-hash prefix: the L2 key changes whenever the bytes do. */
  buildId: string;
  /** Full digest the fetched text must match. */
  sha256: string;
  /** The script that stages it, named when the deploy lacks the staged bytes. */
  stagedBy: string;
  /** What needs it, named when the ASSETS binding is missing. */
  requiredBy: string;
}

/** Fetch a staged source's text and verify it against its pinned digest. */
export async function fetchStagedSource(env: StagedSourceEnv, source: StagedSource): Promise<string> {
  if (!env.ASSETS) {
    throw new Error(
      `Nimbus: ${source.requiredBy} requires an env.ASSETS binding (serves the ` +
        `staged ${source.label} source at ${source.entry}) — add the assets ` +
        'binding from the embed config (see packages/worker README)',
    );
  }

  const l2Key = `https://nimbus-cache.invalid${source.entry}?build=${source.buildId}`;
  // The colo cache, where the runtime has one: workerd does, a test harness may not.
  const cache = typeof caches === 'undefined' ? undefined : caches.default;

  if (cache) {
    let cached: string | null = null;
    try {
      const hit = await cache.match(new Request(l2Key));
      if (hit && hit.ok) cached = await hit.text();
    } catch { /* fall through to ASSETS */ }
    if (cached !== null) {
      if (await sha256Hex(cached) === source.sha256) return cached;
      try { await cache.delete(new Request(l2Key)); } catch { /* the ASSETS read below still decides */ }
    }
  }

  const res = await env.ASSETS.fetch(new Request(`https://nimbus-internal.invalid${source.entry}`));
  let text: string;
  try {
    if (!res.ok) {
      throw new Error(
        `${source.label} asset fetch failed: ${res.status} ${res.statusText} for ` +
          `${source.entry} — deploy is missing the staged source ` +
          `(run ${source.stagedBy})`,
      );
    }
    text = await res.text();
  } finally {
    disposeRpcResource(res);
  }

  const digest = await sha256Hex(text);
  if (digest !== source.sha256) {
    throw new Error(
      `${source.label} asset integrity mismatch for ${source.entry}: ` +
        `expected ${source.sha256.slice(0, 16)}…, got ${digest.slice(0, 16)}… — ` +
        `the staged asset is stale or corrupt; rerun ${source.stagedBy} and redeploy`,
    );
  }

  try {
    if (cache) {
      await cache.put(
        new Request(l2Key),
        new Response(text, {
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        }),
      );
    }
  } catch { /* silent */ }
  return text;
}
