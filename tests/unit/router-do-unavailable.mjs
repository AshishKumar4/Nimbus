#!/usr/bin/env bun
// Public router boundaries preserve platform unavailability, not an opaque
// 500. Classify the rejection once; neither boundary repeats the operation.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const sid = 'nimble-otter-4271';
const env = { JWT_SECRET: 'router-do-unavailable-secret-0123456789abcdef' };
const token = await issueNimbusToken(env, {
  tn: 'tenant', sub: 'owner', sid,
  scopes: ['session:attach', 'session:destroy', 'sandbox:use'],
});
const ctx = { waitUntil() {} };
const handler = createNimbusHandler({ auth: { mode: 'enforce' }, sdk: { remote: true } });
const routes = [
  { label: 'terminal upgrade', path: `/s/${sid}/ws`, method: 'GET', headers: { Upgrade: 'websocket' }, operation: 'fetch' },
  { label: 'session DELETE', path: `/s/${sid}/`, method: 'DELETE', operation: '_rpcDestroy', cors: true },
  { label: 'remote RPC', path: `/api/nimbus/v1/sandboxes/${sid}/rpc`, method: 'POST', body: JSON.stringify({ op: 'bootProbe' }), operation: '_rpcBootProbe', cors: true },
];
const cases = [
  { label: 'opaque platform overload', make: () => Object.assign(new Error('internal error; reference = platform-overload'), { overloaded: true }), code: 'E_NIMBUS_DO_OVERLOADED' },
  { label: 'code-update reset', make: () => Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true }), code: 'E_NIMBUS_DO_CODE_UPDATED' },
  { label: 'upgraded script', make: () => new Error('This script has been upgraded.'), code: 'E_NIMBUS_DO_CODE_UPDATED' },
  { label: 'overload vetoes retryable reset', make: () => Object.assign(new Error('Durable Object reset because its code was updated.'), { overloaded: true, retryable: true }), code: 'E_NIMBUS_DO_OVERLOADED' },
  { label: 'wrapped overload', make: () => new Error('DO call failed', { cause: Object.assign(new Error('internal error; reference = nested-overload'), { overloaded: true }) }), code: 'E_NIMBUS_DO_OVERLOADED' },
];

async function request(route, failure) {
  let lookups = 0, calls = 0;
  const stub = {
    async [route.operation]() { calls++; throw failure; },
  };
  const target = {
    ...env,
    NIMBUS_SESSION: {
      idFromName(name) { assert.equal(name, `tenant:owner:${sid}`); return { name }; },
      get() { lookups++; return stub; },
    },
  };
  const response = await handler.fetch(new Request(`https://nimbus.test${route.path}`, {
    method: route.method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...route.headers },
    ...(route.body ? { body: route.body } : {}),
  }), target, ctx);
  assert.equal(lookups, 1, `${route.label}: one fresh stub, no retry`);
  assert.equal(calls, 1, `${route.label}: the operation is never retried`);
  return response;
}

const failures = [];
for (const test of cases) {
  for (const route of routes) {
    const response = await request(route, test.make());
    const body = await response.text();
    if (response.status !== 503) {
      failures.push(`${test.label}, ${route.label}: expected 503, got ${response.status}: ${body}`);
      continue;
    }
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
    assert.match(response.headers.get('Retry-After') ?? '', /^\d+$/);
    assert.ok(Number(response.headers.get('Retry-After')) >= 1);
    assert.equal(JSON.parse(body).ok, false);
    assert.equal(JSON.parse(body).code, test.code);
    if (route.cors) assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  }
}
assert.deepEqual(failures, [], 'every public DO boundary classifies platform unavailability');

// Other failures retain their existing answers; a generic retryable flag is
// not sufficient to label a code update, and application refusals are not 503.
for (const route of routes) {
  for (const make of [
    () => new Error('unexpected application failure'),
    () => Object.assign(new Error('network connection lost'), { retryable: true }),
  ]) {
    const response = await request(route, make());
    assert.equal(response.status, 500, route.label);
    assert.equal(response.headers.get('Retry-After'), null);
    if (route.cors) assert.equal((await response.json()).code, 'E_NIMBUS_REMOTE_RPC');
    else assert.equal(await response.text(), 'Internal error');
  }
}
const busy = await request(routes[1], Object.assign(new Error('session is busy'), { code: 'EBUSY', httpStatus: 409 }));
assert.equal(busy.status, 409);
assert.equal((await busy.json()).code, 'EBUSY');
console.log('router-do-unavailable: ok');
