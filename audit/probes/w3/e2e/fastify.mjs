// W3 e2e — fastify installs, require()s, and instantiates
//
// Pre-build: FAIL — "Cannot find module 'node:diagnostics_channel'".
// Post-build: PASS — diagnostics_channel forwarded to workerd's real impl.

import { execProbe } from '../_helpers.mjs';

export default function e2e_fastify() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-fastify', `
      const fastify = require('fastify');
      console.log('FASTIFY_TYPE=' + (typeof fastify));
      const app = fastify();
      console.log('FASTIFY_LISTEN=' + (typeof app.listen));
      console.log('FASTIFY_GET=' + (typeof app.get));
      console.log('FASTIFY_DECORATE=' + (typeof app.decorate));
    `, {
      preCmds: ['cd app && npm install fastify'], runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('e2e-fastify', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('FASTIFY_TYPE=function')
      && so.includes('FASTIFY_LISTEN=function')
      && so.includes('FASTIFY_GET=function')
      && so.includes('FASTIFY_DECORATE=function');
    return assertProbe('e2e-fastify', ok, 'expected fastify instance surface, got:\n' + so, r.output);
  });
}
