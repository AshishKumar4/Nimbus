// X.5-Z3 probe helpers — Node-side integration harness.
//
// Mirror of audit/probes/x5c/_helpers.mjs makeVfs. We re-export from
// there to avoid duplication, plus add a tiny shim helper that the
// asset-prefetch probes use.

import { makeVfs, check, summary, reset, results } from '../x5c/_helpers.mjs';

export { makeVfs, check, summary, reset, results };

/**
 * Try to call the real `addStaticReadFileAssets` helper from
 * src/facet-manager.ts (added in Phase D). Returns null if not
 * exported (pre-fix), so the probe can record TDD-RED.
 */
export async function tryRealAssetHelper() {
  try {
    const fm = await import('../../../src/facet-manager.ts');
    if (typeof fm.addStaticReadFileAssets === 'function') {
      return fm.addStaticReadFileAssets;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Try to call the real `buildPrefetchBundle` helper too — we'll add a
 * named re-export of it so probes can hit the full pipeline.
 */
export async function tryRealBuildPrefetchBundle() {
  try {
    const fm = await import('../../../src/facet-manager.ts');
    if (typeof fm.buildPrefetchBundle === 'function') {
      return fm.buildPrefetchBundle;
    }
  } catch { /* ignore */ }
  return null;
}
