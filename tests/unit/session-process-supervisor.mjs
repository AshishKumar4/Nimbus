#!/usr/bin/env bun

// Facade contract for SessionProcessSupervisor — the session's single
// process owner. Asserts spawn/attach/write/resize/signal/exit ordering
// through the public surface, the input-to-unopened-PID regression, and
// the W9 persistence hook (chunks-before-exit flush ordering).

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

// ── spawn / PID authority ────────────────────────────────────────────
{
  const processes = new SessionProcessSupervisor();
  const a = processes.spawn('node a.js', ['a.js'], '/home/user');
  const b = processes.spawn('vite', [], '/home/user/example-app', { longRunning: true });
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

  // The program starts reading its terminal (an empty poll).
  assert.deepEqual(await processes.readInput(entry.pid, 0), { data: '', ended: false });

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

// ── a signal before the program reads its terminal: default action ───
{
  const processes = new SessionProcessSupervisor();
  const terminal = [];
  processes.setOnTerminal((pid) => terminal.push(pid));
  const booting = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });
  processes.openInput(booting.pid);
  assert.deepEqual(processes.signal(booting.pid, 'SIGTERM'), { ok: true });
  assert.equal(processes.get(booting.pid)?.state, 'exited', 'no handler can exist yet: SIGTERM ends it now');
  assert.equal(processes.get(booting.pid)?.exitCode, 143);
  assert.equal(processes.getExit(booting.pid)?.code, 143);
  assert.deepEqual(terminal, [booting.pid]);
  assert.equal(processes.hasInput(booting.pid), false, 'nothing is left queued for a program that never ran');

  // Every signal whose default action ends a process ends it now (Linux's dispositions).
  for (const [signal, code] of [['SIGUSR1', 138], ['SIGPIPE', 141], ['SIGALRM', 142]]) {
    const early = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });
    processes.openInput(early.pid);
    assert.deepEqual(processes.signal(early.pid, signal), { ok: true });
    assert.equal(processes.get(early.pid)?.state, 'exited', `${signal} terminates by default`);
    assert.equal(processes.get(early.pid)?.exitCode, code);
  }

  // A non-terminating signal before the first read still waits for the program.
  const other = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });
  processes.openInput(other.pid);
  assert.deepEqual(processes.signal(other.pid, 'SIGWINCH'), { ok: true });
  assert.equal(processes.get(other.pid)?.state, 'running');
  assert.equal((await processes.readInput(other.pid, 0)).signal, 'SIGWINCH');

  // Once reading, SIGTERM is delivered to the program, which may handle it.
  assert.deepEqual(processes.signal(other.pid, 'SIGTERM'), { ok: true });
  assert.equal(processes.get(other.pid)?.state, 'running');
  assert.equal((await processes.readInput(other.pid, 0)).signal, 'SIGTERM');

  // The owner of the process's work decides how the default action ends it.
  const ended = [];
  processes.setDefaultSignalAction((pid, code, signal) => ended.push([pid, code, signal]));
  const third = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });
  processes.openInput(third.pid);
  let stopped = 0;
  processes.setTerminator(third.pid, () => { stopped++; });
  processes.signal(third.pid, 'SIGINT');
  assert.deepEqual(ended, [[third.pid, 130, 'SIGINT']]);
  assert.equal(stopped, 1, 'the work behind the pid is stopped, not only recorded as ended');
}

// ── a background job with an unread input channel is not "not yet started" ──
{
  const processes = new SessionProcessSupervisor();
  processes.setDefaultSignalAction(() => assert.fail('a background job is not an attached launch'));
  const job = processes.spawn('tail -f log', ['tail -f log'], '/home/user', { longRunning: true });
  processes.openInput(job.pid);
  let aborted = 0;
  processes.setTerminator(job.pid, () => { aborted++; });
  assert.deepEqual(processes.signal(job.pid, 'SIGTERM'), { ok: true });
  assert.equal(processes.get(job.pid)?.state, 'running', 'no exit is recorded for work that keeps running');
  assert.equal(aborted, 0);
  assert.equal(processes.kill(job.pid), true, 'a later kill still reaches it');
  assert.equal(aborted, 1);
}

// ── SIGKILL always ends a running process ────────────────────────────
// A program that reads its signals, a background job that never reads its
// channel, and a launch with no channel at all (stuck in a top-level await
// before it opened one) all end with 137 and have their work stopped.
{
  const processes = new SessionProcessSupervisor();
  const ended = [];
  processes.setDefaultSignalAction((pid, code, signal) => {
    ended.push([pid, code, signal]);
    processes.exit(pid, code);
  });
  const reading = processes.spawn('pi', ['pi'], '/home/user', { longRunning: true, attachedTty: true });
  processes.openInput(reading.pid);
  void processes.readInput(reading.pid, 60_000);
  const job = processes.spawn('tail -f log', ['tail -f log'], '/home/user', { longRunning: true });
  processes.openInput(job.pid);
  const booting = processes.spawn('node server.mjs', ['server.mjs'], '/home/user', { longRunning: true });
  const stopped = [];
  for (const entry of [reading, job, booting]) {
    processes.setTerminator(entry.pid, () => { stopped.push(entry.pid); });
    assert.deepEqual(processes.signal(entry.pid, 'SIGKILL'), { ok: true });
    assert.notEqual(processes.get(entry.pid)?.state, 'running', `pid ${entry.pid} is no longer running`);
  }
  assert.deepEqual(ended, [[reading.pid, 137, 'SIGKILL'], [job.pid, 137, 'SIGKILL'], [booting.pid, 137, 'SIGKILL']]);
  assert.deepEqual(stopped, [reading.pid, job.pid, booting.pid], 'the work behind every pid is stopped');
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
  const entry = processes.spawn('vite', [], '/home/user/example-app', { longRunning: true });
  processes.openInput(entry.pid);
  assert.deepEqual(processes.writeInput(entry.pid, 'x'), { ok: true });

  assert.equal(processes.kill(entry.pid), true);
  assert.equal(processes.get(entry.pid)?.state, 'killed');
  assert.equal(processes.get(entry.pid)?.exitCode, 137);
  assert.equal(processes.hasInput(entry.pid), false);
  assert.deepEqual(processes.writeInput(entry.pid, 'after-kill'), { ok: false });
}

// ── reap releases and drops old exited entries ──────────────────────
{
  const processes = new SessionProcessSupervisor();
  const dead = processes.spawn('node done.js', [], '/');
  const live = processes.spawn('vite', [], '/', { longRunning: true });
  processes.exit(dead.pid, 0);
  assert.equal(await processes.reap(-1), 0, 'a table with no release reaps nothing');
  assert.equal(processes.get(dead.pid)?.state, 'exited');
  const released = [];
  processes.setRelease(async (pid) => { released.push(pid); });
  assert.equal(await processes.reap(-1), 1);
  assert.deepEqual(released, [dead.pid], 'the entry is released before it is forgotten');
  assert.equal(processes.get(dead.pid), undefined);
  assert.equal(processes.get(live.pid)?.state, 'running');
}

// ── A release that fails stops neither prune: every ended entry still goes ──
// releaseProcess revokes everything first and only then reports what it could
// not do (a descriptor's buffered bytes lost to an abort). One failure must
// not keep that pid, or the ones after it, bound.
{
  const processes = new SessionProcessSupervisor();
  const first = processes.spawn('node a.js', [], '/');
  const second = processes.spawn('node b.js', [], '/');
  processes.exit(first.pid, 0);
  processes.exit(second.pid, 0);
  const released = [];
  processes.setRelease(async (pid) => {
    released.push(pid);
    if (pid === first.pid) throw Object.assign(new Error('EIO: its buffered writes are lost (aborted)'), { code: 'EIO' });
  });
  // Pruning by age serves whoever launches next, not the process that ended:
  // the failure goes to that process's own log, where its output is read.
  assert.equal(await processes.reap(-1), 2, 'both ended entries are reaped');
  assert.deepEqual(released, [first.pid, second.pid], 'the failure does not stop the next release');
  assert.equal(processes.get(first.pid), undefined, 'the entry whose release failed is forgotten');
  assert.equal(processes.get(second.pid), undefined);
  assert.match(processes.allLogs(first.pid).map((c) => c.data).join(''), /EIO: its buffered writes are lost/, 'the failure is in the failed process\'s own log');
}
{
  const processes = new SessionProcessSupervisor();
  const parent = processes.spawn('sh -c', [], '/');
  const a = processes.spawn('node a.js', [], '/', { parentPid: parent.pid });
  const b = processes.spawn('node b.js', [], '/', { parentPid: parent.pid });
  for (const entry of [a, b, parent]) processes.exit(entry.pid, 0);
  const released = [];
  processes.setRelease(async (pid) => {
    released.push(pid);
    if (pid === parent.pid || pid === a.pid) throw new Error(`release ${pid} failed`);
  });
  // A caller that waited for the tree hears every failure, after all of it is gone.
  const failed = await processes.reapTree(parent.pid).then(() => null, (error) => error);
  assert.ok(failed instanceof AggregateError, `two failures are reported together: ${failed}`);
  assert.deepEqual(failed.errors.map((e) => e.message), [`release ${parent.pid} failed`, `release ${a.pid} failed`]);
  assert.deepEqual(released, [parent.pid, a.pid, b.pid], 'every ended entry in the tree is released');
  for (const entry of [parent, a, b]) assert.equal(processes.get(entry.pid), undefined, `pid ${entry.pid} is forgotten`);
  // One failure is reported as itself.
  const solo = processes.spawn('node c.js', [], '/');
  processes.exit(solo.pid, 0);
  processes.setRelease(async () => { throw new Error('only one'); });
  await assert.rejects(processes.reapTree(solo.pid), { message: 'only one' });
  assert.equal(processes.get(solo.pid), undefined);
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
    retained() { return []; },
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

// ── Retention: deadlines over memory and what only SQL holds ─────────────
// A pid's logs go 10 min after its exit, or 30 min after its last output
// once this table no longer holds its process (an orphan). That covers the
// pids an earlier instance persisted, which this one never held in memory.
{
  const RETAIN = 10 * 60 * 1000;
  const T = 10 * RETAIN;
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(3_000_000);
  const dropped = [];
  processes.setLogPersist({
    load() { return null; },
    persistChunks() {},
    persistExit() {},
    dropPid(pid) { dropped.push(pid); },
    pruneBeforeSeq() {},
    retained() {
      return [
        { pid: 1_000_001, exitAt: T, lastActivity: T },
        { pid: 1_000_002, exitAt: T + 5, lastActivity: T + 5 },
        // An earlier instance's process that died without an exit.
        { pid: 2_000_001, exitAt: null, lastActivity: T - 2 * RETAIN + 1 },
      ];
    },
  }, () => {});

  // This instance's running process logs: no deadline while it runs.
  const live = processes.spawn('node srv.js', [], '/').pid;
  processes.appendOutput(live, 'stdout', 'up\n');
  assert.equal(processes.nextLogExpiry(), T + RETAIN, 'the earliest persisted exit, plus retention');

  const realNow = Date.now;
  Date.now = () => T + RETAIN + 1;
  try {
    assert.equal(processes.dropLogsOlderThan(), 2, 'the first exit and the orphan are due; the second exit is not');
  } finally { Date.now = realNow; }
  processes.flushLogs();
  assert.deepEqual(dropped.sort(), [1_000_001, 2_000_001]);
  assert.equal(processes.nextLogExpiry(), T + 5 + RETAIN, 'the next deadline');
  assert.ok(processes.hasLogs(live), 'the running process keeps its logs');
}

// ── Retention: a failed hydrate does not lose a persisted pid ──────────────
// Reading a pid only SQL holds hydrates it; a load that fails comes back
// empty, the store lets the pid go again, and its rows must still be swept.
{
  const RETAIN = 10 * 60 * 1000;
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(3_000_000);
  const dropped = [];
  processes.setLogPersist({
    load() { return null; },
    persistChunks() {}, persistExit() {},
    dropPid(pid) { dropped.push(pid); },
    pruneBeforeSeq() {},
    retained() { return [{ pid: 1_000_001, exitAt: 5_000, lastActivity: 5_000 }]; },
  }, () => {});
  assert.equal(processes.nextLogExpiry(), 5_000 + RETAIN, 'listed');
  assert.deepEqual(processes.readLogs(1_000_001).chunks, [], 'the load failed: nothing to read');
  assert.equal(processes.nextLogExpiry(), 5_000 + RETAIN, 'still retained after the failed read');
  const realNow = Date.now;
  Date.now = () => 5_000 + RETAIN;
  try {
    assert.equal(processes.dropLogsOlderThan(), 1);
  } finally { Date.now = realNow; }
  processes.flushLogs();
  assert.deepEqual(dropped, [1_000_001], 'its rows are dropped at the deadline');
  assert.equal(processes.nextLogExpiry(), null);
}

// ── Retention: the hook fires only where a deadline may appear ──────────────
// Logs that begin, an exit, a reader leaving, a reap. Not further output, so
// a host re-reads the deadline there and never per chunk.
{
  const RETAIN = 10 * 60 * 1000;
  const processes = new SessionProcessSupervisor();
  const fired = [];
  let activity = 0;
  processes.setLogPersist({
    load() { return null; }, persistChunks() {}, persistExit() {}, dropPid() {}, pruneBeforeSeq() {},
    retained() { return []; },
  }, () => { activity++; }, () => { fired.push(processes.nextLogExpiry()); });

  const server = processes.spawn('node srv.js', [], '/').pid;
  processes.appendOutput(server, 'stdout', 'one\n');
  assert.deepEqual(fired, [null], 'logs that begin: a running process has no deadline');
  for (let i = 0; i < 10; i++) processes.appendOutput(server, 'stdout', 'more\n');
  assert.equal(fired.length, 1, 'further output moves no deadline earlier');
  assert.equal(activity, 11, 'but is activity (a flush)');

  const unsubscribe = processes.subscribeLogs(server, () => {});
  processes.exit(server, 0);
  processes.markExit(server, 0);
  const exitAt = processes.getExit(server).at;
  assert.deepEqual(fired, [null, null], 'an exit with a reader attached holds no deadline');
  unsubscribe();
  assert.deepEqual(fired, [null, null, exitAt + RETAIN], 'the reader leaving brings the exit\'s deadline');
  assert.equal(activity, 12, 'a reader leaving is not activity');
}

// ── Retention: a process killed around its log is an orphan once reaped ─────
// Its table entry is ended, its log holds no exit. It is not an orphan while
// the table holds it; the reap that drops the entry gives its logs the orphan
// deadline, and fires the hook so a host arms for it.
{
  const RETAIN = 10 * 60 * 1000;
  const processes = new SessionProcessSupervisor();
  processes.setRelease(async () => {});
  let fired = 0;
  processes.setLogPersist({
    load() { return null; }, persistChunks() {}, persistExit() {}, dropPid() {}, pruneBeforeSeq() {},
    retained() { return []; },
  }, () => {}, () => { fired++; });
  const killed = processes.spawn('vite', [], '/').pid;
  processes.appendOutput(killed, 'stdout', 'listening\n');
  processes.kill(killed);
  const lastOutput = processes.readLogs(killed).chunks.at(-1).ts;
  assert.equal(processes.getExit(killed), null, 'killed around its log: no exit recorded');
  assert.equal(processes.nextLogExpiry(), null, 'held by the table: not an orphan yet');
  const before = fired;
  const realNow = Date.now;
  Date.now = () => realNow() + 1;
  try {
    assert.equal(await processes.reap(0), 1);
  } finally { Date.now = realNow; }
  assert.equal(fired, before + 1, 'the reap fired the hook');
  assert.equal(processes.nextLogExpiry(), lastOutput + 3 * RETAIN, 'the orphan deadline');
  assert.equal(await processes.reap(0), 0);
  assert.equal(fired, before + 1, 'a reap that removes nothing does not');
}

console.log('session-process-supervisor: ok');
