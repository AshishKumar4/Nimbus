/**
 * opencode-artifact.ts — supervisor-side fetcher for the staged opencode
 * CLI bundle and its tree-sitter wasm sidecars.
 *
 * `npm install opencode-ai` resolves (via PACKAGE_ABI_POLICY.stagedArtifacts)
 * to the prebuilt JS bundle staged by scripts/bundle-opencode.mjs at
 * public/_assets/opencode/<version>/. This module fetches:
 *
 *   - the CLI bundle text (index.js) — installed as the package's `opencode`
 *     bin, executed by the node runtime;
 *   - a named tree-sitter wasm sidecar as ArrayBuffer — handed to the facet
 *     Worker Loader module map so opencode's bash-tool parser instantiates it
 *     via the emscripten `instantiateWasm` hook (request-time
 *     WebAssembly.compile is blocked inside facets).
 *
 * Mirrors sqlite-wasm-bytes.ts: ASSETS is the source of truth; L2
 * (caches.default) keyed on a version-pinned synthetic URL; no module-scope
 * residency.
 */

import { OPENCODE_ARTIFACT_VERSION } from '../opencode-artifact.generated.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';

/** Base asset path of the staged opencode bundle directory. */
export const OPENCODE_ASSET_BASE = `/_assets/opencode/${OPENCODE_ARTIFACT_VERSION}`;

/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface OpencodeAssetEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

function l2Key(file: string): string {
  return `https://nimbus-cache.invalid${OPENCODE_ASSET_BASE}/${file}`;
}

function assetUrl(file: string): string {
  return `https://nimbus-internal.invalid${OPENCODE_ASSET_BASE}/${file}`;
}

async function fetchAsset(env: OpencodeAssetEnv, file: string): Promise<ArrayBuffer> {
  const caches = (globalThis as { caches?: { default?: Cache } }).caches;

  try {
    if (caches?.default) {
      const hit = await caches.default.match(new Request(l2Key(file)));
      if (hit && hit.ok) return await hit.arrayBuffer();
    }
  } catch { /* fall through to ASSETS */ }

  const res = await env.ASSETS.fetch(new Request(assetUrl(file)));
  let ab: ArrayBuffer;
  try {
    if (!res.ok) {
      throw new Error(
        `opencode asset fetch failed: ${res.status} ${res.statusText} for ` +
          `${OPENCODE_ASSET_BASE}/${file} — deploy is missing the staged opencode artifact`,
      );
    }
    ab = await res.arrayBuffer();
  } finally {
    disposeRpcResource(res);
  }

  try {
    if (caches?.default) {
      const writeBack = new Response(new Uint8Array(ab), {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
      await caches.default.put(new Request(l2Key(file)), writeBack);
    }
  } catch { /* silent */ }

  return ab;
}

/** Fetch the opencode CLI bundle source as text. */
export async function fetchOpencodeBundle(env: OpencodeAssetEnv): Promise<string> {
  const ab = await fetchAsset(env, 'index.js');
  return new TextDecoder().decode(ab);
}

/** Fetch a tree-sitter wasm sidecar as ArrayBuffer for the facet module map. */
export async function fetchOpencodeWasm(
  env: OpencodeAssetEnv,
  file: string,
): Promise<ArrayBuffer> {
  return fetchAsset(env, file);
}
