// W6 functional: applySwaps purity, idempotency, edge cases.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/functional/apply-swaps');
}

const { applySwaps } = mod;

group('basic rewrite', () => {
  const input = { esbuild: '^0.19.0', lodash: '^4.17.21' };
  const r = applySwaps(input);
  ok('result has specs', !!r.specs);
  ok('result has swaps array', Array.isArray(r.swaps));
  eq('esbuild rewritten away', r.specs.esbuild, undefined);
  ok('esbuild-wasm now in specs', 'esbuild-wasm' in r.specs);
  eq('lodash untouched', r.specs.lodash, '^4.17.21');
  eq('one swap recorded', r.swaps.length, 1);
  if (r.swaps[0]) {
    eq('swap.from is esbuild', r.swaps[0].from, 'esbuild');
    eq('swap.to is esbuild-wasm', r.swaps[0].to, 'esbuild-wasm');
  }
});

group('purity: input not mutated', () => {
  const input = { esbuild: '^0.19', lodash: '^4' };
  const before = JSON.stringify(input);
  applySwaps(input);
  eq('input unchanged after applySwaps', JSON.stringify(input), before);
});

group('idempotency', () => {
  const input = { esbuild: '^0.19.0', lodash: '^4' };
  const r1 = applySwaps(input);
  const r2 = applySwaps(r1.specs);
  eq('second pass produces same specs', r2.specs, r1.specs);
  eq('second pass swaps is empty (already rewritten)', r2.swaps, []);
});

group('empty input', () => {
  const r = applySwaps({});
  eq('empty specs in', r.specs, {});
  eq('empty swaps array', r.swaps, []);
});

group('no swap candidates', () => {
  const input = { lodash: '^4', react: '^18' };
  const r = applySwaps(input);
  eq('specs unchanged', r.specs, input);
  eq('no swaps', r.swaps, []);
});

group('range carried over to swap target', () => {
  // The swap rewrites name; spec range propagates. (May become
  // 'latest' depending on registry policy — assert the contract:
  // if registry preserves the range, it's there; if registry
  // forces 'latest' as in plan §3.1, accept that.)
  const input = { esbuild: '^0.19.0' };
  const r = applySwaps(input);
  const range = r.specs['esbuild-wasm'];
  ok('swap target has a range string', typeof range === 'string' && range.length > 0);
});

summary('w6/functional/apply-swaps');
