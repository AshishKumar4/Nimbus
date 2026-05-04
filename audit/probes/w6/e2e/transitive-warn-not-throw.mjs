// W6 e2e: simulate a transitive resolver loop encountering a
// `transitive='warn'` reject (fsevents). It must:
//   - emit a [skip] line via captured onProgress
//   - NOT throw
//   - effectively drop the package from the resolved tree
//
// This emulates what resolveTreeInFacet / resolveTree will do at the
// transitive call site once wired (plan §4.2).

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/e2e/transitive-warn-not-throw');
}

const { lookupReject, findRejects, formatTransitiveSkip } = mod;

// Synthetic tree walker mimicking the resolver's per-name decision:
//   - if name is rejected with transitive='warn', emit skip line + drop
//   - if name is rejected with transitive='fail', throw
//   - else include
function fakeWalk(names, ctx, onProgress) {
  const out = [];
  for (const name of names) {
    const rej = lookupReject(name);
    if (rej) {
      if (rej.transitive === 'warn') {
        onProgress(formatTransitiveSkip(rej));
        continue; // drop
      } else {
        // 'fail' policy applies at any depth (per plan §4.2)
        throw new Error('transitive reject: ' + name);
      }
    }
    out.push(name);
  }
  return out;
}

group('transitive fsevents → warn skip, no throw', () => {
  const logged = [];
  let threw = false;
  let result;
  try {
    result = fakeWalk(['lodash', 'fsevents', 'react'], 'transitive', (m) => logged.push(m));
  } catch (e) { threw = true; }
  ok('did not throw', !threw);
  eq('result drops fsevents', result, ['lodash', 'react']);
  eq('one [skip] log line', logged.length, 1);
  ok('skip line contains fsevents', logged[0].includes('fsevents'));
  ok('skip line contains [skip] tag', logged[0].includes('[skip]'));
});

group('transitive sharp (fail) → throw', () => {
  let threw = false;
  let msg = '';
  try {
    fakeWalk(['lodash', 'sharp'], 'transitive', () => {});
  } catch (e) { threw = true; msg = e.message; }
  ok('did throw', threw);
  ok('message mentions sharp', msg.includes('sharp'));
});

group('transitive bufferutil/utf-8-validate (warn) → silent skip', () => {
  // ws-style optional natives. Both should warn, not throw.
  const logged = [];
  let threw = false;
  let result;
  try {
    result = fakeWalk(['ws', 'bufferutil', 'utf-8-validate'], 'transitive', (m) => logged.push(m));
  } catch (e) { threw = true; }
  ok('did not throw', !threw);
  eq('only ws survives', result, ['ws']);
  eq('two skip lines', logged.length, 2);
});

group('multiple transitive fails accumulate one error', () => {
  // Spec choice: transitive 'fail' rejects throw immediately on first
  // (it's at depth>0 — propagating partial state is wasteful). Test
  // current behaviour: throws on first.
  let threw = false;
  try {
    fakeWalk(['sharp', 'prisma'], 'transitive', () => {});
  } catch (e) { threw = true; }
  ok('throws on first transitive fail', threw);
});

summary('w6/e2e/transitive-warn-not-throw');
