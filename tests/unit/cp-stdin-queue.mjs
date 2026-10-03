#!/usr/bin/env bun
// What a parent writes to a child's stdin is read once. A reader already
// waiting when the write lands (the Node runtime's stdin pump long-polls)
// takes that chunk off the queue, so the next read does not see it again;
// a reader waiting when the child exits is told stdin ended.
import assert from 'node:assert/strict';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const processes = new SessionProcessSupervisor();
const parent = processes.spawn('node', ['parent.js'], '/home/user');
const exits = new Map();
const manager = new FacetProcessManager({
  processes,
  vfsForProcess() { throw new Error('no script file is read'); },
  commandRegistry: { resolve() { return { kind: 'facet-direct' }; } },
  facetMgr: {
    async execStream(payload) {
      const { processPid } = JSON.parse(payload);
      return await new Promise((resolve) => exits.set(processPid, resolve));
    },
  },
});
const spawn = async () => (await manager.spawn({ parentPid: parent.pid, command: 'node', args: ['reader.js'], cwd: '/home/user', env: {}, stdio: ['pipe', 'pipe', 'pipe'] })).childPid;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const text = (packet) => [decoder.decode(packet.data), packet.ended];

{
  const childPid = await spawn();
  await settle();
  const waiting = manager.cpReadStdin(childPid, 1000);
  await settle();
  manager.stdinWrite(childPid, encoder.encode('once'));
  assert.deepEqual(text(await waiting), ['once', false], 'the waiting reader takes the chunk');
  manager.stdinWrite(childPid, encoder.encode('next'));
  manager.stdinEnd(childPid);
  assert.deepEqual(text(await manager.cpReadStdin(childPid, 1000)), ['next', false], 'and the next read takes the next one');
  assert.deepEqual(text(await manager.cpReadStdin(childPid, 1000)), ['', true], 'then the end');
  exits.get(childPid)(0);
}

{
  const childPid = await spawn();
  await settle();
  const waiting = manager.cpReadStdin(childPid, 1000);
  await settle();
  exits.get(childPid)(0);
  assert.deepEqual(text(await waiting), ['', true], 'a reader waiting when the child exits is told stdin ended');
}

console.log('cp-stdin-queue: each chunk read once, end on close and on exit');
