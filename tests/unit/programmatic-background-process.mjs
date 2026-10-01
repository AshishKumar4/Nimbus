#!/usr/bin/env bun

// startProcess must background: return a live handle immediately, keep
// streaming output into the process log ring, record the exit when the
// command finishes, and terminate on kill. exec keeps its foreground
// contract, and the two must not steal each other's output.

import assert from 'node:assert/strict';

import { programmaticHost } from './lib/programmatic-host.mjs';
import {
  rpcExec,
  rpcKillProcess,
  rpcProcessLogs,
  rpcSignalProcess,
  rpcStartProcess,
} from '../../packages/worker/src/session/programmatic.ts';

// `sleep` ends when the test wakes it (or on abort), never on a clock, so
// every "before it finished" below is an ordering, not a timing. `spawner`
// writes its output to a child's ring, not to the caller's streams: the
// npm-bin / facet-backed runtime shape.
const opened = [];
async function makeHost() {
  const sleepers = [];
  const box = await programmaticHost({
    commands: {
      async sleep(ctx) {
        await ctx.stdout.write('starting\n');
        const aborted = await new Promise((resolve) => {
          sleepers.push(() => resolve(false));
          ctx.signal.addEventListener('abort', () => resolve(true), { once: true });
        });
        if (aborted) return 130;
        await ctx.stdout.write('woke\n');
        return 0;
      },
      async spawner(ctx) {
        const child = box.ws.processes.spawn(`spawner ${ctx.args[0]}`, ['spawner'], '/home/user', { parentPid: ctx.pid });
        box.ws.processes.appendOutput(child.pid, 'stdout', `child of ${ctx.args[0]}\n`);
        box.ws.processes.exit(child.pid, 0);
        return 0;
      },
    },
  });
  opened.push(box);
  return Object.assign(box.host, {
    held: box.held,
    /** Wake every sleeping `sleep`. */
    wake() { for (const wake of sleepers.splice(0)) wake(); },
    /** Until a `sleep` is asleep: it has written its first line and waits. */
    async asleep() {
      for (let i = 0; i < 500 && sleepers.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(sleepers.length > 0, 'the sleep started');
    },
  });
}

// ── startProcess returns before the process completes ────────────────────
{
  const host = await makeHost();
  // Returns while its command still sleeps: nothing has woken it.
  const started = await rpcStartProcess(host, 'sleep 1');
  assert.equal(typeof started.pid, 'number');
  assert.equal(started.process.state, 'running');
  assert.equal(started.process.longRunning, true);
  assert.equal(host.held.length, 1, 'the session holds the background work open');

  // Incremental output is readable while the process is still running.
  await host.asleep();
  const early = await rpcProcessLogs(host, started.pid);
  assert.equal(early.text, 'starting\n');
  assert.equal(early.exit, null);
  assert.equal(host.processes.get(started.pid).state, 'running');

  host.wake();
  await host.held[0];

  const done = await rpcProcessLogs(host, started.pid);
  assert.equal(done.text, 'starting\nwoke\n');
  assert.deepEqual(
    { state: host.processes.get(started.pid).state, code: done.exit?.code },
    { state: 'exited', code: 0 },
    'the handle reports completion once the command finishes',
  );
}

// ── kill terminates a running background process ─────────────────────────
{
  const host = await makeHost();
  const started = await rpcStartProcess(host, 'sleep 1');
  await host.asleep();
  const killed = await rpcKillProcess(host, started.pid);
  assert.deepEqual(killed, { ok: true, pid: started.pid });

  // The command ends without being woken: kill aborted it.
  await host.held[0];
  assert.equal(host.processes.get(started.pid).state, 'killed');
  assert.equal((await rpcProcessLogs(host, started.pid)).text, 'starting\n', 'kill aborts the running command instead of waiting it out');
}

// ── exec still waits for completion ──────────────────────────────────────
{
  const host = await makeHost();
  let settled = false;
  const pending = rpcExec(host, 'sleep 1').finally(() => { settled = true; });
  await host.asleep();
  assert.equal(settled, false, 'exec awaits the command');
  host.wake();
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'starting\nwoke\n');
}

// ── concurrent execs do not collect each other's ring output ─────────────
{
  const host = await makeHost();
  const [first, second] = await Promise.all([
    rpcExec(host, 'spawner one'),
    rpcExec(host, 'spawner two'),
  ]);
  assert.equal(first.stdout, 'child of one\n');
  assert.equal(second.stdout, 'child of two\n');
}

// ── a foreground exec never reaches the persistence adapter ──────────────
//
// Every pid an exec collects output for was allocated by that same exec, so
// there is nothing persisted to find. Asking anyway is not free: the
// adapter's `load` bootstraps the W9 log schema, which cost the first exec
// of every session a second durable commit — measured 2026-08-08 at ~28 ms.
{
  const host = await makeHost();
  const loads = [];
  host.processes.setLogPersist(
    {
      load(pid) { loads.push(pid); return { chunks: [], exit: null }; },
      persist() {},
      recordExit() {},
      pruneBeforeSeq() {},
    },
    () => {},
  );

  const quiet = await rpcExec(host, 'echo hello');
  assert.equal(quiet.stdout, 'hello\n');
  assert.deepEqual(loads, [], 'a foreground exec must not load persisted logs');

  // Output that arrives through a child's ring still resolves. That child's
  // first append hydrates its own pid — the ring it writes to is genuinely
  // persisted — but collecting the result adds no lookup beyond it.
  const viaRing = await rpcExec(host, 'spawner three');
  assert.equal(viaRing.stdout, 'child of three\n');
  const childPid = Math.max(...host.processes.getAll().map((p) => p.pid));
  assert.deepEqual(loads, [childPid], 'the only hydrate is the ring write, not the collect');
}

// A signal to a background job is not the default action for a launch that
// never started: the job's input channel is simply never read. The job must
// not be reported exited while its work runs on, and kill still ends it.
{
  const host = await makeHost();
  const started = await rpcStartProcess(host, 'sleep 30');
  await host.asleep();
  const signalled = await rpcSignalProcess(host, started.pid, 'SIGTERM');
  assert.equal(signalled.ok, true);
  assert.equal(host.processes.get(started.pid)?.state, 'running', 'no 143 is recorded for a job still running');
  const killed = await rpcKillProcess(host, started.pid);
  assert.equal(killed.ok, true, 'kill still reaches the job');
  await Promise.all(host.held);
}

for (const box of opened) box.close();
console.log('programmatic background process: ok');
