#!/usr/bin/env bun
// W6.5 functional: @img/sharp-wasm32 is in REJECT_INSTALL with the documented reason.

import { ok, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

group('@img/sharp-wasm32 is rejected', () => {
  const e = reg.lookupReject('@img/sharp-wasm32');
  ok('REJECT entry exists', !!e);
  if (!e) return;
  ok('reason mentions wasm32 cpu OR libvips threads', /wasm32|libvips|threads|pthread/i.test(e.reason));
  ok('suggest exists', typeof e.suggest === 'string' && e.suggest.length > 0);
  ok('suggest mentions wasm-vips OR server-side', /wasm-vips|server-side|render/i.test(e.suggest || ''));
  ok('transitive policy is fail', e.transitive === 'fail');
});

summary('sharp-wasm32-rejected');
