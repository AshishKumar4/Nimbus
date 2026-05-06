#!/usr/bin/env bun
// X5G regression: W6's transitive='warn' policy (fsevents, bufferutil,
// utf-8-validate, node-gyp, node-pre-gyp) is unchanged by X5G.
//
// X5G's new G1 silent-skip applies to optionalDependencies entries
// detected as native bindings; it must NOT subsume the W6 reject-
// registry's transitive='warn' policy. These are separate code paths.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('W6 transitive=warn entries still in REJECT_INSTALL', () => {
  for (const name of ['fsevents', 'bufferutil', 'utf-8-validate', 'node-gyp', 'node-pre-gyp']) {
    const r = reg.lookupReject(name);
    ok(`${name} is rejected`, !!r);
    if (r) eq(`  ${name}.transitive === 'warn'`, r.transitive, 'warn');
  }
});

group('shouldWarnSkipTransitive returns the entry for warn names', () => {
  const fs = reg.shouldWarnSkipTransitive('fsevents');
  ok('shouldWarnSkipTransitive("fsevents") returns entry', !!fs);
  if (fs) eq('  fsevents transitive policy', fs.transitive, 'warn');
});

group('shouldWarnSkipTransitive returns undefined for fail names', () => {
  ok('shouldWarnSkipTransitive("sharp") undefined',
    reg.shouldWarnSkipTransitive('sharp') === undefined);
});

summary('transitive-warn-still-warns');
