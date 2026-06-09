#!/usr/bin/env bun

// Facade contract for SessionProcessSupervisor — the session's single
// process owner. Asserts spawn/attach/write/resize/signal/exit ordering
// through the public surface, the input-to-unopened-PID regression, and
// the W9 persistence hook (chunks-before-exit flush ordering).

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';

// ── spawn / PID authority ────────────────────────────────────────────
{
  const processes = new SessionProcessSupervisor();
  const a = processes.spawn('node a.js', ['a.js'], '/home/user');
  const b = processes.spawn('vite', [], '/home/user/app', { longRunning: true });
  const c = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });

  assert.equal(a.pid, 1);
  assert.equal(b.pid, 2);
  assert.equal(c.pid, 3);
  assert.equal(a.state, 'running');
  assert.equal(a.longRunning, undefined);
  assert.equal(b.longRunning, true);
  assert.equal(b.attachedTty, undefined);
  assert.equal(c.longRunning, true);
  assert.equal(c.attachedTty, true);
  assert.deepEqual(processes.getAll().map((p) => p.pid), [1, 2, 3]);
  assert.deepEqual(processes.getRunning().map((p) => p.pid), [1, 2, 3]);
  assert.equal(processes.get(2)?.command, 'vite');
  assert.equal(processes.stats.running, 3);
}

// ── controlling terminal: input fails until opened ───────────────────
{
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });

  // Regression: input to a PID without an open input channel fails.
  assert.deepEqual(processes.writeInput(entry.pid, 'early'), { ok: false });
  assert.equal(processes.hasInput(entry.pid), false);
  assert.equal(processes.terminal(entry.pid), null);

  processes.openInput(entry.pid);
  assert.equal(processes.hasInput(entry.pid), true);
  assert.deepEqual(processes.terminal(entry.pid), {
    pid: entry.pid, attached: true, columns: 80, rows: 24,
  });

  // write → resize storm → signal arrive in order; resizes coalesce.
  assert.deepEqual(processes.writeInput(entry.pid, 'hello'), { ok: true });
  assert.deepEqual(processes.resize(entry.pid, 100, 30), { ok: true });
  assert.deepEqual(processes.resize(entry.pid, 110, 35), { ok: true });
  assert.deepEqual(processes.resize(entry.pid, 120, 40), { ok: true });
  assert.deepEqual(processes.signal(entry.pid, 'SIGINT'), { ok: true });

  assert.deepEqual(await processes.readInput(entry.pid, 0), { data: 'hello', ended: false });
  assert.deepEqual(await processes.readInput(entry.pid, 0), {
    data: '', ended: false, resize: { columns: 120, rows: 40 },
  });
  assert.deepEqual(await processes.readInput(entry.pid, 0), {
    data: '', ended: false, signal: 'SIGINT',
  });
  assert.deepEqual(processes.terminal(entry.pid), {
    pid: entry.pid, attached: true, columns: 120, rows: 40,
  });

  // stdin EOF: ended packet, then writes fail.
  processes.endInput(entry.pid);
  assert.deepEqual(await processes.readInput(entry.pid, 0), { data: '', ended: true });
  assert.deepEqual(processes.writeInput(entry.pid, 'late'), { ok: false });
}

// ── output / exit ordering ───────────────────────────────────────────
{
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('node crash.js', ['crash.js'], '/home/user');
  const seen = [];
  const unsubLogs = processes.subscribeLogs(entry.pid, (chunk) => seen.push(['chunk', chunk.stream, chunk.data]));
  processes.subscribeExit(entry.pid, (exit) => seen.push(['exit', exit.code]));

  processes.appendOutput(entry.pid, 'stdout', 'boot\n');
  processes.appendOutput(entry.pid, 'stderr', 'boom\n');
  processes.exit(entry.pid, 1);
  processes.markExit(entry.pid, 1);

  assert.deepEqual(seen, [
    ['chunk', 'stdout', 'boot\n'],
    ['chunk', 'stderr', 'boom\n'],
    ['exit', 1],
  ]);
  assert.equal(processes.get(entry.pid)?.state, 'exited');
  assert.equal(processes.get(entry.pid)?.exitCode, 1);
  assert.equal(processes.getExit(entry.pid)?.code, 1);
  assert.equal(processes.hasLogs(entry.pid), true);
  assert.equal(processes.logSize(entry.pid), 'boot\nboom\n'.length);
  assert.deepEqual(processes.allLogs(entry.pid).map((c) => c.data), ['boot\n', 'boom\n']);
  assert.deepEqual(processes.tailLogs(entry.pid, { lines: 1 }).map((c) => c.data), ['boom\n']);
  const read = processes.readLogs(entry.pid, {});
  assert.equal(read.cursor, 2);
  assert.equal(read.truncated, false);

  // First terminal state wins: a later kill cannot clobber the exit.
  assert.equal(processes.kill(entry.pid), false);
  assert.equal(processes.get(entry.pid)?.exitCode, 1);
  // markExit is idempotent: the first record wins.
  processes.markExit(entry.pid, 137, 'late-kill');
  assert.equal(processes.getExit(entry.pid)?.code, 1);
  unsubLogs();
}

// ── kill tears down the input channel ────────────────────────────────
{
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('vite', [], '/home/user/app', { longRunning: true });
  processes.openInput(entry.pid);
  assert.deepEqual(processes.writeInput(entry.pid, 'x'), { ok: true });

  assert.equal(processes.kill(entry.pid), true);
  assert.equal(processes.get(entry.pid)?.state, 'killed');
  assert.equal(processes.get(entry.pid)?.exitCode, 137);
  assert.equal(processes.hasInput(entry.pid), false);
  assert.deepEqual(processes.writeInput(entry.pid, 'after-kill'), { ok: false });
}

// ── reap drops old exited entries ────────────────────────────────────
{
  const processes = new SessionProcessSupervisor();
  const dead = processes.spawn('node done.js', [], '/');
  const live = processes.spawn('vite', [], '/', { longRunning: true });
  processes.exit(dead.pid, 0);
  assert.equal(processes.reap(-1), 1);
  assert.equal(processes.get(dead.pid), undefined);
  assert.equal(processes.get(live.pid)?.state, 'running');
}

// ── W9 persistence: activity hook + chunks-before-exit flush order ───
{
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('node srv.js', [], '/', { longRunning: true });

  const calls = [];
  let activity = 0;
  processes.setLogPersist({
    load() { return null; },
    persistChunks(pid, rows) { calls.push(['chunks', pid, rows.map((r) => r.chunk.data)]); },
    persistExit(pid, info) { calls.push(['exit', pid, info.code]); },
    dropPid(pid) { calls.push(['drop', pid]); },
    pruneBeforeSeq(pid, seq) { calls.push(['prune', pid, seq]); },
  }, () => { activity++; });

  processes.appendOutput(entry.pid, 'stdout', 'one\n');
  processes.appendOutput(entry.pid, 'stdout', 'two\n');
  processes.markExit(entry.pid, 0);
  assert.equal(activity, 3, 'activity hook fires after every appendOutput/markExit');

  processes.flushLogs();
  assert.deepEqual(calls, [
    ['chunks', entry.pid, ['one\n', 'two\n']],
    ['exit', entry.pid, 0],
  ], 'chunks persist before the exit row (crash-resilience invariant)');

  assert.equal(processes.logHibStats().flushedChunks, 2);
  assert.equal(processes.logStats.totalPids, 1);

  // resetLogStore replaces the ring and detaches the activity hook.
  processes.resetLogStore();
  assert.equal(processes.hasLogs(entry.pid), false);
  processes.appendOutput(entry.pid, 'stdout', 'fresh\n');
  assert.equal(activity, 3, 'detached hook no longer fires');

  // dropLogsOlderThan delegates to the (fresh, unwired) store.
  processes.markExit(entry.pid, 0);
  assert.equal(processes.dropLogsOlderThan(-1), 1);
}

console.log('session-process-supervisor: ok');
