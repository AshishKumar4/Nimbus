// W3 functional probe — require('fs/promises') (no node: prefix)
//
// This is the C5 review finding: today the shim only exposes
// `require('fs').promises`. Many libraries do `require('fs/promises')`
// which currently throws "Cannot find module 'fs/promises'".
import { execProbe } from '../_helpers.mjs';

export default function fs_promises_bare_require() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('fs-promises-bare-require', `
      const fsp = require('fs/promises');
      console.log('FSP_TYPEOF=' + (typeof fsp));
      console.log('FSP_READFILE=' + (typeof fsp.readFile));
      console.log('FSP_WRITEFILE=' + (typeof fsp.writeFile));
      console.log('FSP_STAT=' + (typeof fsp.stat));
    `);
    if (!r.ok) return assertProbe('fs-promises-bare-require', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('FSP_TYPEOF=object')
      && so.includes('FSP_READFILE=function')
      && so.includes('FSP_WRITEFILE=function')
      && so.includes('FSP_STAT=function');
    return assertProbe('fs-promises-bare-require', ok, 'expected fsp surface, got:\n' + so, r.output);
  });
}
