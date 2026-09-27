/**
 * staged-source.ts — the one supervisor-side read of a build artifact a bundle
 * script staged under public/_assets/ instead of inlining it in the Worker
 * bundle (wasm modules, facet source texts).
 *
 * The staging script pins each artifact by sha-256 in a `.generated.ts`. This
 * module reads it through L2 (caches.default) under a key that changes with
 * the bytes, with ASSETS as the source of truth, and hands out nothing that
 * fails the pinned digest: a stale or partial asset never reaches workerd's
 * loader or a facet. L2 is written only with verified bytes read from ASSETS.
 *
 * Artifacts differ only in what they name in errors and in what a bad L2 entry
 * means to their caller (`poisonedCache`), so each passes those in.
 */

import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';

/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface StagedSourceEnv {
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

/** One staged artifact, as its `.generated.ts` pins it. */
export interface StagedAsset {
  /** Asset path ASSETS serves, e.g. `/_assets/runtime/node-shims-<buildId>.js`. */
  path: string;
  /** L2 key; carries the build id or version, so it changes with the bytes. */
  l2Key: string;
  /** Full digest the bytes must match. */
  sha256: string;
  /** Content-Type of the L2 copy, where the artifact has one. */
  contentType?: string;
  /**
   * An L2 entry that fails the digest: `reject` throws, `refetch` deletes the
   * entry and reads ASSETS instead (whose bytes then replace it).
   */
  poisonedCache: 'reject' | 'refetch';
  /** Message for a deploy with no ASSETS binding. */
  missingBinding: string;
  /** Message for a non-OK ASSETS response. */
  fetchFailed(res: Response): string;
  /** Message for bytes that do not match `sha256`. */
  integrityFailed(digest: string, from: 'L2 cache' | 'ASSETS'): string;
}

/** Fetch a staged artifact's bytes and verify them against its pinned digest. */
export async function fetchStagedBytes(env: StagedSourceEnv, asset: StagedAsset): Promise<ArrayBuffer> {
  if (!env.ASSETS) throw new Error(asset.missingBinding);
  // The colo cache, where the runtime has one: workerd does, a test harness may not.
  const cache = typeof caches === 'undefined' ? undefined : caches.default;

  if (cache) {
    let cached: ArrayBuffer | null = null;
    try {
      const hit = await cache.match(new Request(asset.l2Key));
      if (hit && hit.ok) cached = await hit.arrayBuffer();
    } catch { /* fall through to ASSETS */ }
    if (cached !== null) {
      const digest = await sha256Hex(cached);
      if (digest === asset.sha256) return cached;
      if (asset.poisonedCache === 'reject') throw new Error(asset.integrityFailed(digest, 'L2 cache'));
      try { await cache.delete(new Request(asset.l2Key)); } catch { /* the ASSETS read below still decides */ }
    }
  }

  // ASSETS routes by pathname only; `.invalid` (RFC 2606) marks the host as
  // internal to the binding.
  const res = await env.ASSETS.fetch(new Request(`https://nimbus-internal.invalid${asset.path}`));
  let bytes: ArrayBuffer;
  try {
    if (!res.ok) throw new Error(asset.fetchFailed(res));
    bytes = await res.arrayBuffer();
  } finally {
    disposeRpcResource(res);
  }

  const digest = await sha256Hex(bytes);
  if (digest !== asset.sha256) throw new Error(asset.integrityFailed(digest, 'ASSETS'));

  // Best-effort: ASSETS stays the source of truth. The cache copies the body
  // at put time, so the caller's buffer is unaffected.
  try {
    if (cache) {
      const headers: Record<string, string> = { 'Cache-Control': 'public, max-age=31536000, immutable' };
      if (asset.contentType) headers['Content-Type'] = asset.contentType;
      await cache.put(new Request(asset.l2Key), new Response(new Uint8Array(bytes), { headers }));
    }
  } catch { /* silent */ }
  return bytes;
}

/** {@link fetchStagedBytes}, decoded as UTF-8. */
export async function fetchStagedText(env: StagedSourceEnv, asset: StagedAsset): Promise<string> {
  return new TextDecoder().decode(await fetchStagedBytes(env, asset));
}

/**
 * One load per isolate: every caller shares the first call's promise, and a
 * rejected one is dropped so the next call loads again instead of pinning the
 * error.
 */
export function memoizeUntilRejected<A, T>(load: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  let memo: Promise<T> | null = null;
  return (arg) => {
    if (!memo) {
      const loading = load(arg);
      memo = loading;
      loading.catch(() => { if (memo === loading) memo = null; });
    }
    return memo;
  };
}

/**
 * The `StagedAsset` of a facet source text staged under
 * public/_assets/runtime/ by `stagedBy` and needed by `requiredBy`: a bad L2
 * entry is replaced from ASSETS, since every later fetch in the colo for the
 * build would otherwise fail on it.
 */
export function stagedRuntimeSource(source: {
  label: string;
  entry: string;
  buildId: string;
  sha256: string;
  stagedBy: string;
  requiredBy: string;
}): StagedAsset {
  return {
    path: source.entry,
    l2Key: `https://nimbus-cache.invalid${source.entry}?build=${source.buildId}`,
    sha256: source.sha256,
    poisonedCache: 'refetch',
    missingBinding:
      `Nimbus: ${source.requiredBy} requires an env.ASSETS binding (serves the ` +
      `staged ${source.label} source at ${source.entry}) — add the assets ` +
      'binding from the embed config (see packages/worker README)',
    fetchFailed: (res) =>
      `${source.label} asset fetch failed: ${res.status} ${res.statusText} for ` +
      `${source.entry} — deploy is missing the staged source (run ${source.stagedBy})`,
    integrityFailed: (digest) =>
      `${source.label} asset integrity mismatch for ${source.entry}: ` +
      `expected ${source.sha256.slice(0, 16)}…, got ${digest.slice(0, 16)}… — ` +
      `the staged asset is stale or corrupt; rerun ${source.stagedBy} and redeploy`,
  };
}
