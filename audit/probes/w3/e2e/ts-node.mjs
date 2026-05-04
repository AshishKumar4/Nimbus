// W3 e2e — ts-node installs and require()s
//
// Pre-build: FAIL — "Cannot find module 'repl'".
// Post-build: PASS — repl forwarded to workerd's stub.

import { execProbe } from '../_helpers.mjs';

export default function e2e_ts_node() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-ts-node', `
      const m = require('ts-node');
      console.log('TSN_TYPE=' + (typeof m));
      console.log('TSN_REGISTER=' + (typeof m.register));
      console.log('TSN_CREATE=' + (typeof m.create));
    `, {
      preCmds: ['cd app && npm install ts-node typescript'], runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('e2e-ts-node', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('TSN_TYPE=object')
      && so.includes('TSN_REGISTER=function');
    return assertProbe('e2e-ts-node', ok, 'expected ts-node surface, got:\n' + so, r.output);
  });
}
