#!/usr/bin/env bun
// Arming a timer from inside a dispatch handler must complete, not deadlock.
//
// The hazard: `timers.schedule` serializes through the same per-host chain
// as `dispatch`, so a handler that AWAITS a schedule call is waiting on a
// chain entry queued behind the dispatch it is running inside. Nothing
// exotic reaches this — an embedder's schedule callback that queues into an
// outbox does exactly it, because `Outbox.queue` awaits `timers.schedule`.
//
// The contract under test: while a dispatch runs its handlers, schedule
// requests for the SAME host are collected and folded into the reason map
// before the dispatcher's own re-arm, earliest-deadline-first — so the
// await resolves, the arm lands, and the platform alarm covers it.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { timers, TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';
import { outbox } from '../../packages/fabric/src/outbox.ts';

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

  await mustComplete(
    timers(host, ctx).dispatch({
      worker: async (n) => {
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
  assert.equal(map.late, now + 80_000);
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

console.log('fabric-timers-arm-during-dispatch: all assertions passed');
