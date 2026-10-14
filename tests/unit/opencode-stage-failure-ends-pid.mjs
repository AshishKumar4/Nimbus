#!/usr/bin/env bun
// A staged opencode launch whose preparation fails ends the process it spawned.
//
// _stageOpencodeFacet spawns the process-table entry first, then snapshots the
// working tree and serializes it. A snapshot can fit the raw bound and still
// serialize past the RPC payload ceiling: sixteen 1 MiB files of quotes are
// 16 MiB raw and 32 MiB as JSON strings. That refusal was thrown before any
// caller's cleanup began, so the launch failed and its pid stayed 'running'
// for a process that never started, under every disposition. Red before: the
// opencode entry was still running after each refusal.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = 'home/user/proj';
const { host, rawVfs, kfs } = createAuthority();
kfs.mkdir(ROOT, { recursive: true, mode: 0o755 });
const quotes = '"'.repeat(1024 * 1024);
for (let i = 0; i < 16; i++) kfs.writeFile(`${ROOT}/data-${i}.txt`, quotes);
const fm = oneShotManager('opencode-stage-failure-ends-pid', { host, rawVfs, loader: runnerLoader('opencode-stage-failure-ends-pid') });

const opts = { argv: ['run', 'hello'], env: {}, cwd: `/${ROOT}` };
const launches = {
  'one-shot': () => fm.execStagedArtifact('opencode', opts),
  attached: () => fm.execStagedArtifact('opencode', { ...opts, argv: [], attachedTty: true }),
  server: () => fm.execStagedArtifactServer('opencode', { ...opts, argv: ['serve'] }),
  'serve and attach': () => fm.execStagedArtifactDual('opencode', { ...opts, argv: [] }),
};

for (const [disposition, launch] of Object.entries(launches)) {
  const before = new Set(host.processes.getAll().map((entry) => entry.pid));
  await assert.rejects(launch(), /RPC payload ceiling/, `${disposition}: the snapshot is refused`);
  const spawned = host.processes.getAll().filter((entry) => !before.has(entry.pid));
  assert.equal(spawned.length, 1, `${disposition}: the launch spawned its process before it prepared it`);
  const [{ pid, state, exitCode }] = spawned;
  assert.notEqual(state, 'running', `${disposition}: pid ${pid} is not left running after its preparation failed`);
  assert.equal(exitCode, 1, `${disposition}: pid ${pid} exits 1`);
  // The exit record is written behind the output before it.
  let exit = null;
  for (let turn = 0; turn < 100 && exit === null; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    exit = host.processes.getExit(pid);
  }
  assert.match(exit?.reason ?? '', /RPC payload ceiling/, `${disposition}: its exit names why it never started (${JSON.stringify(exit)})`);
}
assert.deepEqual(host.processes.getRunning().filter((entry) => entry.argv[0] === 'opencode'), [], 'no opencode process is left running');

console.log('opencode-stage-failure-ends-pid: every disposition ends the pid its failed preparation spawned');
