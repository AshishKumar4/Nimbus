// Quotas belong to the native transport, not a second guest-side counter.
import assert from 'node:assert/strict';
import { answeringSupervisor } from '../../packages/core/src/runtime/vfs-supervisor.ts';

const calls = [], charges = [];
let remaining = 8;
const send = (method, result) => {
  if (!remaining) throw Object.assign(new Error('native subrequest quota exhausted'), { code: 'ERR_NIMBUS_SUBREQUEST_BUDGET' });
  remaining--;
  charges.push(method);
  calls.push(method);
  return result;
};
const native = {
  async answer(method) { return send('answer:' + method, { value: 1 }); },
  async stdout() { return send('stdout'); },
  async openWaveWriter() { return send('openWaveWriter', 'epoch'); },
  async writeBatchStream() { return send('writeBatchStream', { applied: true }); },
  async fsAcquireExclusiveMutation() { return send('fsAcquireExclusiveMutation', {}); },
  async cpReadStdin() { return send('cpReadStdin', { data: new Uint8Array(), ended: false }); },
};
const supervisor = answeringSupervisor(answeringSupervisor(native));
await supervisor.stat('file');
await supervisor.stdout(new Uint8Array([255]));
await supervisor.openWaveWriter(true);
await supervisor.writeBatchStream(new ReadableStream({ start(controller) { controller.close(); } }));
await supervisor.fsAcquireExclusiveMutation('tree', { delegate: true });
await supervisor.cpReadStdin(1, 0);
await supervisor.writeBatchStream(new ReadableStream({ start(controller) { controller.close(); } }));
await supervisor.stdout(new Uint8Array([254]));
assert.equal(charges.length, 8, 'nested answered/raw wrappers dispatch one native RPC each');
assert.deepEqual(charges, calls);
await assert.rejects(supervisor.stdout(new Uint8Array([253])), { code: 'ERR_NIMBUS_SUBREQUEST_BUDGET' });
assert.equal(calls.length, 8, 'native refusal prevents a ninth transport dispatch');
