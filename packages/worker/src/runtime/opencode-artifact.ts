/**
 * opencode-artifact.ts — supervisor-side fetcher for the staged opencode
 * CLI bundle.
 *
 * `npm install opencode-ai` resolves (via PACKAGE_ABI_POLICY.stagedArtifacts)
 * to the prebuilt JS bundle staged by scripts/bundle-opencode.mjs at
 * public/_assets/opencode/<version>/. This module fetches the CLI bundle text
 * (index.js) — installed as the package's `opencode` bin, executed by the node
 * runtime.
 *
 * Mirrors sqlite-wasm-bytes.ts: ASSETS is the source of truth; L2
 * (caches.default) keyed on a version-pinned synthetic URL; no module-scope
 * residency.
 *
 * Besides the CLI bundle this also fetches the tree-sitter wasm sidecars
 * (core + bash + powershell grammars) that ride into the facet module map as
 * pre-compiled WebAssembly.Modules for opencode's bash-tool command parser
 * (see OPENCODE_TREE_SITTER_WASMS and FacetManager.treeSitterModuleEntries).
 */

import {
  OPENCODE_ARTIFACT_BUILD_ID,
  OPENCODE_ARTIFACT_VERSION,
} from '../opencode-artifact.generated.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';

/** Base asset path of the staged opencode bundle directory. */
export const OPENCODE_ASSET_BASE = `/_assets/opencode/${OPENCODE_ARTIFACT_VERSION}`;

/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface OpencodeAssetEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

// The build id (content hash of the staged dist) is part of the L2 key so a
// same-version rebuild with different bytes never serves stale content from a
// warm colo cache.
function l2Key(file: string): string {
  return `https://nimbus-cache.invalid${OPENCODE_ASSET_BASE}/${OPENCODE_ARTIFACT_BUILD_ID}/${file}`;
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

/** Fetch a staged tree-sitter wasm sidecar (raw bytes for a `{ wasm }` module). */
export async function fetchOpencodeTreeSitterWasm(
  env: OpencodeAssetEnv,
  file: string,
): Promise<ArrayBuffer> {
  return fetchAsset(env, file);
}

/**
 * Fetch a staged TUI worker bundle source as text (the API server worker.js or
 * the OpenTUI parser.worker.js). Rides into the facet module map as an ESM
 * module the in-isolate Worker polyfill imports.
 */
export async function fetchOpencodeWorkerSource(
  env: OpencodeAssetEnv,
  file: string,
): Promise<string> {
  const ab = await fetchAsset(env, file);
  return new TextDecoder().decode(ab);
}
