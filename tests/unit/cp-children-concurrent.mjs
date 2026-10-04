#!/usr/bin/env bun
// Children of one session run beside each other, as Node's do, and a kill
// ends the work behind the child at once. What has to hold:
//
//   (1) a child that never exits holds nothing a later child needs: the
//       later one runs and exits while the first still runs;
//   (2) killing a child runs the terminator its launch registered on its pid
//       (a facet program's run is aborted there, which gives its Dynamic
//       Worker back), stamps the signal's status, and wakes its waiters;
//       the table records it killed;
//   (3) N children spawned together all run at once and all complete.
//
// The facet program here stands in for FacetManager.exec: it registers its
// abort as the pid's terminator, as exec does for the caller's pid, and ends
// 130 when aborted. Before, kill stamped the exit through exit(), which
// drops the terminator without running it, so the program ran on.

import assert from 'node:assert/strict';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const processes = new SessionProcessSupervisor();
const parent = processes.spawn('node', ['parent.js'], '/home/user');

/** pid → the facet program's run: running, how it ended, and how the test ends it. */
const runs = new Map();
const manager = new FacetProcessManager({
  processes,
  vfsForProcess() { throw new Error('no script file is read'); },
  commandRegistry: { async resolve() { return { kind: 'facet-direct' }; } },
  facetMgr: {
    async execStream(payload, _options, hooks) {
      const { processPid, args } = JSON.parse(payload);
      const run = { running: true, ended: null };
      runs.set(processPid, run);
      const aborted = new Promise((resolve) => processes.setTerminator(processPid, () => resolve('aborted')));
      const exited = new Promise((resolve) => { run.exit = () => resolve('exited'); });
      if (args[0] === 'quick') run.exit();
      hooks.onStdout(encoder.encode(`${args[1]} ran\n`));
      run.ended = await Promise.race([aborted, exited]);
      run.running = false;
      return run.ended === 'aborted' ? 130 : 0;
    },
  },
});
const spawn = async (...args) => (await manager.spawn({
  parentPid: parent.pid, command: 'node', args, cwd: '/home/user', env: {}, stdio: ['pipe', 'pipe', 'pipe'],
})).childPid;
const stdout = async (pid) => decoder.decode(Buffer.concat((await manager.readOutput(pid, 1, 0, 0)).chunks.map((c) => c.data)));
const until = async (what, done, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

// ── (1) a later child runs while an earlier one never exits ─────────────────
const a = await spawn('forever', 'A');
await until('A starts', () => runs.get(a)?.running);
const b = await spawn('quick', 'B');
const bExit = await manager.wait(b, 1000);
assert.deepEqual(bExit, { done: true, exitCode: 0, signal: null }, 'B exits while A still runs');
assert.equal(await stdout(b), 'B ran\n');
assert.equal(runs.get(a).running, true, 'A is still running');

// ── (2) a kill ends the work behind the pid, at once ────────────────────────
const waiting = manager.wait(a, 5000);
assert.equal(manager.kill(a, 'SIGTERM'), true);
assert.deepEqual(await waiting, { done: true, exitCode: 143, signal: 'SIGTERM' }, 'the waiter wakes with the signal status');
await until("A's run ends", () => !runs.get(a).running, 200);
assert.equal(runs.get(a).ended, 'aborted', "the kill ran A's terminator: its run was aborted, not left to run on");
assert.equal(processes.get(a).state, 'killed', 'the table records A killed');
assert.equal(processes.get(a).exitCode, 143);
assert.equal(manager.kill(a, 'SIGTERM'), false, 'a second kill finds nothing to kill');
const c = await spawn('quick', 'C');
assert.equal((await manager.wait(c, 1000)).exitCode, 0, 'and the next child runs');

// ── (3) N together: all at once, all complete ───────────────────────────────
const N = 12;
const pids = await Promise.all(Array.from({ length: N }, (_, i) => spawn('forever', `N${i}`)));
await until('all N run at once', () => pids.every((pid) => runs.get(pid)?.running));
for (const pid of pids) runs.get(pid).exit();
const exits = await Promise.all(pids.map((pid) => manager.wait(pid, 1000)));
assert.deepEqual(exits.map((e) => e.exitCode), pids.map(() => 0), 'every one exits 0');
assert.deepEqual(await Promise.all(pids.map(stdout)), pids.map((_, i) => `N${i} ran\n`), 'each with its own output');

console.log('ok - cp-children-concurrent (a later child runs beside a live one, a kill aborts the run behind the pid, N run at once)');
