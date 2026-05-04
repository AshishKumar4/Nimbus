// W3 functional probe — randomBytes returns N bytes, two calls differ
import { execProbe } from '../_helpers.mjs';

export default function crypto_randombytes() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('crypto-randombytes', `
      const c = require('crypto');
      const a = c.randomBytes(16);
      const b = c.randomBytes(16);
      console.log('RB_A_LEN=' + a.length);
      console.log('RB_B_LEN=' + b.length);
      console.log('RB_DIFFER=' + (a.toString('hex') !== b.toString('hex')));
    `);
    if (!r.ok) return assertProbe('crypto-randombytes', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('RB_A_LEN=16') && so.includes('RB_B_LEN=16') && so.includes('RB_DIFFER=true');
    return assertProbe('crypto-randombytes', ok, 'expected len=16 + differ=true, got:\n' + so, r.output);
  });
}
