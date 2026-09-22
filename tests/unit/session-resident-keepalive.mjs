#!/usr/bin/env bun
// The resident keep-alive alarm: a session hosting a long-running process
// must hold itself in memory for as long as that process runs.
//
// The platform evicts a Durable Object after roughly ten seconds with no
// in-flight EVENT, and a pending `ctx.waitUntil(handle.done)` is not one.
// Facets die with their parent, so an evicted session takes its resident
// processes with it and the launch journal re-drives them under a new pid
// namespace — losing the attached terminal and the bound port. A quiet
// process (a server between requests, a TUI between keystrokes) sends no RPC
// of its own, so the alarm is the only event the session gets.
//
// What is asserted here:
//   - a running resident arms 'resident-keepalive' at the measured cadence;
//   - dispatching while it runs re-arms at the same cadence (the fire is the
//     whole payload — it does no work);
//   - once the resident is gone, one dispatch clears the reason and the
//     armed flag, so an abandoned session stops waking (the zombie-alarm
//     rule the log-janitor learned the hard way);
//   - a SHORT process cannot hold the cycle open — `stats.running` counts it
//     and `residentRunning` does not, which is why the getter exists;
//   - a destroyed session never arms;
//   - an ABANDONED session stops: with no socket attached and no request
//     within RESIDENT_KEEPALIVE_DETACHED_MS, the resident alone does not
//     re-arm, so a dev server whose user closed the tab idles out as it did
//     before the keep-alive existed (the launch journal re-drives it when
//     the user returns). Bounded by the resident alone, every abandoned
//     session with a watcher ran forever in the isolate all sessions share;
//   - an attached socket, or a request, keeps it; a client's return
//     re-arms a lapsed cycle without a new spawn.

import assert from 'node:assert/strict';
import {
  ensureResidentKeepalive,
  noteClientActivity,
  dispatchAlarm,
} from '../../packages/worker/src/session/hibernation.ts';
import { timers, TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';
// The cadence is the platform wall itself, read from where it is measured —
// @nimbus-sh/platform/limits — so this test cannot drift from the fix.
import { RESIDENT_KEEPALIVE_DETACHED_MS, RESIDENT_KEEPALIVE_MS } from '../../packages/platform/src/limits.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

function makeStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get alarm() { return alarm; },
    async get(k) { return map.get(k); },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async deleteAll() { map.clear(); },
    async deleteAlarm() { alarm = null; },
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
    _w1JanitorArmed: false,
    _w1KeepaliveArmed: false,
    _w1LastClientActivityAt: Date.now(),
    _w1SessionDestroyed: false,
  };
}

/** Pull a scheduled deadline into the past, as the firing alarm would. */
function expire(storage, reason) {
  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(map && reason in map, `${reason} is pending before it can fire`);
  map[reason] = Date.now() - 1;
}

// ── [1] a running resident arms the cycle at the measured cadence ──────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  host.processes.spawn('vite dev', [], '/home/user', { longRunning: true });

  const before = Date.now();
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;
  const after = Date.now();

  assert.equal(host._w1KeepaliveArmed, true, 'the resident spawn armed the cycle');
  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(map && 'resident-keepalive' in map, `reason scheduled: ${JSON.stringify(map)}`);
  const at = map['resident-keepalive'];
  assert.ok(
    at >= before + RESIDENT_KEEPALIVE_MS && at <= after + RESIDENT_KEEPALIVE_MS,
    `scheduled at now + RESIDENT_KEEPALIVE_MS (got ${at - before}ms out, cadence ${RESIDENT_KEEPALIVE_MS}ms)`,
  );
  assert.equal(storage.alarm, at, 'the platform alarm is armed at that deadline');
  console.log('  [1] a running resident arms resident-keepalive at the measured cadence');
}

// ── [2] the cycle re-arms while the resident still runs ───────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  host.processes.spawn('vite dev', [], '/home/user', { longRunning: true });
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;

  // Idempotent: a second resident spawn in the same instance must not
  // re-schedule anything — the flag is the whole dedupe.
  const armedAt = storage.map.get(TIMER_REASONS_KEY)['resident-keepalive'];
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;
  assert.equal(
    storage.map.get(TIMER_REASONS_KEY)['resident-keepalive'], armedAt,
    'a second arm call while armed changes nothing',
  );

  expire(storage, 'resident-keepalive');
  const before = Date.now();
  await dispatchAlarm(host, ctx, () => true);

  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(map && 'resident-keepalive' in map, 'a live resident keeps the cycle armed');
  const at = map['resident-keepalive'];
  assert.ok(
    at >= before + RESIDENT_KEEPALIVE_MS && at <= Date.now() + RESIDENT_KEEPALIVE_MS,
    `re-armed one cadence out (got ${at - before}ms, cadence ${RESIDENT_KEEPALIVE_MS}ms)`,
  );
  assert.equal(host._w1KeepaliveArmed, true, 'still believed armed after the re-arm');
  assert.equal(storage.alarm, at, 'the platform alarm follows the re-arm');
  console.log('  [2] dispatching while the resident runs re-arms at the same cadence');
}

// ── [3] the last resident exiting stops the cycle ─────────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  const pid = host.processes.spawn('vite dev', [], '/home/user', { longRunning: true }).pid;
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;

  host.processes.exit(pid, 0);
  assert.equal(host.processes.residentRunning, 0, 'the exited resident no longer counts');

  expire(storage, 'resident-keepalive');
  await dispatchAlarm(host, ctx, () => true);

  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(!map || !('resident-keepalive' in map), `reason cleared: ${JSON.stringify(map)}`);
  assert.equal(host._w1KeepaliveArmed, false, 'armed flag cleared so the next resident re-arms');

  // And the next resident does re-arm it, on the same instance.
  host.processes.spawn('pi', [], '/home/user', { longRunning: true });
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;
  assert.ok(
    storage.map.get(TIMER_REASONS_KEY)?.['resident-keepalive'],
    'a fresh resident re-arms the cycle on the same instance',
  );
  console.log('  [3] the last resident exiting clears the reason and the armed flag');
}

// ── [4] a short process alone cannot hold the session awake ───────────────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  // A foreground `node -e` is `running` for as long as its turn lasts, so
  // `stats.running` is not the question the keep-alive asks.
  host.processes.spawn('node -e 1+1', [], '/home/user');
  assert.ok(host.processes.stats.running > 0, 'the short process is running');
  assert.equal(host.processes.residentRunning, 0, 'but it is not a resident');

  // Nothing arms from a short spawn: the hook only fires for a long-running
  // one (hosted/services.ts onSpawn), and the arm itself declines while no
  // resident runs, so a client's activity cannot arm it either.
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;
  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(!map || !('resident-keepalive' in map), `short process does not arm: ${JSON.stringify(map)}`);
  assert.equal(host._w1KeepaliveArmed, false, 'and leaves nothing believed armed');
  console.log('  [4] a short process alone never keeps the cycle alive');
}

// ── [5] a destroyed session never arms ────────────────────────────────────
{
  const storage = makeStorage();
  const host = makeHost();
  host._w1SessionDestroyed = true;
  // A straggler facet RPC that wakes the dead DO and spawns must not leave an
  // eternal keep-alive loop behind it.
  host.processes.spawn('vite dev', [], '/home/user', { longRunning: true });
  ensureResidentKeepalive(host, { storage });
  await host._timerChain;

  assert.equal(storage.alarm, null, 'destroyed session schedules nothing');
  assert.equal(storage.map.get(TIMER_REASONS_KEY), undefined, 'and writes no reason');
  assert.equal(host._w1KeepaliveArmed, false, 'and is never believed armed');
  console.log('  [5] a destroyed session never arms the keep-alive');
}

// ── [6] the keep-alive shares the mux without clobbering a neighbour ──────
{
  const storage = makeStorage();
  const host = makeHost();
  const ctx = { storage };
  host.processes.spawn('vite dev', [], '/home/user', { longRunning: true });
  await Promise.all([
    timers(host, ctx).schedule('w9-flush', Date.now() + 1_000),
    (async () => { ensureResidentKeepalive(host, ctx); await host._timerChain; })(),
  ]);
  const map = storage.map.get(TIMER_REASONS_KEY);
  assert.ok(map && 'w9-flush' in map && 'resident-keepalive' in map,
    `both reasons survive concurrent scheduling: ${JSON.stringify(map)}`);
  assert.equal(storage.alarm, Math.min(...Object.values(map)),
    'the one platform alarm sits at the earliest deadline');
  console.log('  [6] the keep-alive coexists with the other timer reasons');
}

// ── [7] an abandoned session stops; a present client keeps it ─────────────
{
  const storage = makeStorage();
  const host = makeHost();
  let sockets = [];
  const ctx = { storage, getWebSockets: () => sockets };
  host.processes.spawn('vite dev', [], '/home/user', { longRunning: true });
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;
  // Within the grace, no socket: the client may be mid-reload.
  host._w1LastClientActivityAt = Date.now() - RESIDENT_KEEPALIVE_DETACHED_MS / 2;
  expire(storage, 'resident-keepalive');
  await dispatchAlarm(host, ctx, () => true);
  assert.ok('resident-keepalive' in storage.map.get(TIMER_REASONS_KEY), 'inside the grace the cycle re-arms');
  // Past the grace, no socket: abandoned. The resident still runs.
  host._w1LastClientActivityAt = Date.now() - RESIDENT_KEEPALIVE_DETACHED_MS - 1;
  expire(storage, 'resident-keepalive');
  await dispatchAlarm(host, ctx, () => true);
  assert.equal(host.processes.residentRunning, 1, 'the resident is still running');
  assert.ok(!('resident-keepalive' in (storage.map.get(TIMER_REASONS_KEY) ?? {})), 'past the grace the cycle stops');
  assert.equal(host._w1KeepaliveArmed, false, 'and the flag clears so a client can re-arm it');
  // An attached socket is presence, however long ago the last request was.
  sockets = [{}];
  ensureResidentKeepalive(host, ctx);
  await host._timerChain;
  expire(storage, 'resident-keepalive');
  await dispatchAlarm(host, ctx, () => true);
  assert.ok('resident-keepalive' in storage.map.get(TIMER_REASONS_KEY), 'an attached socket keeps the cycle');
  sockets = [];
  expire(storage, 'resident-keepalive');
  await dispatchAlarm(host, ctx, () => true);
  assert.equal(host._w1KeepaliveArmed, false, 'socket gone, grace long past: stopped again');
  // The client comes back over HTTP: that alone re-arms, no spawn needed.
  noteClientActivity(host, ctx);
  await host._timerChain;
  assert.equal(host._w1KeepaliveArmed, true, 'a request re-arms a lapsed cycle while the resident runs');
  assert.ok('resident-keepalive' in storage.map.get(TIMER_REASONS_KEY));
  // Activity with no resident arms nothing.
  const quiet = makeHost();
  noteClientActivity(quiet, { storage: makeStorage(), getWebSockets: () => [] });
  await quiet._timerChain;
  assert.equal(quiet._w1KeepaliveArmed, false, 'no resident, no keep-alive, whatever the client does');
  console.log('  [7] an abandoned session stops after the grace; a socket or a request keeps it');
}

console.log('session-resident-keepalive OK: arms on a resident, re-arms while it runs and a client is present, retires when either ends');
