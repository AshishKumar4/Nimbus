#!/usr/bin/env bun
// A session's destroy is repeated once, on a fresh stub, after the two
// platform failures that answered probes' DELETEs 500 on 2026-10-16 (main and
// branches alike): the object reset under it ("Internal error in Durable
// Object storage caused object to be reset") and the platform's undescribed
// failure of the call ("internal error; reference = …"). A destroy is
// idempotent, so the repeat answers with the destroy's result. Any other
// failure is answered as before, with no repeat (router-do-unavailable).
//
// Red before: the first failure was the DELETE's answer, a 500.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const sid = 'steady-heron-4271';
const env = { JWT_SECRET: 'router-destroy-repeat-secret-0123456789abcdef' };
const token = await issueNimbusToken(env, {
  tn: 'tenant', sub: 'owner', sid,
  scopes: ['session:attach', 'session:destroy', 'sandbox:use'],
});
const ctx = { waitUntil() {} };
const handler = createNimbusHandler({ auth: { mode: 'enforce' }, sdk: { remote: true } });
const routes = [
  { label: 'session DELETE', path: `/s/${sid}/`, method: 'DELETE' },
  { label: 'remote destroy', path: `/api/nimbus/v1/sandboxes/${sid}/rpc`, method: 'POST', body: JSON.stringify({ op: 'destroy', args: [{}] }) },
];
const DESTROYED = { ok: true, destroyedAt: 1_800_000_000_000, killed: 0 };

/** The route answered by stubs whose destroys answer `outcomes` in turn: an Error is thrown, anything else returned. */
async function destroy(route, outcomes) {
  let lookups = 0;
  let calls = 0;
  const target = {
    ...env,
    NIMBUS_SESSION: {
      idFromName(name) { return { name }; },
      get() {
        lookups++;
        return {
          async _rpcDestroy() {
            const outcome = outcomes[calls++];
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
        };
      },
    },
  };
  const response = await handler.fetch(new Request(`https://nimbus.test${route.path}`, {
    method: route.method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(route.body ? { body: route.body } : {}),
  }), target, ctx);
  return { response, body: await response.json(), lookups, calls };
}

for (const route of routes) {
  for (const failure of [
    'Internal error in Durable Object storage caused object to be reset; reference = d3str0y',
    'internal error; reference = d3str0y',
  ]) {
    const { response, body, lookups, calls } = await destroy(route, [new Error(failure), DESTROYED]);
    assert.equal(response.status, 200, `${route.label} after "${failure}": ${JSON.stringify(body)}`);
    assert.deepEqual(body.result, DESTROYED, `${route.label}: the repeat's answer is the destroy's`);
    assert.equal(calls, 2, `${route.label}: repeated once`);
    assert.equal(lookups, 2, `${route.label}: the repeat goes to a fresh stub`);
    // Once: a second such failure is the answer, as a failure was before.
    const twice = await destroy(route, [new Error(failure), new Error(failure), DESTROYED]);
    assert.equal(twice.response.status, 500, `${route.label}: a repeated failure answers`);
    assert.equal(twice.calls, 2, `${route.label}: repeated no more than once`);
  }
  // Any other failure answers at once, as before.
  for (const failure of ['unexpected application failure', 'Network connection lost.']) {
    const { response, calls, lookups } = await destroy(route, [new Error(failure), DESTROYED]);
    assert.equal(response.status, 500, `${route.label} after "${failure}"`);
    assert.equal(calls, 1, `${route.label}: "${failure}" is not repeated`);
    assert.equal(lookups, 1);
  }
}

console.log('router-destroy-repeat: ok');
