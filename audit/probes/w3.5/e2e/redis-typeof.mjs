// W3.5 e2e — npm install redis; require it; surface check (no connection).
//
// Sibling of fastify directory-as-index bug (audit/probes/packages-prod-w26a/redis.out.txt:43):
//   Cannot read module: home/user/app/node_modules/@redis/client/dist/lib/client
//
// Post-fix expectation: same as fastify — strict-file probe in __resolveFile
// falls back to /index.js for the directory require.
//
// Asserts:
//   - typeof require('redis').createClient === 'function'
// Does NOT attempt any network connection (out of scope; W8 territory).

import { execProbe } from '../_helpers.mjs';

export default function e2e_redis_typeof() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-redis-typeof', `
      const redis = require('redis');
      console.log('REDIS_TYPE=' + (typeof redis));
      console.log('REDIS_CREATE_CLIENT=' + (typeof redis.createClient));
      console.log('REDIS_KEYS=' + Object.keys(redis).slice(0, 8).sort().join(','));
    `, {
      preCmds: ['cd app && npm install redis'],
      runInDir: '/home/user/app',
      installTimeoutMs: 240_000,
      snippetTimeoutMs: 30_000,
    });
    if (!r.ok) return assertProbe('e2e-redis-typeof', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('REDIS_CREATE_CLIENT=function');
    return assertProbe('e2e-redis-typeof', ok, 'expected redis.createClient to be a function, got:\n' + so, r.output);
  });
}
