#!/usr/bin/env bun
// Arming a timer while a dispatch runs its handlers must complete, not wait
// for them: from inside a handler, or from anywhere else.
//
// The hazard: `timers.schedule` serializes through a per-host chain, so an
// arm queued behind a dispatch's handlers waits for whatever they wait for.
// A handler that AWAITS an arm, or waits on work that does (a launch's chunk
// the alarm granted, PacedWork.pump), never finishes, and neither does the
// arm. An embedder's schedule callback that queues into an outbox does it
// from inside, because `Outbox.queue` awaits `timers.schedule`.
//
// The contract under test: only the reason map's read-modify-writes are on
// the chain, never a handler, so an arm lands while handlers run; the
// dispatcher's re-arm reads the map again and keeps it, earliest-deadline-
// first, and a reason it fired goes only if it still holds the fired deadline.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { timers, TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';
import { outbox } from '../../packages/fabric/src/outbox.ts';
import { PacedWork, TurnBudget } from '../../packages/fabric/src/turn-budget.ts';

function createCtx(db = new Database(':memory:')) {
  const kv = new Map();
  const alarms = [];
  return {
    kv,
    alarms,
    storage: {
      sql: {
        exec(query, ...params) {
          if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP)/i.test(query)) {
            db.query(query).run(...params);
            return [];
          }
          return db.query(query).all(...params);
        },
      },
      async get(key) { return kv.get(key); },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { return kv.delete(key); },
      setAlarm(at) { alarms.push(at); },
    },
  };
}

/** Fail loudly instead of hanging the sweep if the deadlock regresses. */
async function mustComplete(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: deadlocked (did not complete in 2s)`)), 2000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── 1. A handler that AWAITS scheduling another reason completes ───────────

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('first', now - 10);

  let armed = false;
  await mustComplete(
    timers(host, ctx).dispatch({
      first: async () => {
        armed = await timers(host, ctx).schedule('second', now + 60_000);
      },
    }),
    'schedule awaited inside a handler',
  );
  assert.equal(armed, true);
  // The arm landed in the map and the platform alarm covers it.
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { second: now + 60_000 });
  assert.equal(ctx.alarms.at(-1), now + 60_000);
}

// ── 2. Earliest-deadline-first holds across handler arms and re-arms ───────

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('worker', now - 10);
  // `dispatchedAt` is the dispatch's own clock, not the wall reading above:
  // under pool load a millisecond can pass between capturing `now` and the
  // dispatch running, so asserting handler arms (all computed off `n`)
  // against `now` flakes. The property under test is earliest-deadline
  // across the handler's own arms, which share `n` as their base.
  let dispatchedAt = -1;
  await mustComplete(
    timers(host, ctx).dispatch({
      worker: async (n) => {
        dispatchedAt = n;
        await timers(host, ctx).schedule('late', n + 90_000);
        await timers(host, ctx).schedule('soon', n + 1_000);
        // A second arm for the same reason keeps the sooner deadline.
        await timers(host, ctx).schedule('late', n + 80_000);
        await timers(host, ctx).schedule('late', n + 95_000);
        return { rearmAt: n + 30_000 };
      },
    }),
    'multiple arms inside a handler',
  );
  const map = ctx.kv.get(TIMER_REASONS_KEY);
  assert.deepEqual(map.soon !== undefined && map.late !== undefined && map.worker !== undefined, true);
  assert.equal(map.late, dispatchedAt + 80_000);
  assert.equal(ctx.alarms.at(-1), Math.min(...Object.values(map)));
}

// ── 3. The real consumer: an outbox queued from a schedule handler ─────────

{
  const ctx = createCtx();
  const host = {};
  const sent = [];
  const box = outbox(host, ctx, 'mail', {
    maxAttempts: 3,
    baseMs: 1000,
    send: async (message) => { sent.push(message); return { status: 'sent' }; },
  });

  const now = Date.now();
  await timers(host, ctx).schedule('job', now - 10);
  await mustComplete(
    timers(host, ctx).dispatch({
      job: async () => {
        // Outbox.queue awaits timers.schedule internally — the exact call
        // shape that deadlocked.
        await box.queue({ to: 'owner' });
      },
      [box.reason]: box.handler(),
    }),
    'outbox.queue inside a handler',
  );
  // The queue's arm survived into the map; a following dispatch drains it.
  assert.ok(ctx.kv.get(TIMER_REASONS_KEY)[box.reason] !== undefined);
  await timers(host, ctx).dispatch({ [box.reason]: box.handler() });
  assert.deepEqual(sent, [{ to: 'owner' }]);
}

// ── 4. An arm during the legacy-alarm path still lands ─────────────────────

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  let legacy = false;
  await mustComplete(
    timers(host, ctx).dispatch(
      {},
      () => {
        legacy = true;
        void timers(host, ctx).schedule('recovered', now + 5_000);
      },
    ),
    'schedule inside onLegacyAlarm',
  );
  assert.equal(legacy, true);
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { recovered: now + 5_000 });
  assert.equal(ctx.alarms.at(-1), now + 5_000);
}

// ── 5. A launch whose granted chunk arms from its own turn is not parked ───
//
// The session's shape (FacetManager.launchPump): the alarm's
// 'resident-launch' handler pumps the paced launches and awaits the chunk
// each resumed one runs (PacedWork.pump). The chunk below awaits an arm made
// in the launch's own async context, not the handler's (PeerHost.armWatch
// awaits one so); queued behind the handler, it waited for the chunk that
// waited for it, and the launch never finished.

{
  const ctx = createCtx();
  const host = {};
  const pump = new PacedWork(ctx, { requestTurn: (notBefore) => timers(host, ctx).arm('resident-launch', Math.max(Date.now(), notBefore ?? 0)) });
  const budget = new TurnBudget(pump, 10);
  const launch = (async () => {
    await budget.spend(10);
    await timers(host, ctx).arm('hosting-watch', Date.now() + 60_000);
    budget.settle();
    return 'launched';
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ctx.kv.get(TIMER_REASONS_KEY)['resident-launch'] !== undefined, 'the launch asked for its turn');
  await mustComplete(timers(host, ctx).dispatch({ 'resident-launch': () => pump.pump() }), 'the alarm granting the launch its turn');
  assert.equal(await mustComplete(launch, 'the launch'), 'launched');
  assert.deepEqual(Object.keys(ctx.kv.get(TIMER_REASONS_KEY)), ['hosting-watch']);
}

// ── 6. An arm from another turn lands while a handler still waits ──────────
//
// It queues behind no handler: it is in the map, and the platform alarm
// covers it, before the dispatch's handler is let go.

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('slow', now - 10);

  let releaseHandler;
  const gate = new Promise((resolve) => { releaseHandler = resolve; });
  const dispatchDone = timers(host, ctx).dispatch({
    slow: async () => { await gate; },
  });

  // Give the dispatch time to enter the handler, then schedule from an
  // unrelated async context (this test turn).
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await mustComplete(timers(host, ctx).schedule('from-outside', now + 40_000), 'an arm while a handler waits'), true);
  assert.equal(ctx.kv.get(TIMER_REASONS_KEY)['from-outside'], now + 40_000);
  // The fired reason stays in the map until its handler is done: an alarm
  // retried after a reset here fires it again.
  assert.equal(ctx.kv.get(TIMER_REASONS_KEY).slow, now - 10);

  releaseHandler();
  await mustComplete(dispatchDone, 'dispatch with a slow handler');
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { 'from-outside': now + 40_000 });
  assert.equal(ctx.alarms.at(-1), now + 40_000);
}

// ── 7. Without setAlarm, an arm refuses, inside a handler as outside ───────

{
  const ctx = createCtx();
  delete ctx.storage.setAlarm;
  const host = {};
  const now = Date.now();
  // An arm refuses on a runtime without alarms.
  assert.equal(await timers(host, ctx).schedule('nope', now), false);
  // And from inside a handler. Seed the map directly, since schedule()
  // cannot arm without setAlarm.
  ctx.kv.set(TIMER_REASONS_KEY, { seeded: now - 10 });
  let armed = null;
  await mustComplete(
    timers(host, ctx).dispatch({
      seeded: async () => { armed = await timers(host, ctx).schedule('inside', now + 1000); },
    }),
    'in-dispatch arm without setAlarm',
  );
  assert.equal(armed, false);
  assert.equal(ctx.kv.get(TIMER_REASONS_KEY), undefined);
}

// ── 8. Work a handler started and did not await arms after the dispatch ───
//
// A cold-start alarm re-drives an interrupted resident launch without
// awaiting it (fenced-work.ts recoverInterrupted: the launch asks for its next
// turn through this same alarm). That launch keeps the handler's async
// context; when it arms after the dispatch is done, the arm must land: a
// launch past one turn's budget (TURN_CHUNK_MAX_BYTES) re-driven so waited
// forever for a turn (workspace-egress-reset-recovery-workerd, a resident's
// image over the budget).

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('resident-launch', now - 10);

  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  let launchArm;
  await mustComplete(
    timers(host, ctx).dispatch({
      'resident-launch': () => {
        launchArm = (async () => {
          await launchGate;
          return timers(host, ctx).schedule('resident-launch', now + 1);
        })();
      },
    }),
    'dispatch that starts a detached launch',
  );
  releaseLaunch();
  assert.equal(await mustComplete(launchArm, 'a detached arm after the dispatch'), true);
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { 'resident-launch': now + 1 });
  assert.equal(ctx.alarms.at(-1), now + 1);
}

// ── 9. A reason armed again from outside while its handler runs is kept ────
//
// Its fired deadline is still in the map then, and earlier than the new
// one: the re-arm is no later request to ignore, and the dispatch, which
// drops the deadline it fired, keeps the one armed since.

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('resident-launch', now - 10);
  let releaseHandler;
  const gate = new Promise((resolve) => { releaseHandler = resolve; });
  const dispatchDone = timers(host, ctx).dispatch({ 'resident-launch': async () => { await gate; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await mustComplete(timers(host, ctx).schedule('resident-launch', now + 5), 'the fired reason armed again'), true);
  releaseHandler();
  await mustComplete(dispatchDone, 'dispatch of the re-armed reason');
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { 'resident-launch': now + 5 });
  assert.equal(ctx.alarms.at(-1), now + 5);
}

// ── 10. A turn armed for the running alarm's own instant fires after it ────
//
// The platform takes an alarm set to the time it is running as no change,
// and counts it delivered once the handler returns.

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('resident-launch', now - 10);
  await mustComplete(
    timers(host, ctx).dispatch(
      { 'resident-launch': () => timers(host, ctx).schedule('resident-launch', now - 10) },
      undefined,
      { isRetry: false, retryCount: 0, scheduledTime: now - 10 },
    ),
    'a turn armed for the running alarm',
  );
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { 'resident-launch': now - 10 });
  assert.equal(ctx.alarms.at(-1), now - 9);
}

// ── 11. A re-arm of a fired reason whose write fails is retried, not lost ──
//
// Its fired deadline stays the one the dispatch drops until a write of the
// new one lands: the retry replaces it again, and the dispatch keeps that.

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('resident-launch', now - 10);
  const put = ctx.storage.put;
  let failures = 1;
  ctx.storage.put = async (key, value) => {
    if (failures-- > 0) throw new Error('storage down');
    return put(key, value);
  };
  await mustComplete(
    timers(host, ctx).dispatch({ 'resident-launch': () => timers(host, ctx).arm('resident-launch', now + 5) }),
    'a re-arm retried inside its dispatch',
  );
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { 'resident-launch': now + 5 });
}

// ── 12. A re-arm whose map write landed but whose alarm did not is kept ────
//
// The retry finds its deadline already in the map and writes nothing; its
// arm still takes the reason from what the dispatch drops.

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('resident-launch', now - 10);
  const setAlarm = ctx.storage.setAlarm;
  let failures = 1;
  ctx.storage.setAlarm = (at) => {
    if (failures-- > 0) return Promise.reject(new Error('alarm down'));
    return setAlarm(at);
  };
  await mustComplete(
    timers(host, ctx).dispatch({ 'resident-launch': () => timers(host, ctx).arm('resident-launch', now + 5) }),
    'a re-arm whose alarm failed once',
  );
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { 'resident-launch': now + 5 });
  assert.equal(ctx.alarms.at(-1), now + 5);
}

// ── 13. A reset while the dispatch reads the map back writes nothing ───────

{
  const ctx = createCtx();
  const host = {};
  const now = Date.now();
  await timers(host, ctx).schedule('resident-launch', now - 10);
  const get = ctx.storage.get;
  let reads = 0;
  let releaseRead;
  ctx.storage.get = async (key) => {
    if (++reads === 2) await new Promise((resolve) => { releaseRead = resolve; });
    return get(key);
  };
  const dispatched = timers(host, ctx).dispatch({ 'resident-launch': () => ({ rearmAt: now + 1_000 }) });
  while (releaseRead === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
  timers(host, ctx).reset();
  ctx.kv.clear();
  const alarms = ctx.alarms.length;
  releaseRead();
  await mustComplete(dispatched, 'a dispatch reset while it reads the map back');
  assert.equal(ctx.kv.has(TIMER_REASONS_KEY), false);
  assert.equal(ctx.alarms.length, alarms);
}

console.log('fabric-timers-arm-during-dispatch: all assertions passed');
