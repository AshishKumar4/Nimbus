#!/usr/bin/env bun
// X.5-26b functional — `lightningcss` is in REJECT_INSTALL with
// transitive='fail'. Pure data-lookup assertion.
//
// PRE-FIX: red. POST-FIX: green.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('lightningcss is in REJECT_INSTALL', () => {
  const r = reg.lookupReject('lightningcss');
  ok('lightningcss rejected', !!r);
  if (r) {
    eq('  transitive === fail', r.transitive, 'fail');
    ok('  reason mentions native', /native|wasm|workerd/i.test(r.reason));
    ok('  suggest present', typeof r.suggest === 'string' && r.suggest.length > 0);
  }
});

group('shouldWarnSkipTransitive("lightningcss") returns undefined (fail tier)', () => {
  ok('not warn-tier', reg.shouldWarnSkipTransitive('lightningcss') === undefined);
});

group('formatRejectError handles lightningcss', () => {
  const r = reg.lookupReject('lightningcss');
  if (r) {
    const out = reg.formatRejectError([r]);
    ok('formatRejectError contains "❌ lightningcss"', out.includes('❌ lightningcss'));
    ok('formatRejectError contains reason', out.includes(r.reason));
  }
});

summary('x526b lightningcss-rejected');
