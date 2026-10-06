#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { ProcessInputStore } from '../../packages/core/src/runtime/process-input.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { ProcessLogStore } from '../../packages/core/src/runtime/process-logs.ts';

const input = new ProcessInputStore({ maxQueuedBytes: 8 });
input.open(7); input.writeBytes(7, new Uint8Array([255, 0, 254]));
input.inherit(8, 7);
assert.deepEqual([...((await input.read(8, 0)).data)], [255, 0, 254], 'inherit includes already queued bytes');
const later = input.read(8, 1000);
input.writeBytes(7, new Uint8Array([128, 129]));
assert.deepEqual([...((await later).data)], [128, 129], 'and future parent writes');
input.close(8);
assert.equal(input.has(7), true, 'closing one fd does not close another reference');
input.inherit(9, 7); input.writeBytes(7, new Uint8Array([1])); input.end(7);
assert.deepEqual([...((await input.read(9, 0)).data)], [1]);
assert.equal((await input.read(9, 0)).ended, true);
assert.equal((await input.read(9, 0)).ended, true, 'EOF repeats');
input.close(7); input.close(9);
input.open(11); input.writeBytes(11, new Uint8Array([1,2,3,4,5])); input.inherit(12,11);
assert.deepEqual([...((await input.read(12,0,2)).data)], [1,2]);
assert.deepEqual([...((await input.read(11,0,2)).data)], [3,4], 'excess stays in the shared channel, not a private guest tail');
assert.deepEqual([...((await input.read(12,0,2)).data)], [5]);
const short = input.read(12,1000,1); input.writeBytes(11,new Uint8Array([9,8,7]));
assert.deepEqual([...((await short).data)], [9]);
assert.deepEqual([...((await input.read(11,0,8)).data)], [8,7]);
input.close(11); input.close(12);

input.open(10);
let finished = false;
const data = new Uint8Array(25).map((_, i) => i);
const writing = input.writeBytesWait(10, data).then((result) => { finished = true; return result; });
for (let i=0; i<20; i++) await null;
assert.equal(finished, false, 'a writer exceeding the named bound blocks while nobody reads');
const received = [];
while (received.length < data.length) received.push(...(await input.read(10, 1000)).data);
assert.deepEqual(received, [...data]); assert.deepEqual(await writing, { ok: true });
const blocked = input.writeBytesWait(10, new Uint8Array(25));
for (let i=0; i<20; i++) await null;
input.close(10); assert.deepEqual(await blocked, { ok: false }, 'closing the reader releases a blocked writer with EPIPE');

const processes = new SessionProcessSupervisor();
const pid = processes.spawn('node', [], '/').pid;
const chunks = [], launch = { signal: new AbortController().signal, write: (_stream, bytes) => chunks.push(bytes) };
const owner = { processes };
const held = FacetManager.prototype._holdForeground.call(owner, pid, launch);
const bytes = new Uint8Array([255, 254, 0, 195, 40]);
await processes.appendOutputBytes(pid, 'stdout', bytes);
assert.deepEqual(chunks.flatMap(c => [...c]), [...bytes], 'foreground writes raw bytes, not decoded text or binary placeholders');
held.release();
const rows = [], persist = {
 load() { return { chunks: rows.map(r => ({...r.chunk,seq:r.seq})), exit:null }; },
 persistChunks(_pid,newRows) { rows.push(...newRows); }, persistExit() {}, dropPid() {}, pruneBeforeSeq() {},
};
const store = new ProcessLogStore({maxChunkBytes:2}); store.setPersist(persist);
await store.appendBytes(7,'stdout',bytes); await store.flush();
assert.deepEqual(store.readBytes(7).chunks.flatMap(c=>[...c.data]),[...bytes]);
const rehydrated = new ProcessLogStore(); rehydrated.setPersist(persist);
assert.deepEqual(rehydrated.readBytes(7).chunks.flatMap(c=>[...c.data]),[...bytes], 'hibernation persists bytes, not a decoded placeholder');
assert.ok(rehydrated.all(7).every(c=>typeof c.data==='string'),'text is a derived view, not the stored representation');
console.log('process-byte-channel: inherited bytes, EOF, bounded writes, close and foreground relay');
