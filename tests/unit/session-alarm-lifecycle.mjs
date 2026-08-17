#!/usr/bin/env bun
// Regression tests for the W1 alarm lifecycle fixes:
//   - concurrent scheduleAlarm calls must not lose a reason (the log-activity
//     hook fires scheduleHibFlush + ensureLogJanitor back-to-back; two
//     interleaved get→put cycles used to drop 'w9-flush');
//   - the janitor stops re-arming when the session is idle and re-arms on the
//     next log activity;
//   - a scheduleAlarm storage failure must not leave _w1JanitorArmed=true
//     (nothing would ever re-arm);
//   - a destroyed session never re-arms;
//   - rpcDestroy deletes the pending alarm and writes the tombstone.

import assert from 'node:assert/strict';
import {
  ensureLogJanitor,
  dispatchAlarm,
  clearDestroyedTombstone,
} from '../../packages/worker/src/session/hibernation.ts';
import { scheduleAlarm, ALARM_REASONS_KEY, ISOLATE_GEN_KEY } from '../../packages/fabric/src/alarms.ts';
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
    _w9IsolateGen: 0,
    _w9IsolateGenPersisted: false,
    _w9SchemaInit: false,
    _w9PersistWired: false,
    _w9FlushTimer: null,
    _w1JanitorArmed: false,
    _w1SessionDestroyed: false,
  };
}

// ── [1] F2: concurrent RMWs keep BOTH reasons ──────────────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  await Promise.all([
    scheduleAlarm(host, ctx, 'w9-flush', Date.now() + 1000),
    scheduleAlarm(host, ctx, 'log-janitor', Date.now() + 60_000),
  ]);
  const map = storage.map.get(ALARM_REASONS_KEY);
  assert.ok(map && 'w9-flush' in map && 'log-janitor' in map,
    `both reasons survive concurrent scheduling: ${JSON.stringify(map)}`);
  assert.equal(storage.alarm, map['w9-flush'], 'alarm armed at the earliest deadline');
  console.log('  [1] concurrent scheduleAlarm calls keep both reasons (no lost update)');
}

// ── [2] janitor stops when idle, re-arms on activity ───────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  ensureLogJanitor(host, ctx);
  await host._w1AlarmChain;
  assert.ok(host._w1JanitorArmed && storage.alarm !== null, 'janitor armed on activity');

  // Idle session: fire the pending janitor deadline — the sweep must NOT
  // re-arm. (The dispatcher only fires reasons whose deadline has passed, so
  // pull the scheduled deadline into the past first, as the alarm would.)
  {
    const m = storage.map.get(ALARM_REASONS_KEY);
    m['log-janitor'] = Date.now() - 1;
  }
  await dispatchAlarm(host, ctx, () => true);
  const map = storage.map.get(ALARM_REASONS_KEY);
  assert.ok(!map || !('log-janitor' in map), 'idle sweep does not re-arm the janitor');
  assert.equal(host._w1JanitorArmed, false, 'armed flag cleared so the next activity re-arms');

  // Activity: a spawned process + logs → the sweep re-arms.
  const pid = host.processes.spawn('server', [], '/').pid;
  host.processes.appendOutput(pid, 'stdout', 'alive\n');
  ensureLogJanitor(host, ctx);
  await host._w1AlarmChain;
  {
    const m = storage.map.get(ALARM_REASONS_KEY);
    m['log-janitor'] = Date.now() - 1;
  }
  await dispatchAlarm(host, ctx, (p) => !host.processes.get(p));
  const map2 = storage.map.get(ALARM_REASONS_KEY);
  assert.ok(map2 && 'log-janitor' in map2, 'busy session keeps the sweep cycle alive');
  console.log('  [2] janitor stops when idle and re-arms on the next log activity');
}

// ── [3] F3: schedule failure resets the armed flag ─────────────────────────
{
  const storage = makeStorage();
  storage.put = async () => { throw new Error('storage down'); };
  const host = makeHost();
  ensureLogJanitor(host, { storage });
  await host._w1AlarmChain;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(host._w1JanitorArmed, false, 'failed schedule must not leave the flag set');
  console.log('  [3] a scheduleAlarm storage failure resets _w1JanitorArmed');
}

// ── [4] F7: destroyed sessions never re-arm ────────────────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  host._w1SessionDestroyed = true;
  ensureLogJanitor(host, { storage });
  await host._w1AlarmChain;
  assert.equal(storage.alarm, null, 'destroyed session schedules nothing');
  assert.equal(host._w1JanitorArmed, false);
  console.log('  [4] a destroyed session never re-arms the janitor');
}

// ── [5] rpcDestroy deletes the alarm + writes the tombstone ────────────────
{
  const storage = makeStorage();
  storage.setAlarm(Date.now() + 60_000);
  const host = {
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
  host._w9IsolateGen = 3;
  const result = await rpcDestroy(host, { reason: 'test' });
  assert.equal(result.ok, true);
  assert.ok(storage.deleteAlarmCalls >= 1, 'destroy deletes the pending alarm');
  assert.ok(storage.map.has(SESSION_DESTROYED_KEY), 'destroy writes the tombstone (survives deleteAll)');
  assert.equal(host._w1SessionDestroyed, true, 'destroy flags the live instance');
  assert.equal(storage.map.get(ISOLATE_GEN_KEY), 3,
    'destroy re-persists the isolate generation (deleteAll wiped it; a gen-1 restart would misclassify pre-destroy stragglers as current-generation)');
  console.log('  [5] rpcDestroy deletes the alarm, re-persists isolateGen, and leaves the tombstone');

  // Legitimate re-initialization of the SAME session id (documented SDK
  // flow) lifts the tombstone so the recreated session's janitor arms again.
  clearDestroyedTombstone(host, { storage });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(host._w1SessionDestroyed, false, 're-init clears the destroyed flag');
  assert.ok(!storage.map.has(SESSION_DESTROYED_KEY), 're-init deletes the tombstone key');
  host._w1JanitorArmed = false;
  ensureLogJanitor(host, { storage });
  await host._w1AlarmChain;
  assert.ok(storage.alarm !== null, 'the recreated session arms the janitor again');
  // And a no-op on a live session (no spurious deletes).
  const deletes = [];
  clearDestroyedTombstone(host, { storage: { delete: async (k) => { deletes.push(k); } } });
  assert.equal(deletes.length, 0, 'clear is a no-op when the session was never destroyed');
  console.log('  [5b] a recreated session id lifts the tombstone and can arm the janitor again');
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

console.log('session-alarm-lifecycle OK: alarm RMWs serialized, janitor idle-stop/re-arm, destroy tombstone, broadcast rewire');
