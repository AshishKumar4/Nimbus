// X.5-U probe helpers — Node-side integration harness.
//
// Re-export the X.5-Z3 / X.5-C makeVfs shim (in-memory SqliteVFS surface
// satisfying exists/isDirectory/readFileString/readdir for the prefetch
// passes) and add a tryRealHelper for the new addStaticReadFileDotfilesAndCompiled
// export we'll add in Phase D.

import { makeVfs, check, summary, reset, results } from '../x5c/_helpers.mjs';

export { makeVfs, check, summary, reset, results };

/**
 * Try to call the real `addStaticReadFileDotfilesAndCompiled` helper from
 * src/facet-manager.ts (added in Phase D). Returns null if not exported
 * (pre-fix), so the probe can record TDD-RED.
 */
export async function tryRealDotfileHelper() {
  try {
    const fm = await import('../../../src/facets/manager.ts');
    if (typeof fm.addStaticReadFileDotfilesAndCompiled === 'function') {
      return fm.addStaticReadFileDotfilesAndCompiled;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Also try the existing `addStaticReadFileAssets` for regression tests
 * that need to verify it's untouched.
 */
export async function tryRealAssetHelper() {
  try {
    const fm = await import('../../../src/facets/manager.ts');
    if (typeof fm.addStaticReadFileAssets === 'function') {
      return fm.addStaticReadFileAssets;
    }
  } catch { /* ignore */ }
  return null;
}
