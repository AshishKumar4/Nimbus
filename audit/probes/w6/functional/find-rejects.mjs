// W6 functional: findRejects context-aware behaviour.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/functional/find-rejects');
}

const { findRejects } = mod;

group('top context: includes all matches', () => {
  const r = findRejects({ sharp: '*', fsevents: '*', lodash: '^4' }, 'top');
  eq('two rejects at top', r.length, 2);
  const fromSet = new Set(r.map(x => x.from));
  ok('sharp included', fromSet.has('sharp'));
  ok('fsevents included', fromSet.has('fsevents'));
});

group('transitive context: only fail-policy entries', () => {
  // sharp is fail (must include), fsevents is warn (must exclude)
  const r = findRejects({ sharp: '*', fsevents: '*', lodash: '^4' }, 'transitive');
  const fromSet = new Set(r.map(x => x.from));
  ok('sharp (fail) included transitively', fromSet.has('sharp'));
  ok('fsevents (warn) NOT included transitively', !fromSet.has('fsevents'));
});

group('empty inputs', () => {
  eq('empty top', findRejects({}, 'top'), []);
  eq('empty transitive', findRejects({}, 'transitive'), []);
});

group('no matches', () => {
  eq('clean specs top', findRejects({ lodash: '^4', react: '^18' }, 'top'), []);
  eq('clean specs transitive', findRejects({ lodash: '^4', react: '^18' }, 'transitive'), []);
});

group('bcrypt is rejected at top', () => {
  // bcrypt is in REJECT (was demoted from SWAP per plan v2)
  const r = findRejects({ bcrypt: '^5' }, 'top');
  eq('one reject', r.length, 1);
  if (r[0]) {
    eq('it is bcrypt', r[0].from, 'bcrypt');
    ok('reason mentions require() name issue', r[0].reason.toLowerCase().includes('require') || r[0].reason.toLowerCase().includes('name'));
  }
});

summary('w6/functional/find-rejects');
