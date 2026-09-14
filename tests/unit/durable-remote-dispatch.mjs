import assert from 'node:assert/strict';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { SUPERVISOR_OPS } from '../../packages/core/src/workspace/supervisor-op.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const calls = [];
const stub = Object.fromEntries(['ExposeApp', 'ListApps', 'RotateLink', 'RemoveApp', 'StartProcess'].map((name) =>
  [`_rpc${name}`, async (...args) => { calls.push({ name, args }); return { dispatched: name }; }]));
const env = { JWT_SECRET: 'unit-durable-remote-secret', NIMBUS_SESSION: {
  idFromName: (name) => name, get: () => stub,
} };
const token = await issueNimbusToken(env, { tn: 'unit', sub: 'owner', scopes: ['sandbox:use'], sid: 'dispatch-test' });
for (const [op, name, args, expected] of [
  ['exposeApp', 'ExposeApp', [{ name: 'web' }, { name: 'api', visibility: 'public' }], [{ name: 'web' }, { name: 'api', visibility: 'public' }]],
  ['listApps', 'ListApps', [], []],
  ['rotateLink', 'RotateLink', [{ owner: 'auto:abc' }], [{ owner: 'auto:abc' }]],
  ['removeApp', 'RemoveApp', [{ pid: 42 }], [{ pid: 42 }]],
  ['startProcess', 'StartProcess', ['node server.js', { restart: 'on-failure' }], ['node server.js', { restart: 'on-failure', cwd: '/home/user' }]],
]) {
  const response = await handleNimbusRemoteApi(new Request('https://unit.test/api/nimbus/v1/sandboxes/dispatch-test/rpc', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op, args }),
  }), env, { remote: true });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { ok: true, result: { dispatched: name } });
  assert.deepEqual(calls.at(-1), { name, args: expected });
  assert.equal(SUPERVISOR_OPS.includes(op), false, 'sandbox authority is never exposed to process facets');
}
console.log('ok - remote sandbox app dispatch (all four verbs + restart), no facet authority escalation');
