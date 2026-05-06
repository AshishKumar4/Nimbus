#!/usr/bin/env bun
// W6.5 regression: synthetic transitive tree walk.
//
// Builds a synthetic resolved-tree where some package transitively depends
// on a SWAP origin (e.g. `vite` → `esbuild`). Walks the tree applying the
// registry's lookup at each level. Asserts the swap rewrites the transitive
// edge.
//
// This is a unit-style probe: it does NOT call the actual resolver (no
// NpmCache, no facet pool). It proves the *registry policy* is correctly
// shaped to drive transitive swap; the resolver-paths-symmetric probe
// proves the resolver actually applies it.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

// Synthetic tree: { name → { dependencies: Record<name, range> } }
const tree = {
  vite: { dependencies: { esbuild: '^0.24.0', rollup: '^4.0.0', postcss: '^8.0.0' } },
  rollup: { dependencies: {} },
  postcss: { dependencies: {} },
  esbuild: { dependencies: {} }, // would be present if NOT swapped
};

function walkApply(root) {
  const collected = { swaps: [], rejects: [], skipped: [] };

  function visit(name, deps) {
    // Per-name swap check (transitive policy).
    const swap = reg.lookupSwap(name);
    if (swap) {
      collected.swaps.push({ from: name, to: swap.to });
    }
    const reject = reg.lookupReject(name);
    if (reject) {
      if (reject.transitive === 'fail') collected.rejects.push({ from: name, transitive: true });
      else collected.skipped.push({ from: name });
      return;
    }
    for (const [depName, _range] of Object.entries(deps)) {
      const depEntry = tree[depName];
      const effDeps = depEntry?.dependencies || {};
      // Apply swap to dep edge before recursing.
      const depSwap = reg.lookupSwap(depName);
      const effName = depSwap ? depSwap.to : depName;
      if (depSwap) collected.swaps.push({ from: depName, to: depSwap.to });
      visit(effName, effDeps);
    }
  }

  visit(root, tree[root]?.dependencies || {});
  return collected;
}

group('vite → esbuild transitive swap', () => {
  const out = walkApply('vite');
  // esbuild appears as a transitive dep of vite; walk should record one swap.
  const esbuildSwap = out.swaps.find((s) => s.from === 'esbuild');
  ok('esbuild swap detected at depth>0', !!esbuildSwap);
  if (esbuildSwap) eq('swap target is esbuild-wasm', esbuildSwap.to, 'esbuild-wasm');
});

group('top-level esbuild also swaps', () => {
  const out = walkApply('esbuild');
  // walking root='esbuild' first hits visit('esbuild') which is a swap;
  // we expect the swap to be recorded once.
  const esbuildSwaps = out.swaps.filter((s) => s.from === 'esbuild');
  ok('esbuild swap recorded at top', esbuildSwaps.length >= 1);
});

group('no false-positive swaps for non-registered deps', () => {
  const out = walkApply('vite');
  // X.5-G G2: rollup is now in WASM_SWAPS (rollup → @rollup/wasm-node).
  // It IS expected to swap — moved to the positive-test group below.
  ok('postcss is NOT swapped', !out.swaps.some((s) => s.from === 'postcss'));
});

group('X5G G2: rollup transitive swap fires', () => {
  // vite has rollup as a dep; after X5G the rollup swap should fire
  // at depth>0 just like the esbuild one.
  const out = walkApply('vite');
  const rollupSwap = out.swaps.find((s) => s.from === 'rollup');
  ok('rollup swap detected at depth>0', !!rollupSwap);
  if (rollupSwap) eq('rollup swap target is @rollup/wasm-node', rollupSwap.to, '@rollup/wasm-node');
});

summary('transitive-swap-decision-rule');
