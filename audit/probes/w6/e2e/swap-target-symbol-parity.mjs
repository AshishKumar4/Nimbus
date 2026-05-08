// W6 e2e: every WASM_SWAPS entry with compat='drop-in' must export the
// same key set as the original at the require()/import site for the
// keys we publicly promise. Catches the case where the swap target
// drops a function the user is calling.
//
// For W6 v2, the only swap is esbuild → esbuild-wasm. We assert
// esbuild-wasm exports {build, transform, version, initialize} —
// the ESM esbuild API surface a Workers user is most likely to call.
//
// Note: this is a build-environment probe. It loads esbuild-wasm from
// THIS workspace's node_modules to verify the export shape; it does
// NOT test the swap inside Nimbus runtime (that's e2e/registry-coverage,
// which is prod-gated).

import { ok, group, summary } from '../_tap.mjs';

let registry;
try {
  registry = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/e2e/swap-target-symbol-parity');
}

const { WASM_SWAPS } = registry;

const REQUIRED_EXPORTS = {
  'esbuild-wasm': ['build', 'transform', 'version', 'initialize'],
};

group('drop-in swap targets export expected API', async () => {
  for (const swap of WASM_SWAPS) {
    if (swap.compat !== 'drop-in') {
      ok(`${swap.from} → ${swap.to}: not drop-in (skipped)`, true);
      continue;
    }
    const required = REQUIRED_EXPORTS[swap.to];
    if (!required) {
      ok(`${swap.to}: no required-exports list — add to REQUIRED_EXPORTS in this probe`, false);
      continue;
    }
    let m;
    try {
      m = await import(swap.to);
    } catch (e) {
      ok(`${swap.to} loadable from this workspace`, false, e.message);
      continue;
    }
    for (const key of required) {
      ok(`${swap.to} exports ${key}`, key in m || (m.default && key in m.default));
    }
  }
});

summary('w6/e2e/swap-target-symbol-parity');
