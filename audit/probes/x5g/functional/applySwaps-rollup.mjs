#!/usr/bin/env bun
// X5G functional G2: applySwaps rewrites rollup → @rollup/wasm-node.
//
// Verifies the new WASM_SWAPS entry is wired correctly through
// applySwaps and lookupSwap. Reuses the W6.5 applySwaps-pure-no-emit
// pattern.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

group('rollup swap entry exists', () => {
  const entry = reg.lookupSwap('rollup');
  ok('lookupSwap("rollup") returns an entry', !!entry);
  if (entry) {
    eq('  .from === "rollup"', entry.from, 'rollup');
    eq('  .to === "@rollup/wasm-node"', entry.to, '@rollup/wasm-node');
    eq('  .compat === "drop-in"', entry.compat, 'drop-in');
    ok('  .reason mentions npm 4828 or optional dep', /4828|optional/i.test(entry.reason));
  }
});

group('applySwaps rewrites rollup', () => {
  const { specs, swaps } = reg.applySwaps({ rollup: '^4.0.0' });
  eq('input rollup → output @rollup/wasm-node',
    Object.keys(specs).sort(),
    ['@rollup/wasm-node']);
  eq('@rollup/wasm-node carries the same range',
    specs['@rollup/wasm-node'],
    '^4.0.0');
  eq('swaps array has one entry', swaps.length, 1);
  if (swaps.length === 1) {
    eq('  swap.from === "rollup"', swaps[0].from, 'rollup');
  }
});

group('applySwaps idempotent on @rollup/wasm-node', () => {
  const { specs, swaps } = reg.applySwaps({ '@rollup/wasm-node': '^4' });
  eq('@rollup/wasm-node passes through unchanged',
    Object.keys(specs).sort(),
    ['@rollup/wasm-node']);
  eq('no swaps fired', swaps.length, 0);
});

group('rollup not in REJECT_INSTALL (would conflict with WASM_SWAPS)', () => {
  ok('lookupReject("rollup") returns undefined',
    reg.lookupReject('rollup') === undefined);
});

group('mixed specs', () => {
  const { specs, swaps } = reg.applySwaps({
    react: '^18',
    rollup: '^4',
    esbuild: '^0.24',  // existing W6 swap
  });
  eq('react untouched',  specs.react, '^18');
  eq('rollup → @rollup/wasm-node', specs['@rollup/wasm-node'], '^4');
  eq('esbuild → esbuild-wasm',     specs['esbuild-wasm'], '^0.24');
  eq('two swaps fired', swaps.length, 2);
});

summary('applySwaps-rollup');
