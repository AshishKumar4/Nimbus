// W3 e2e — jsdom installs and require()s
//
// Pre-build: FAIL — "Cannot find module 'vm'".
// Post-build: PASS for static load. (Actual HTML script execution
// requires runtime eval which workerd blocks; documented limitation
// in W3 retro.)

import { execProbe } from '../_helpers.mjs';

export default function e2e_jsdom() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-jsdom', `
      const m = require('jsdom');
      console.log('JSDOM_TYPE=' + (typeof m.JSDOM));
      console.log('JSDOM_VC_TYPE=' + (typeof m.VirtualConsole));
    `, {
      preCmds: ['cd app && npm install jsdom'], runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('e2e-jsdom', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('JSDOM_TYPE=function');
    return assertProbe('e2e-jsdom', ok, 'expected JSDOM constructor, got:\n' + so, r.output);
  });
}
