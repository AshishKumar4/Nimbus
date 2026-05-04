// W3 functional probe — require('node:fs/promises') (with node: prefix)
//
// This is the puppeteer-core blocker today:
//   audit/probes/packages-prod-w26a/puppeteer-core.out.txt:
//     "Cannot find module 'node:fs/promises' (from .../puppeteer-core/lib/cjs)"
import { execProbe } from '../_helpers.mjs';

export default function fs_promises_node_prefix() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('fs-promises-node-prefix', `
      const fsp = require('node:fs/promises');
      console.log('NFSP_TYPEOF=' + (typeof fsp));
      console.log('NFSP_READFILE=' + (typeof fsp.readFile));
      console.log('NFSP_MKDIR=' + (typeof fsp.mkdir));
    `);
    if (!r.ok) return assertProbe('fs-promises-node-prefix', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('NFSP_TYPEOF=object')
      && so.includes('NFSP_READFILE=function')
      && so.includes('NFSP_MKDIR=function');
    return assertProbe('fs-promises-node-prefix', ok, 'expected node:fs/promises surface, got:\n' + so, r.output);
  });
}
