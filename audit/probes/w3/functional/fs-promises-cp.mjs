// W3 functional probe — fs.promises.cp recursive
import { execProbe } from '../_helpers.mjs';

export default function fs_promises_cp() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('fs-promises-cp', `
      const fs = require('fs');
      const fsp = fs.promises;
      (async () => {
        await fsp.mkdir('/tmp/cp-src', { recursive: true });
        await fsp.mkdir('/tmp/cp-src/sub', { recursive: true });
        await fsp.writeFile('/tmp/cp-src/a.txt', 'A');
        await fsp.writeFile('/tmp/cp-src/sub/b.txt', 'B');
        await fsp.cp('/tmp/cp-src', '/tmp/cp-dest', { recursive: true });
        const a = await fsp.readFile('/tmp/cp-dest/a.txt', 'utf8');
        const b = await fsp.readFile('/tmp/cp-dest/sub/b.txt', 'utf8');
        console.log('CP_A=' + a);
        console.log('CP_B=' + b);
      })().catch(e => console.log('CP_ERROR=' + (e.code || e.message)));
    `);
    if (!r.ok) return assertProbe('fs-promises-cp', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    return assertProbe('fs-promises-cp',
      so.includes('CP_A=A') && so.includes('CP_B=B'),
      'expected CP_A=A and CP_B=B, got:\n' + so, r.output);
  });
}
