#!/usr/bin/env bun
// A session's destroy is repeated once, on a fresh stub, after the two
// platform failures that answered probes' DELETEs 500 on 2026-10-16 (main and
// branches alike), as the one classifier (classifyDoCall) names them: the
// object reset under it (storage_reset), and the platform's failure without
// a cause (platform_internal). Each is the destroy's own error, the storage
// wipe's failure carried as its cause. A destroy is idempotent, so the
// repeat answers with the destroy's result. Any other class answers as
// before, with no repeat: a code update or an overloaded object its 503
// (router-do-unavailable), anything else its 500.
//
// Red before: the destroy's wrapped platform error was answered 500, and a
// wrapped code update was repeated instead of answered 503.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';

/** The error the session's destroy throws when its storage wipe fails with `failure`. */
async function destroyFailure(failure) {
  const self = {
    ensureSqliteFs() {},
    ensureFacetManager() { this.facetManager ??= { async closeLaunches() {} }; return { manager: this.facetManager }; },
    sqliteFs: {
      publishedFor: () => null, cancelStreams() {}, hasExclusiveMutation: () => false,
      seizeGlobalExclusiveMutation: () => ({ root: '', owner: 'destroy-owner' }),
      releaseExclusiveMutation() {},
    },
    processes: { getAll: () => [], flushLogs() {}, closeAdmission() {}, sessionCred: CRED_SESSION_USER },
    portRegistry: {},
    ctx: { getWebSockets: () => [], storage: { async deleteAll() { throw failure; } } },
  };
  try {
    await rpcDestroy(self);
  } catch (error) {
    return error;
  }
  throw new Error('the destroy did not fail');
}

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
    new Error('Internal error in Durable Object storage caused object to be reset; reference = d3str0y'),
    new Error('internal error; reference = d3str0y'),
  ]) {
    const thrown = await destroyFailure(failure);
    const { response, body, lookups, calls } = await destroy(route, [thrown, DESTROYED]);
    assert.equal(response.status, 200, `${route.label} after "${thrown.message}": ${JSON.stringify(body)}`);
    assert.deepEqual(body.result, DESTROYED, `${route.label}: the repeat's answer is the destroy's`);
    assert.equal(calls, 2, `${route.label}: repeated once`);
    assert.equal(lookups, 2, `${route.label}: the repeat goes to a fresh stub`);
    // Once: a second such failure is the answer, as a failure was before.
    const twice = await destroy(route, [thrown, thrown, DESTROYED]);
    assert.equal(twice.response.status, 500, `${route.label}: a repeated failure answers`);
    assert.equal(twice.calls, 2, `${route.label}: repeated no more than once`);
  }
  // A code update, however wrapped, is its 503: never repeated.
  for (const failure of [
    new Error('internal error; reference = outer', { cause: new Error('This script has been upgraded. Please send a new request to connect to the new version.') }),
    await destroyFailure(new Error('Durable Object reset because its code was updated.')),
  ]) {
    const { response, body, calls } = await destroy(route, [failure, DESTROYED]);
    assert.equal(response.status, 503, `${route.label} after "${failure.message}": ${JSON.stringify(body)}`);
    assert.equal(calls, 1, `${route.label}: a code update is not repeated`);
  }
  // Any other failure answers at once, as before.
  for (const failure of ['unexpected application failure', 'Network connection lost.']) {
    const { response, calls, lookups } = await destroy(route, [await destroyFailure(new Error(failure)), DESTROYED]);
    assert.equal(response.status, 500, `${route.label} after "${failure}"`);
    assert.equal(calls, 1, `${route.label}: "${failure}" is not repeated`);
    assert.equal(lookups, 1);
  }
}

console.log('router-destroy-repeat: ok');
