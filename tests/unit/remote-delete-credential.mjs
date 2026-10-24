import assert from 'node:assert/strict';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

// A remote token authenticates the session's user, so its deletion names no
// credential and acts as that user, with the groups its host gave it (Kinu
// ask 73), as its write, chmod and rename do (supervisor-op credFor); the
// caller can name none.
const calls = [];
const stub = { _rpcDeleteFile: async (...args) => { calls.push(args); } };
const env = { JWT_SECRET: 'unit-remote-delete-secret', NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } };
const token = await issueNimbusToken(env, { tn: 'unit', sub: 'owner', scopes: ['sandbox:use'], sid: 'delete-test' });
const call = (args) => handleNimbusRemoteApi(new Request('https://unit.test/api/nimbus/v1/sandboxes/delete-test/rpc', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'deleteFile', args }),
}), env, { remote: true });

for (const args of [['/home/user/a.txt'], ['/home/user/dir', { recursive: true }]]) {
  const response = await call(args);
  assert.equal(response.status, 200, await response.clone().text());
  const [path, options, cred] = calls.at(-1);
  assert.equal(path, args[0]);
  assert.deepEqual(options, args[1] ?? {});
  assert.equal(cred, undefined, 'a remote deletion acts as the session user, as the session has it');
}

// A caller still cannot name the identity it deletes as.
const refused = await call(['/etc/hosts', { cred: CRED_KERNEL }]);
assert.equal(refused.status, 400);
assert.equal(calls.length, 2, 'a refused deletion reaches no session');
console.log('ok - remote deleteFile acts as the session user and refuses a named credential');
