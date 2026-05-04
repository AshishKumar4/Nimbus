// W3 e2e — axios installs and require()s
//
// Pre-build: FAIL — "Cannot find module 'http2'".
// Post-build: PASS — http2 stub allows axios to load.

import { execProbe } from '../_helpers.mjs';

export default function e2e_axios() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-axios', `
      const m = require('axios');
      console.log('AXIOS_GET_TYPE=' + (typeof m.get));
      console.log('AXIOS_POST_TYPE=' + (typeof m.post));
      console.log('AXIOS_CREATE_TYPE=' + (typeof m.create));
    `, {
      preCmds: ['cd app && npm install axios'], runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('e2e-axios', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('AXIOS_GET_TYPE=function')
      && so.includes('AXIOS_POST_TYPE=function')
      && so.includes('AXIOS_CREATE_TYPE=function');
    return assertProbe('e2e-axios', ok, 'expected axios surface, got:\n' + so, r.output);
  });
}
