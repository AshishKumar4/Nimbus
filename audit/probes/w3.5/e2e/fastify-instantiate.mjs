// W3.5 e2e — npm install fastify; require it; instantiate the server
//
// Pre-fix: FAIL — `Cannot read module: home/user/app/node_modules/ret/dist/types`
//                 (W3 retro S3). The directory-as-index path returns the dir
//                 instead of falling back to /index.js.
// Post-fix: PASS — strict-file probe in __resolveFile lets the loop fall
//                  through to /index.js for the ret/dist/types directory.
//
// Asserts:
//   - typeof fastify === 'function'
//   - app.listen, app.get, app.decorate are functions
//   - app.get('/', handler) registers without throwing

import { execProbe } from '../_helpers.mjs';

export default function e2e_fastify_instantiate() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-fastify-instantiate', `
      const fastify = require('fastify');
      console.log('FASTIFY_TYPE=' + (typeof fastify));
      const app = fastify();
      console.log('FASTIFY_LISTEN=' + (typeof app.listen));
      console.log('FASTIFY_GET=' + (typeof app.get));
      console.log('FASTIFY_DECORATE=' + (typeof app.decorate));
      try {
        app.get('/', (req, reply) => reply.send({ ok: true }));
        console.log('FASTIFY_ROUTE_REGISTERED=true');
      } catch (e) {
        console.log('FASTIFY_ROUTE_ERR=' + (e && e.message ? e.message : String(e)));
      }
    `, {
      preCmds: ['cd app && npm install fastify'],
      runInDir: '/home/user/app',
      installTimeoutMs: 240_000,
      snippetTimeoutMs: 30_000,
    });
    if (!r.ok) return assertProbe('e2e-fastify-instantiate', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('FASTIFY_TYPE=function')
      && so.includes('FASTIFY_LISTEN=function')
      && so.includes('FASTIFY_GET=function')
      && so.includes('FASTIFY_DECORATE=function')
      && so.includes('FASTIFY_ROUTE_REGISTERED=true');
    return assertProbe('e2e-fastify-instantiate', ok, 'expected fastify + route registration, got:\n' + so, r.output);
  });
}
