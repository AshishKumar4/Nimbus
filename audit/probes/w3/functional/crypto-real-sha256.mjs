// W3 functional probe — real SHA-256 via node:crypto
//
// Spec acceptance: crypto.createHash('sha256').update('hello').digest('hex')
//   must return the real SHA-256 of "hello":
//     2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
//
// Pre-build: FAIL — current FNV-1a impl returns
//   abdd62852c5bd7fc9fa116d64f0254ec  (×2 = 32 bytes hex)
// Post-build: PASS — workerd's real node:crypto is forwarded.

import { execProbe } from '../_helpers.mjs';

export default function crypto_real_sha256() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('crypto-real-sha256', `
      const c = require('crypto');
      const h = c.createHash('sha256').update('hello').digest('hex');
      console.log('SHA256_HELLO=' + h);
    `);
    if (!r.ok) return assertProbe('crypto-real-sha256', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const expected = 'SHA256_HELLO=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    return assertProbe('crypto-real-sha256', so.includes(expected),
      'expected "' + expected + '" in stdout, got:\n' + so, r.output);
  });
}
