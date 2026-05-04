// W3 functional probe — real MD5 via node:crypto
// Spec: createHash('md5').update('hello').digest('hex') === 5d41402abc4b2a76b9719d911017c592
import { execProbe } from '../_helpers.mjs';

export default function crypto_md5() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('crypto-md5', `
      const c = require('crypto');
      const h = c.createHash('md5').update('hello').digest('hex');
      console.log('MD5_HELLO=' + h);
    `);
    if (!r.ok) return assertProbe('crypto-md5', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const expected = 'MD5_HELLO=5d41402abc4b2a76b9719d911017c592';
    return assertProbe('crypto-md5', so.includes(expected),
      'expected "' + expected + '", got:\n' + so, r.output);
  });
}
