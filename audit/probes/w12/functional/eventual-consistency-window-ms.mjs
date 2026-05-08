#!/usr/bin/env bun
// W12 functional: every 'replica-ok' / 'replica-warm-only' route declares
// an eventual-consistency tolerance ≤ 2000ms. Drift-detector for any new
// route added without a tolerance.

import { ok, lte, group, summary } from '../_tap.mjs';

let mod;
try { mod = await import('../../../../src/replica/routing.ts'); }
catch (e) { ok('replica-routing module imports', false, e.message); summary('w12/functional/eventual-consistency-window-ms'); }

const { REPLICA_POLICIES, getEventualConsistencyToleranceMs } = mod;

ok('REPLICA_POLICIES export', typeof REPLICA_POLICIES === 'object' && REPLICA_POLICIES !== null);
ok('getEventualConsistencyToleranceMs is a function', typeof getEventualConsistencyToleranceMs === 'function');

await group('eligible routes have ≤2000ms tolerance', () => {
  // Examples of replica-ok routes:
  for (const r of ['/api/memory', '/api/_diag/memory', '/api/processes', '/api/stats', '/api/_diag/foo']) {
    const ms = getEventualConsistencyToleranceMs(r);
    lte(`${r} tolerance ≤ 2000ms`, ms ?? Infinity, 2000);
    ok(`${r} has a numeric tolerance`, typeof ms === 'number');
  }
  // /preview/* (warm-only) — same threshold
  for (const r of ['/preview/', '/preview/index.html', '/preview/src/App.tsx']) {
    const ms = getEventualConsistencyToleranceMs(r);
    lte(`${r} tolerance ≤ 2000ms`, ms ?? Infinity, 2000);
  }
});

await group('primary-only routes have null tolerance (not replicable)', () => {
  for (const r of ['/api/write-file', '/ws', '/worker/', '/port/3000/', '/api/_test/log-tail']) {
    const ms = getEventualConsistencyToleranceMs(r);
    ok(`${r} returns null tolerance`, ms === null,
       `expected null, got ${ms}`);
  }
});

summary('w12/functional/eventual-consistency-window-ms');
