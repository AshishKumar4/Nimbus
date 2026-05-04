// W3 e2e — puppeteer-core installs and require()s
//
// Pre-build: FAIL — "Cannot find module 'node:fs/promises'".
// Post-build: PASS — node:fs/promises wired (review C5).

import { execProbe } from '../_helpers.mjs';

export default function e2e_puppeteer_core() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-puppeteer-core', `
      const m = require('puppeteer-core');
      console.log('PUP_TYPE=' + (typeof m));
      console.log('PUP_LAUNCH=' + (typeof m.launch));
      console.log('PUP_CONNECT=' + (typeof m.connect));
    `, {
      preCmds: ['cd app && npm install puppeteer-core'], runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('e2e-puppeteer-core', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('PUP_TYPE=object')
      && so.includes('PUP_LAUNCH=function');
    return assertProbe('e2e-puppeteer-core', ok, 'expected puppeteer-core surface, got:\n' + so, r.output);
  });
}
