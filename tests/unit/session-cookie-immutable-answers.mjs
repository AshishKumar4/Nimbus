#!/usr/bin/env bun
// The policy appends only to a mutable copy: the harness's own ASSETS and DO
// fetches arrive with immutable headers, as real fetched answers do. Covers
// shell HTML and a 101 upgrade (whose webSocket must survive the copy).
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const context = { waitUntil() {} };
const freeze = (response) => {
  const headers = response.headers;
  headers.append = () => { throw new TypeError("Can't modify immutable headers."); };
  return response;
};
const setup = () => {
  const env = {
    JWT_SECRET: 'cookie-immutable-answers-key',
    NIMBUS_SESSION: {
      idFromName(name) { return { name }; },
      get() {
        return {
          fetch: async (request) => {
            const url = new URL(request.url);
            if (request.headers.get('Upgrade') === 'websocket') {
              return freeze(new Response(null, {
                status: 101,
                headers: { Upgrade: 'websocket', 'Cache-Control': 'no-store' },
                // @ts-expect-error harness stand-in for the DO's accepted socket
                webSocket: { marker: 'accepted-hmr-socket' },
              }));
            }
            return freeze(Response.json({ path: url.pathname }));
          },
          _rpcConsumeAttachBootstrap: async () => true,
        };
      },
    },
    ASSETS: { fetch: async () => freeze(new Response('<html>shell</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })) },
  };
  return { env, router: createNimbusHandler({ auth: { mode: 'enforce' } }) };
};
const failures = [];
const cases = [
  ['legacy migration on immutable shell HTML', async () => {
    const { env, router } = setup();
    const legacy = await issueNimbusToken(env, { tn: 't', sub: 'u', sid: 'shell-sid', scopes: ['session:attach'] });
    const res = await router.fetch(new Request('https://immutable.test/s/shell-sid/', {
      headers: { Cookie: `__Host-nimbus_token=${legacy}` },
    }), env, context);
    assert.equal(res.status, 200);
    const set = res.headers.getSetCookie();
    assert.ok(set.some((v) => v.startsWith('__Host-nimbus_token-shell-sid=')), 'route name issued');
    assert.ok(set.some((v) => v.startsWith('__Host-nimbus_token=;') && /Max-Age=0/.test(v)), 'legacy expired');
    assert.match(res.headers.get('Content-Type') ?? '', /^text\/html/);
  }],
  ['legacy migration on an immutable 101 upgrade keeps the socket', async () => {
    const { env, router } = setup();
    const legacy = await issueNimbusToken(env, { tn: 't', sub: 'u', sid: 'ws-sid', scopes: ['session:attach'] });
    const res = await router.fetch(new Request('https://immutable.test/s/ws-sid/ws', {
      headers: { Cookie: `__Host-nimbus_token=${legacy}`, Upgrade: 'websocket' },
    }), env, context);
    assert.equal(res.status, 101);
    assert.equal(res.webSocket?.marker, 'accepted-hmr-socket');
    assert.ok(res.headers.getSetCookie().some((v) => v.startsWith('__Host-nimbus_token-ws-sid=')));
  }],
];
for (const [label, run] of cases) {
  try { await run(); console.log(`PASS ${label}`); }
  catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error.message}`); }
}
assert.deepEqual(failures, [], 'immutable fetched answers migrate without throwing');
