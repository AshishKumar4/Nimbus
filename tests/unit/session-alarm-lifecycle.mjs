#!/usr/bin/env bun
// Regression tests for the W1 alarm lifecycle fixes:
//   - concurrent scheduleAlarm calls must not lose a reason (the log-activity
//     hook fires scheduleHibFlush + ensureLogJanitor back-to-back; two
//     interleaved get→put cycles used to drop 'w9-flush');
//   - the janitor is armed only for a retention deadline (an exit + 10 min),
//     never on a cadence: a running process — the session's own shell always
//     is one — holds no deadline, so an idle session has nothing re-arming;
//   - a janitor woken in a fresh instance drops the logs only SQL holds;
//   - a scheduleAlarm storage failure must not leave _w1JanitorAt recorded
//     (nothing would ever re-arm);
//   - a destroyed session never re-arms;
//   - rpcDestroy deletes the pending alarm and writes the tombstone.

import assert from 'node:assert/strict';
import {
  ensureLogJanitor,
  dispatchAlarm,
  clearDestroyedTombstone,
} from '../../packages/worker/src/session/hibernation.ts';
import { timers, TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';
import { GENERATION_KEY, assumeGeneration } from '../../packages/fabric/src/generation.ts';
import { SESSION_DESTROYED_KEY } from '../../packages/worker/src/session/keys.ts';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

function makeStorage() {
  const map = new Map();
  let alarm = null;
  let deleteAlarmCalls = 0;
  return {
    map,
    get alarm() { return alarm; },
    get deleteAlarmCalls() { return deleteAlarmCalls; },
    async get(k) { return map.get(k); },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async deleteAll() { map.clear(); },
    async deleteAlarm() { alarm = null; deleteAlarmCalls++; },
    setAlarm(when) { alarm = when; },
    sql: { exec() { return []; } },
    transactionSync(fn) { return fn(); },
  };
}

function makeHost() {
  return {
    processes: new SessionProcessSupervisor(),
    _w9SchemaInit: false,
    _w9PersistWired: false,
    _w9FlushTimer: null,
    _w1JanitorAt: null,
    _w1SessionDestroyed: false,
  };
}

/** ProcessLogStore's default retention past exit. */
const RETAIN_AFTER_EXIT_MS = 10 * 60 * 1000;

// ── [1] F2: concurrent RMWs keep BOTH reasons ──────────────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  await Promise.all([
    timers(host, ctx).schedule('w9-flush', Date.now() + 1000),
    timers(host, ctx).schedule('log-janitor', Date.now() + 60_000),
  ]);
  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(map && 'w9-flush' in map && 'log-janitor' in map,
    `both reasons survive concurrent scheduling: ${JSON.stringify(map)}`);
  assert.equal(storage.alarm, map['w9-flush'], 'alarm armed at the earliest deadline');
  console.log('  [1] concurrent scheduleAlarm calls keep both reasons (no lost update)');
}

/** A process that ran and exited, leaving `text` in its log; returns its pid and exit time. */
function exitedProcess(host, text = 'done\n') {
  const pid = host.processes.spawn('node -e', [], '/').pid;
  host.processes.appendOutput(pid, 'stdout', text);
  host.processes.exit(pid, 0);
  host.processes.markExit(pid, 0);
  return { pid, exitAt: host.processes.getExit(pid).at };
}

// ── [2] the janitor is armed only for a retention deadline ─────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  const orphan = (p) => !host.processes.get(p);
  // The session's shell: running, and logging, for as long as the session lives.
  const shell = host.processes.spawn('sh', ['sh'], '/').pid;
  host.processes.appendOutput(shell, 'stdout', '$ ');
  ensureLogJanitor(host, ctx, orphan);
  await host._timerChain;
  assert.equal(storage.alarm, null, 'a running process holds no deadline, so nothing is armed');
  assert.equal(host._w1JanitorAt, null);

  // A process exits: its logs are due RETAIN_AFTER_EXIT_MS later, and not before.
  const { pid, exitAt } = exitedProcess(host);
  ensureLogJanitor(host, ctx, orphan);
  await host._timerChain;
  assert.equal(storage.map.get(TIMER_REASONS_KEY)['log-janitor'], exitAt + RETAIN_AFTER_EXIT_MS,
    'armed at the exit\'s retention deadline, not on a cadence');
  assert.equal(host._w1JanitorAt, exitAt + RETAIN_AFTER_EXIT_MS);

  // The alarm, early (as a stale deadline from an older build would be): nothing is due, nothing drops.
  storage.map.get(TIMER_REASONS_KEY)['log-janitor'] = Date.now() - 1;
  await dispatchAlarm(host, ctx, orphan);
  assert.ok(host.processes.hasLogs(pid), 'kept until its deadline');
  assert.equal(storage.map.get(TIMER_REASONS_KEY)['log-janitor'], exitAt + RETAIN_AFTER_EXIT_MS, 're-armed at the deadline itself');

  // At the deadline: dropped, and with the shell still running nothing re-arms.
  const realNow = Date.now;
  Date.now = () => exitAt + RETAIN_AFTER_EXIT_MS;
  try {
    storage.map.get(TIMER_REASONS_KEY)['log-janitor'] = Date.now();
    await dispatchAlarm(host, ctx, orphan);
  } finally { Date.now = realNow; }
  assert.equal(host.processes.hasLogs(pid), false, 'dropped at the deadline');
  assert.ok(host.processes.stats.running > 0, 'the shell still runs');
  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(!map || !('log-janitor' in map), `nothing retained can expire, so nothing re-arms: ${JSON.stringify(map)}`);
  assert.equal(host._w1JanitorAt, null, 'cleared so the next exit arms again');
  console.log('  [2] janitor armed only at retention deadlines; a running shell never re-arms it');
}

// ── [2b] a janitor woken in a fresh instance sweeps what only SQL holds ─────
{
  const { Database } = await import('bun:sqlite');
  const { createSqliteVfsTestHarness } = await import('./sqlite-vfs-test-harness.mjs');
  const { wireProcessLogPersist } = await import('../../packages/worker/src/session/hibernation.ts');
  const db = new Database(':memory:');
  const storage = makeStorage();
  const boot = () => {
    const harness = createSqliteVfsTestHarness(db);
    const host = makeHost();
    const ctx = { storage: { ...storage, get: storage.get, put: storage.put, delete: storage.delete, setAlarm: (t) => storage.setAlarm(t), sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync } };
    wireProcessLogPersist(host, ctx);
    return { host, ctx };
  };
  const rows = () => db.query('SELECT COUNT(*) AS n FROM w9_proc_logs').get().n + db.query('SELECT COUNT(*) AS n FROM w9_proc_exits').get().n;

  const before = boot();
  const { pid, exitAt } = exitedProcess(before.host, 'kept\n');
  before.host.processes.flushLogs();
  await before.host._timerChain;
  assert.ok(rows() > 0, 'persisted');
  assert.equal(storage.map.get(TIMER_REASONS_KEY)['log-janitor'], exitAt + RETAIN_AFTER_EXIT_MS);

  // Hibernated; woken by the alarm at the deadline, holding nothing in memory.
  const woken = boot();
  const realNow = Date.now;
  Date.now = () => exitAt + RETAIN_AFTER_EXIT_MS;
  try {
    await dispatchAlarm(woken.host, woken.ctx, (p) => !woken.host.processes.get(p));
  } finally { Date.now = realNow; }
  assert.equal(rows(), 0, `the persisted logs of pid ${pid} are dropped by the instance that never held them`);
  assert.ok(!storage.map.has(TIMER_REASONS_KEY), 'and nothing re-arms');
  console.log('  [2b] a janitor woken in a fresh instance drops the persisted logs, then stops');
}

// ── [3] F3: schedule failure resets the armed deadline ─────────────────────
{
  const storage = makeStorage();
  storage.put = async () => { throw new Error('storage down'); };
  const host = makeHost();
  exitedProcess(host);
  ensureLogJanitor(host, { storage });
  await host._timerChain;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(host._w1JanitorAt, null, 'failed schedule must not leave the deadline recorded');
  console.log('  [3] a scheduleAlarm storage failure resets _w1JanitorAt');
}

// ── [4] F7: destroyed sessions never re-arm ────────────────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  exitedProcess(host);
  host._w1SessionDestroyed = true;
  ensureLogJanitor(host, { storage });
  await host._timerChain;
  assert.equal(storage.alarm, null, 'destroyed session schedules nothing');
  assert.equal(host._w1JanitorAt, null);
  console.log('  [4] a destroyed session never re-arms the janitor');
}

/** A session host rpcDestroy can run against, over `storage`. */
function makeDestroyHost(storage) {
  return {
    ...makeHost(),
    ctx: { storage, getWebSockets: () => [] },
    sqliteFs: null,
    ensureSqliteFs() {
      if (this.sqliteFs) return;
      this.sqliteFs = {
        hasExclusiveMutation: () => false,
        acquireGlobalExclusiveMutation: () => ({ root: '', owner: 'destroy-test' }),
        releaseExclusiveMutation() {},
      };
    },
    ensureBundlePool() { return null; },
    terminal: null,
    shell: null,
    kernel: null,
    facetManager: null,
    portRegistry: { unregisterByPid() {} },
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    _cirrusHmrWsClients: null,
    _w9PersistWired: true,
  };
}

// ── [5] rpcDestroy deletes the alarm + writes the tombstone ────────────────
{
  const storage = makeStorage();
  storage.setAlarm(Date.now() + 60_000);
  const host = makeDestroyHost(storage);
  assumeGeneration(host.ctx, 3);
  const result = await rpcDestroy(host, { reason: 'test' });
  assert.equal(result.ok, true);
  assert.ok(storage.deleteAlarmCalls >= 1, 'destroy deletes the pending alarm');
  assert.ok(storage.map.has(SESSION_DESTROYED_KEY), 'destroy writes the tombstone (survives deleteAll)');
  assert.equal(host._w1SessionDestroyed, true, 'destroy flags the live instance');
  assert.equal(storage.map.get(GENERATION_KEY), 3,
    'destroy re-persists the isolate generation (deleteAll wiped it; a gen-1 restart would misclassify pre-destroy stragglers as current-generation)');
  console.log('  [5] rpcDestroy deletes the alarm, re-persists isolateGen, and leaves the tombstone');

  // Legitimate re-initialization of the SAME session id (documented SDK
  // flow) lifts the tombstone so the recreated session's janitor arms again.
  clearDestroyedTombstone(host, { storage });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(host._w1SessionDestroyed, false, 're-init clears the destroyed flag');
  assert.ok(!storage.map.has(SESSION_DESTROYED_KEY), 're-init deletes the tombstone key');
  host._w1JanitorAt = null;
  exitedProcess(host);
  ensureLogJanitor(host, { storage });
  await host._timerChain;
  assert.ok(storage.alarm !== null, 'the recreated session arms the janitor again');
  // And a no-op on a live session (no spurious deletes).
  const deletes = [];
  clearDestroyedTombstone(host, { storage: { delete: async (k) => { deletes.push(k); } } });
  assert.equal(deletes.length, 0, 'clear is a no-op when the session was never destroyed');
  console.log('  [5b] a recreated session id lifts the tombstone and can arm the janitor again');
}

// ── [5c] an alarm dispatch in flight during destroy leaves no alarm behind ──
// The alarm handler is running (a resident-launch turn) when the session is
// destroyed. When it returns, the dispatcher must not write its reasons map
// back or re-arm setAlarm after destroy's deleteAll + deleteAlarm — nor may a
// schedule requested before the destroy and queued behind the dispatch.
{
  const storage = makeStorage();
  const host = makeDestroyHost(storage);
  const now = Date.now();
  await timers(host, host.ctx).schedule('resident-launch', now - 1);
  assert.equal(storage.alarm, now - 1);

  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatched = timers(host, host.ctx).dispatch({
    'resident-launch': async () => {
      started();
      await gate;
      await timers(host, host.ctx).schedule('log-janitor', now + 60_000);
      return { rearmAt: now + 1_000 };
    },
  });
  await running;
  const queued = timers(host, host.ctx).schedule('w9-flush', now + 5_000);

  const result = await rpcDestroy(host, { reason: 'test' });
  assert.equal(result.ok, true);
  assert.equal(storage.alarm, null, 'destroy deleted the alarm');
  release();
  await dispatched;
  assert.equal(storage.alarm, null, 'the in-flight dispatch re-armed the destroyed session');
  assert.equal(storage.map.has(TIMER_REASONS_KEY), false,
    `the in-flight dispatch wrote its reasons back: ${JSON.stringify(storage.map.get(TIMER_REASONS_KEY))}`);
  assert.equal(await queued, false, 'a schedule queued before the destroy reported an arm');
  assert.equal(storage.alarm, null, 'a schedule queued before the destroy re-armed it');

  // The recreated session id schedules normally.
  assert.equal(await timers(host, host.ctx).schedule('log-janitor', now + 60_000), true);
  assert.equal(storage.alarm, now + 60_000, 'a schedule after the destroy did not arm');
  console.log('  [5c] a dispatch in flight during destroy neither writes its map back nor re-arms');
}

// ── [6] broadcast survives a log-store reset/rewire ────────────────────────
{
  const { wireProcessLogSocketBroadcast } = await import('../../packages/worker/src/runtime/process-logs-api.ts');
  const sup = new SessionProcessSupervisor();
  const pid = sup.spawn('tui', [], '/').pid;
  const socket = {
    frames: [],
    deserializeAttachment() { return { kind: 'process-logs', pid }; },
    send(s) { this.frames.push(JSON.parse(s)); },
  };
  const ctx = { getWebSockets: () => [socket] };
  wireProcessLogSocketBroadcast(sup, ctx);
  sup.appendOutput(pid, 'stdout', 'before');
  assert.equal(socket.frames.length, 1);

  // The hib-simulate path: store replaced, then re-wired (mirrors routes.ts).
  sup.resetLogStore();
  wireProcessLogSocketBroadcast(sup, ctx);
  sup.appendOutput(pid, 'stdout', 'after');
  const exitless = socket.frames.filter((f) => f.type === 'chunk');
  assert.equal(exitless.length, 2, 'broadcast still reaches the socket after a store reset + rewire');
  assert.equal(exitless[1].data, 'after');
  console.log('  [6] process-log broadcast survives a log-store reset/rewire');
}

console.log('session-alarm-lifecycle OK: alarm RMWs serialized, janitor at retention deadlines only, cold-instance sweep, destroy tombstone, broadcast rewire');
