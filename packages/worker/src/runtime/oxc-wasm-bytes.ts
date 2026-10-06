/**
 * oxc-wasm-bytes.ts — supervisor-side fetcher for what the transform facet is
 * built from: the Oxc wasm (scripts/bundle-oxc-wasm.mjs) and the facet's
 * runtime script (scripts/bundle-facet-workers.mjs). Both are staged in the
 * static-assets layer under names carrying a prefix of their digest, read
 * through the colo cache (runtime/staged-source.ts), and verified against
 * their pins before the loader compiles or evaluates them.
 *
 * Neither is kept in module scope: they are read only when the facet's
 * loader has no worker cached under the facet's id, and that loader holds
 * the only long-lived copy, as compiled code. The host Worker never compiles
 * the wasm.
 */

import { OXC_WASM_ASSET_PATH, OXC_WASM_SHA256 } from '../oxc-wasm-artifact.generated.js';
import { OXC_FACET_ASSET_PATH, OXC_FACET_SHA256 } from '../oxc-facet-artifact.generated.js';
import { fetchStagedBytes, fetchStagedText, stagedAsset, type StagedSourceEnv } from './staged-source.js';

const OXC_WASM_ASSET = stagedAsset({
  label: 'Oxc wasm', path: OXC_WASM_ASSET_PATH, l2Key: `https://nimbus-cache.invalid${OXC_WASM_ASSET_PATH}`,
  sha256: OXC_WASM_SHA256, contentType: 'application/wasm',
  requiredBy: 'the transform facet', stagedBy: 'scripts/bundle-oxc-wasm.mjs',
});
const OXC_FACET_ASSET = stagedAsset({
  label: 'transform facet runtime', path: OXC_FACET_ASSET_PATH, l2Key: `https://nimbus-cache.invalid${OXC_FACET_ASSET_PATH}`,
  sha256: OXC_FACET_SHA256, contentType: 'text/javascript; charset=utf-8',
  requiredBy: 'the transform facet', stagedBy: 'scripts/bundle-facet-workers.mjs',
});

/** The Oxc wasm's bytes, for the transform facet's module map. */
export function fetchOxcWasmBytes(env: StagedSourceEnv): Promise<ArrayBuffer> {
  return fetchStagedBytes(env, OXC_WASM_ASSET);
}

/** The transform facet's runtime: a script that installs the globals its class reads. */
export function fetchOxcFacetRuntime(env: StagedSourceEnv): Promise<string> {
  return fetchStagedText(env, OXC_FACET_ASSET);
}
