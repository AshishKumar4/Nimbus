import assert from 'node:assert/strict';
import { disposeRpcResource, useRpcResource } from '../../packages/platform/src/rpc-dispose.ts';
import { RPC_DISPOSE_PREAMBLE } from '../../packages/worker/src/loaders/generated-workers.ts';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';

const generated = await import(`data:text/javascript;base64,${Buffer.from(RPC_DISPOSE_PREAMBLE + '\nexport { disposeRpcResource, useRpcResource };').toString('base64')}`);
for (const api of [{ disposeRpcResource, useRpcResource }, generated]) {
  let releases = 0;
  const value = { [Symbol.dispose]() { assert.equal(this, value); releases++; } };
  assert.equal(api.disposeRpcResource(value), true);
  assert.equal(releases, 1);
  assert.equal(await api.useRpcResource(Promise.resolve(value), (received) => received === value), true);
  assert.equal(releases, 2);
  await assert.rejects(api.useRpcResource(Promise.resolve(value), () => { throw new Error('consumer failed'); }), /consumer failed/);
  assert.equal(releases, 3);
  assert.equal(api.disposeRpcResource(null), false);
  assert.equal(api.disposeRpcResource(3), false);
  assert.equal(api.disposeRpcResource({ [Symbol.dispose]() { throw new Error('dispose failed'); } }), false);
}

let releases = 0;
const stat = { type: 'file', size: 1, mtime: 1, mode: 0o644, [Symbol.dispose]() { assert.equal(this, stat); releases++; } };
const box = Nimbus.fromEnv({ NIMBUS_SESSION: {
  idFromName: (name) => ({ name }),
  get: () => ({
    _rpcReady: async () => ({ ok: true, preinstalled: [] }),
    _rpcStat: async () => stat,
  }),
} }).sandbox('job_123');
assert.equal(await box.files.stat('file'), stat);
assert.equal(releases, 1, 'the SDK releases the RPC handle without changing the returned data');
console.log('sdk-rpc-disposal: ok');
