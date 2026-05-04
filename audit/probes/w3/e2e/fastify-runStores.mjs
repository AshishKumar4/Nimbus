// W3 e2e — fastify route registration exercises diagnostics_channel.runStores
//
// Review C2: fastify@5 calls channel.runStores at request-handler init.
// This probe registers a route to ensure the runStores path is exercised
// at module-load + route-register time, not just at incoming-request time.

import { execProbe } from '../_helpers.mjs';

export default function e2e_fastify_runStores() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-fastify-runStores', `
      const fastify = require('fastify');
      const app = fastify();
      app.get('/hello', async (req, reply) => ({ ok: true }));
      console.log('FRS_ROUTE_REGISTERED=true');
      // Inject a synthetic request to exercise the request handler's runStores path
      app.inject({ method: 'GET', url: '/hello' }).then((res) => {
        console.log('FRS_INJECT_STATUS=' + res.statusCode);
        console.log('FRS_INJECT_BODY=' + res.body);
      }).catch((e) => {
        console.log('FRS_INJECT_ERROR=' + (e && (e.code || e.message)));
      });
    `, {
      preCmds: ['cd app && npm install fastify'], runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('e2e-fastify-runStores', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('FRS_ROUTE_REGISTERED=true')
      && so.includes('FRS_INJECT_STATUS=200')
      && so.includes('FRS_INJECT_BODY={"ok":true}');
    return assertProbe('e2e-fastify-runStores', ok, 'expected fastify inject success, got:\n' + so, r.output);
  });
}
