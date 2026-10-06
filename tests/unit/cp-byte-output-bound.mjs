#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
const processes = new SessionProcessSupervisor();
const parent = processes.spawn('parent', [], '/').pid;
let written = 0, stopped = false;
const bytes = new Uint8Array(65536).map((_, i) => i & 255);
const broker = new FacetProcessManager({ processes, vfsForProcess() {}, facetMgr: { kill() { return true; } },
  commandRegistry: { async resolve() { return { kind: 'pure-builtin' }; }, async runPureBuiltin(_pid, _name, _args, _env, _cwd, _stdin, hooks) {
    try { for (let i=0; i<12; i++) { await hooks.onStdout(bytes); written++; } }
    catch (e) { assert.equal(e.code, 'EPIPE'); stopped = true; }
    return 0;
  } },
});
const { childPid } = await broker.spawn({ parentPid: parent, command: 'producer', args: [], env: {}, cwd: '/', stdio: ['pipe','pipe','ignore'] });
await new Promise(r => setTimeout(r, 30));
assert.ok(written > 0 && written <= 4, 'a producer is held at the named 256 KiB output bound when its reader never reads');
let seq = 0, total = 0;
for (;;) {
  const result = await broker.readOutput(childPid, 1, seq, 1000);
  for (const chunk of result.chunks) { assert.deepEqual(chunk.data, bytes); total += chunk.data.length; }
  seq = result.maxSeq;
  if (result.closed) break;
}
assert.equal(total, 12 * bytes.length); assert.equal(written, 12);
const second = await broker.spawn({ parentPid: parent, command: 'producer', args: [], env: {}, cwd: '/', stdio: ['ignore','pipe','ignore'] });
await new Promise(r => setTimeout(r, 30));
broker.kill(second.childPid, 'SIGKILL');
await new Promise(r => setTimeout(r, 30));
assert.equal(stopped, true, 'a reader disappearing releases its blocked writer with EPIPE');
stopped = false;
const third = await broker.spawn({ parentPid: parent, command: 'producer', args: [], env: {}, cwd: '/', stdio: ['ignore','pipe','ignore'] });
await new Promise(r => setTimeout(r,30));
processes.markExit(parent,0);
await new Promise(r => setTimeout(r,30));
assert.equal(stopped,true,'a parent that exits without reading cannot leave an output writer blocked forever');
assert.equal((await broker.wait(third.childPid,0)).done,true);
console.log('cp-byte-output-bound: writer waits for room, ordered bytes, close releases wait');
