#!/usr/bin/env bun
// A facet's filesystem calls are work its program waits on until the session
// answers: answeringSupervisor tells `live` of each as it is made, with the
// call in flight, however it was made. A grant's recall poll, which waits
// for as long as the session has nothing to send, is not told; nor is a
// call that is not a filesystem call (stdin's poll).

import assert from 'node:assert/strict';
import { answeringSupervisor } from '../../packages/core/src/runtime/vfs-supervisor.ts';

const pending = [];
const stub = {
  answer(name, args) {
    const { promise, resolve } = Promise.withResolvers();
    pending.push({ name, args, resolve });
    return promise;
  },
  cpReadStdin: () => new Promise(() => {}),
};
const told = [];
const supervisor = answeringSupervisor(stub, (call) => {
  const entry = { settled: false };
  told.push(entry);
  call.then(() => { entry.settled = true; }, () => { entry.settled = true; });
});

const read = supervisor.fsReadBatch([{ path: '/home/user/a', offset: 0, length: 1 }]);
assert.equal(told.length, 1, 'a filesystem call is live work as it is made');
assert.equal(told[0].settled, false, 'and stays so while the session has not answered');
pending[0].resolve({ value: [{ bytes: new Uint8Array([1]) }] });
assert.deepEqual(await read, [{ bytes: new Uint8Array([1]) }]);
assert.equal(told[0].settled, true, 'until it answers');

void supervisor.fsStorageGrant('proc-slot-0', 1, 2);
assert.equal(told.length, 2, 'a store\'s own call counts as the program\'s does');

void supervisor.fsAwaitRecall('owner', 20_000);
assert.equal(told.length, 2, 'a recall poll is not work the program waits on');
void supervisor.cpReadStdin(7, 1000);
assert.equal(told.length, 2, 'nor is a call that is not a filesystem call');
assert.deepEqual(pending.map((call) => call.name), ['fsReadBatch', 'fsStorageGrant', 'fsAwaitRecall']);
console.log('answering-supervisor-live: ok');
