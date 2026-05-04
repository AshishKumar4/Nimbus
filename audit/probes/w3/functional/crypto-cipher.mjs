// W3 functional probe — aes-256-cbc roundtrip via createCipheriv/createDecipheriv
import { execProbe } from '../_helpers.mjs';

export default function crypto_cipher() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('crypto-cipher', `
      const c = require('crypto');
      const key = Buffer.alloc(32, 0x42);
      const iv  = Buffer.alloc(16, 0x37);
      const enc = c.createCipheriv('aes-256-cbc', key, iv);
      const ct  = Buffer.concat([enc.update('hello world', 'utf8'), enc.final()]).toString('hex');
      const dec = c.createDecipheriv('aes-256-cbc', key, iv);
      const pt  = Buffer.concat([dec.update(Buffer.from(ct, 'hex')), dec.final()]).toString('utf8');
      console.log('CIPHER_PT=' + pt);
    `);
    if (!r.ok) return assertProbe('crypto-cipher', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    return assertProbe('crypto-cipher', so.includes('CIPHER_PT=hello world'),
      'expected roundtrip "hello world", got:\n' + so, r.output);
  });
}
