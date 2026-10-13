// The version that answered rides the replies a deploy's readiness reads,
// from createNimbusHandler itself, so every app built on it is gradeable the
// same way; no other reply is rebuilt.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';

const NIMBUS_VERSION_HEADER = 'x-nimbus-version';

const suffix = 'preview.example.test';
const env = {
  JWT_SECRET: 'unit-version-stamp-secret-0123456789abcdef',
  NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
  CF_VERSION_METADATA: { id: 'version-new' },
};
const ctx = { waitUntil() {} };
const handler = createNimbusHandler({ auth: { mode: 'enforce' }, sdk: { remote: true } });
const answer = (url, init = {}, withEnv = env) => handler.fetch(new Request(url, init), withEnv, ctx);

// Every readiness reply, unauthenticated: none needs a session or account state.
for (const [what, url, init] of [
  ['POST /new', 'https://app.test/new', { method: 'POST' }],
  ['the terminal upgrade', 'https://app.test/s/sid-1/ws', { headers: { Upgrade: 'websocket' } }],
  ['DELETE /s/<id>/', 'https://app.test/s/sid-1/', { method: 'DELETE' }],
  ['the remote API', 'https://app.test/api/nimbus/v1/sandboxes/nimbus-readiness/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
]) {
  const response = await answer(url, init);
  assert.equal(response.status, 401, `${what}: refused before any session`);
  assert.equal(response.headers.get(NIMBUS_VERSION_HEADER), 'version-new', `${what} names the version that answered`);
}

// Not a readiness reply: left as it is.
for (const [what, url, init] of [
  ['the session shell', 'https://app.test/s/sid-1/', {}],
  ['an unclaimed path', 'https://app.test/pricing', {}],
  ["a preview host's own /new", `https://3000--sid-1.${suffix}/new`, { method: 'POST' }],
]) {
  const response = await answer(url, init);
  assert.equal(response.headers.get(NIMBUS_VERSION_HEADER), null, `${what} is not stamped`);
}

// Without the binding nothing is stamped.
const unbound = await answer('https://app.test/new', { method: 'POST' }, { ...env, CF_VERSION_METADATA: undefined });
assert.equal(unbound.headers.get(NIMBUS_VERSION_HEADER), null);
console.log('router-version-stamp: ok');
