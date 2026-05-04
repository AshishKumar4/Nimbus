// W3 regression anchor — sha256('hello') is NEVER again the FNV-1a fake.
//
// The bug: src/node-shims.ts:583-664 (pre-W3) hand-rolled a 4-state FNV-1a
// and shipped its bytes as "sha256". The visible signature was
//   abdd62852c5bd7fc9fa116d64f0254ec  (16 bytes hex, repeated twice for
//                                       the 32-byte sha256 output).
//
// This regression test asserts: under no future change should
// sha256('hello') return the FNV-1a bytes. Forever-test.

import { execProbe } from '../_helpers.mjs';

export default function crypto_fnv_regression() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('crypto-fnv-regression', `
      const c = require('crypto');
      const h = c.createHash('sha256').update('hello').digest('hex');
      console.log('REG_SHA256=' + h);
    `);
    if (!r.ok) return assertProbe('crypto-fnv-regression', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const fnvFake = 'abdd62852c5bd7fc9fa116d64f0254ec'; // appears twice in the FNV output
    const realExpected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    // PASS conditions (both must hold):
    //   1. The FNV signature is NOT in the output.
    //   2. The real sha256 IS in the output (positive sanity).
    const fnvAbsent = !so.toLowerCase().includes(fnvFake);
    const realPresent = so.toLowerCase().includes(realExpected);
    const ok = fnvAbsent && realPresent;
    return assertProbe('crypto-fnv-regression', ok,
      'expected NO FNV signature ("' + fnvFake + '") AND REAL sha256 ("' + realExpected + '") in output, got:\n' + so,
      r.output);
  });
}
