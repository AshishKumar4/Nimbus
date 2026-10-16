#!/usr/bin/env bun
// The remote API's base path is one contract for its client and its server
// (audit X-12, runtime/remote-http-contract.ts): for each configured path,
// the SDK's Nimbus.connect asks under the path the worker's remote API
// serves, and the two meet. None, or an empty one, is the default; slashes
// alone are '/'; leading and trailing slashes go, inner ones stay. A client
// and a server configured apart do not meet.

import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { handleNimbusRemoteApi, remoteApiBasePath } from '../../packages/worker/src/router/remote-api.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const RESULT = { port: 3000, capability: 'cap', visibility: 'scoped' };
const stub = {
  _rpcReady: async () => ({ ok: true, preinstalled: [] }),
  _rpcEnsureDurableApp: async () => RESULT,
};
const env = { JWT_SECRET: 'unit-base-path-secret', NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } };
const token = await issueNimbusToken(env, { tn: 'unit', sub: 'owner', scopes: ['sandbox:use'], sid: 'box' });

/** The SDK configured with `client`, the server with `server`: the paths asked, and whether every request was routed. */
async function meet(client, server) {
  const asked = [];
  const sdk = { remote: { enabled: true, ...(server === undefined ? {} : { basePath: server }) } };
  const box = Nimbus.connect({
    endpoint: 'https://unit.test/', token, ...(client === undefined ? {} : { basePath: client }),
    fetch: async (url, init) => {
      asked.push(new URL(url).pathname);
      return await handleNimbusRemoteApi(new Request(url, init), env, sdk) ?? new Response('not routed', { status: 404 });
    },
  }).sandbox('box');
  const routed = await box.ports.ensureDurableApp({ owner: 'auto:web' }).then((result) => {
    assert.deepEqual(result, RESULT);
    return true;
  }, () => false);
  return { asked: [...new Set(asked)], served: remoteApiBasePath(sdk), routed };
}

for (const [configured, base] of [
  [undefined, '/api/nimbus/v1'],
  ['', '/api/nimbus/v1'],
  ['/', '/'],
  ['///', '/'],
  ['api/nimbus/v1/', '/api/nimbus/v1'],
  ['/custom//path/', '/custom//path'],
  ['x', '/x'],
]) {
  const { asked, served, routed } = await meet(configured, configured);
  assert.deepEqual(asked, [`${base}/sandboxes/box/rpc`], `${JSON.stringify(configured)}: the SDK asks under ${base}`);
  assert.equal(served, base, `${JSON.stringify(configured)}: the server serves under ${base}`);
  assert.equal(routed, true, `${JSON.stringify(configured)}: they meet`);
}
assert.equal((await meet('/a', '/b')).routed, false, 'a client and a server configured apart do not meet');
assert.equal((await meet(undefined, '/api/nimbus/v1/')).routed, true, 'the default and its spelled-out form meet');
console.log('ok - remote-base-path (the SDK and the remote API route each configured base path alike)');
