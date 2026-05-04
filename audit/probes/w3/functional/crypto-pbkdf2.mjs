// W3 functional probe — pbkdf2 (RFC 6070 vector)
// pbkdf2('password', 'salt', 1, 20, 'sha1') ===
//   0c60c80f961f0e71f3a9b524af6012062fe037a6
import { execProbe } from '../_helpers.mjs';

export default function crypto_pbkdf2() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('crypto-pbkdf2', `
      const c = require('crypto');
      const k = c.pbkdf2Sync('password', 'salt', 1, 20, 'sha1').toString('hex');
      console.log('PBKDF2=' + k);
    `);
    if (!r.ok) return assertProbe('crypto-pbkdf2', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const expected = 'PBKDF2=0c60c80f961f0e71f3a9b524af6012062fe037a6';
    return assertProbe('crypto-pbkdf2', so.includes(expected),
      'expected "' + expected + '", got:\n' + so, r.output);
  });
}
