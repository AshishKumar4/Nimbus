// W6 regression: applySwaps + findRejects are no-ops on inputs that
// don't include any registered name. Guards against the registry
// accidentally rewriting unrelated names (e.g. a regex that's too
// greedy).

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/regression/builds-specs-passthrough');
}

const { applySwaps, findRejects } = mod;

// The Mossaic regression test installs these (transitively + explicitly):
const MOSSAIC_LIKE = {
  fastify: '^4',
  express: '^4',
  'ts-jest': '^29',
  jest: '^29',
  typescript: '^5',
  redis: '^4',
  // common transitive ones (not exhaustive — just sanity)
  pino: '^8',
  semver: '^7',
  'fast-json-stringify': '^5',
  'mime-types': '^2',
  'es-object-atoms': '^1',
};

group('applySwaps is a no-op on Mossaic-like input', () => {
  const input = JSON.parse(JSON.stringify(MOSSAIC_LIKE));
  const r = applySwaps(input);
  eq('specs deep-equal input', r.specs, MOSSAIC_LIKE);
  eq('no swaps recorded', r.swaps, []);
});

group('findRejects is empty on Mossaic-like input (top)', () => {
  eq('no rejects', findRejects(MOSSAIC_LIKE, 'top'), []);
});

group('findRejects is empty on Mossaic-like input (transitive)', () => {
  eq('no transitive rejects', findRejects(MOSSAIC_LIKE, 'transitive'), []);
});

summary('w6/regression/builds-specs-passthrough');
