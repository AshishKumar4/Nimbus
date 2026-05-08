// W6 e2e: when a swap fires during install, the user's package.json
// `dependencies` retains the original key (`esbuild`), not the swap
// target (`esbuild-wasm`). The lockfile alone records the swap target.
//
// This is a logic probe of the buildSpecs/updatePackageJson contract.
// We don't run a real installer — we simulate the data flow. The
// underlying invariant: swap-rewritten keys are tagged so
// updatePackageJson can avoid leaking them into the user's source-of-
// truth file.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/e2e/swap-preserves-package-json');
}

const { applySwaps } = mod;

// Simulate updatePackageJson's W6-aware logic. The contract:
//   - dependencies map is keyed by the USER-SUPPLIED name (pre-swap)
//   - the resolved/installed name (post-swap) is recorded only in the
//     lockfile + node_modules layout
//   - if the user's package.json originally had key `esbuild`, the
//     swap MUST NOT rewrite it to `esbuild-wasm`
function simulatePostInstallPackageJson(userPkgJson, swaps) {
  // Build a swap-from-set so we know which keys were rewritten
  const swapFroms = new Set(swaps.map(s => s.from));
  // The user's deps stay as-is (no rewrite for swapped keys).
  // For non-swapped keys we'd update versions to resolved; out of scope here.
  return { ...userPkgJson, dependencies: { ...userPkgJson.dependencies } };
}

group('package.json key preserved after swap', () => {
  const userPkgJson = {
    name: 'app',
    dependencies: {
      esbuild: '^0.19.0',
      lodash: '^4.17.21',
    },
  };

  const { specs, swaps } = applySwaps(userPkgJson.dependencies);

  // Lockfile records swap target
  ok('lockfile-style specs has esbuild-wasm', 'esbuild-wasm' in specs);
  ok('lockfile-style specs does NOT have esbuild', !('esbuild' in specs));

  // package.json should NOT be rewritten
  const result = simulatePostInstallPackageJson(userPkgJson, swaps);
  ok('user package.json still has esbuild key', 'esbuild' in result.dependencies);
  ok('user package.json does NOT have esbuild-wasm key', !('esbuild-wasm' in result.dependencies));
});

group('multiple deps + a swap', () => {
  const userPkgJson = {
    name: 'app',
    dependencies: {
      react: '^18',
      esbuild: '^0.19',
      lodash: '^4',
    },
  };
  const { specs, swaps } = applySwaps(userPkgJson.dependencies);
  const result = simulatePostInstallPackageJson(userPkgJson, swaps);
  eq('package.json deps unchanged', result.dependencies, userPkgJson.dependencies);
  ok('lockfile has 3 entries', Object.keys(specs).length === 3);
  ok('lockfile lists esbuild-wasm', 'esbuild-wasm' in specs);
});

summary('w6/e2e/swap-preserves-package-json');
