#!/usr/bin/env bun
// X.5-26b functional — `@tailwindcss/oxide` is in REJECT_INSTALL with
// transitive='fail'. Asserts the registry data shape directly (no
// install pipeline involvement; pure data lookup).
//
// PRE-FIX: red (entry absent → lookupReject returns undefined).
// POST-FIX: green.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('@tailwindcss/oxide is in REJECT_INSTALL', () => {
  const r = reg.lookupReject('@tailwindcss/oxide');
  ok('@tailwindcss/oxide rejected', !!r);
  if (r) {
    eq('  transitive === fail', r.transitive, 'fail');
    ok('  reason mentions native', /native|wasm|workerd/i.test(r.reason));
    ok('  suggest present', typeof r.suggest === 'string' && r.suggest.length > 0);
  }
});

group('shouldWarnSkipTransitive("@tailwindcss/oxide") returns undefined (fail tier)', () => {
  ok('not warn-tier', reg.shouldWarnSkipTransitive('@tailwindcss/oxide') === undefined);
});

group('formatRejectError handles @tailwindcss/oxide', () => {
  const r = reg.lookupReject('@tailwindcss/oxide');
  if (r) {
    const out = reg.formatRejectError([r]);
    ok('formatRejectError contains "❌ @tailwindcss/oxide"', out.includes('❌ @tailwindcss/oxide'));
    ok('formatRejectError contains reason', out.includes(r.reason));
  }
});

summary('x526b oxide-rejected');
