#!/usr/bin/env bun
// A facet's filesystem calls are work its program waits on until the session
// answers: answeringSupervisor tells `live` of each as it is made, with the
// call in flight, however it was made. A grant's recall poll, which waits
// for as long as the session has nothing to send, is not told; nor is a
// call that is not a filesystem call (stdin's poll). The resident
// filesystem's own seams, the session's filesystem over the stub and the
// session its holder sends waves to, tell `live` alike.

import assert from 'node:assert/strict';
import { answeringSupervisor, supervisorFilesystem, supervisorSession } from '../../packages/core/src/runtime/vfs-supervisor.ts';

const pending = [];
// An RPC stub's answer is a thenable of its own class, not a Promise.
const stub = {
  answer(name, args) {
    const { promise, resolve } = Promise.withResolvers();
    pending.push({ name, args, resolve });
    return { then: (onValue, onError) => promise.then(onValue, onError) };
  },
  cpReadStdin: () => new Promise(() => {}),
  waves: [],
  openWaveWriter(first) { return new Promise((resolve) => { this.waves.push({ name: 'openWaveWriter', resolve, first }); }); },
  writeBatchStream(stream) { return new Promise((resolve) => { this.waves.push({ name: 'writeBatchStream', resolve, stream }); }); },
  retireWaveWriter(writer) { return new Promise((resolve) => { this.waves.push({ name: 'retireWaveWriter', resolve, writer }); }); },
};
const told = [];
const supervisor = answeringSupervisor(stub, (call) => {
  assert.ok(call instanceof Promise, 'live is told of a promise of this realm, which node\'s tracker can follow');
  const entry = { settled: false };
  told.push(entry);
  Promise.prototype.then.call(call, () => { entry.settled = true; }, () => { entry.settled = true; });
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

// The session's filesystem over the stub (the resident filesystem's authority): each call live, a recall poll not.
const live = (call) => {
  const entry = { settled: false };
  told.push(entry);
  Promise.prototype.then.call(call, () => { entry.settled = true; }, () => { entry.settled = true; });
};
const authority = supervisorFilesystem(stub, undefined, live);
const before = told.length;
const stat = authority.stat('/home/user/a');
assert.equal(told.length, before + 1, 'the authority\'s call is live work');
pending.at(-1).resolve({ value: null });
assert.equal(await stat, null);
assert.equal(told.at(-1).settled, true);
void authority.awaitRecall('owner', 20_000);
assert.equal(told.length, before + 1, 'its recall poll is not');

// The session the holder sends its waves to: each wave call live until answered.
const session = supervisorSession(stub, authority, live);
const opened = session.openWriter(true);
const sent = session.writeBatchStream(new ReadableStream(), undefined, 'owner');
const retired = session.retireWriter('w');
assert.equal(told.length, before + 4, 'a wave call is live work');
assert.deepEqual(stub.waves.map((call) => call.name), ['openWaveWriter', 'writeBatchStream', 'retireWaveWriter']);
for (const call of stub.waves) call.resolve(call.name === 'openWaveWriter' ? 'w' : undefined);
assert.equal(await opened, 'w');
await sent;
await retired;
assert.ok(told.slice(before + 1).every((entry) => entry.settled), 'until the session answers it');
void session.grants.acquire('home/user/proj', true);
assert.equal(told.length, before + 5, 'a grant asked is live work');
void session.grants.awaitRecall('owner', 20_000);
assert.equal(told.length, before + 5, 'its recall poll is not');
console.log('answering-supervisor-live: ok');
