#!/usr/bin/env bun
// The schedule store: Agents-SDK-shaped rows (agents 0.20.1 dist,
// cf_agents_schedules) dispatched by method name, with the two mechanical
// upgrades fabric demands:
//
//   - DURABLE RETRIES: a failed attempt writes the backed-off deadline into
//     the row (min(maxDelayMs, base * 2**(attempt-1))) instead of sleeping
//     in-process; the attempt budget survives an instance reset because it
//     IS the row.
//   - alarmInfo REACHES THE CALLBACK: the platform's isRetry/retryCount
//     report rides the invocation argument (the Agents SDK drops it).
//
// Times are epoch milliseconds, matching fabric's timer map.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { ScheduleStore, SCHEDULE_RETRY_DEFAULTS } from '../../packages/loom/src/schedules.ts';

function createCtx(db = new Database(':memory:')) {
  return {
    db,
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
    },
  };
}

const T0 = 1_700_000_000_000; // a fixed epoch-ms origin so cron math is exact

// ── 1. The three `when` forms, and dispatch by method name ─────────────────

{
  const store = new ScheduleStore(createCtx());
  const calls = [];
  const target = {
    remind(payload, invocation) { calls.push({ payload, invocation }); },
  };

  const delayed = store.create(60, 'remind', { what: 'tea' }, { now: T0 });
  assert.equal(delayed.type, 'delayed');
  assert.equal(delayed.delayInSeconds, 60);
  assert.equal(delayed.time, T0 + 60_000);
  assert.equal(delayed.callback, 'remind');
  assert.deepEqual(delayed.payload, { what: 'tea' });

  const dated = store.create(new Date(T0 + 500_000), 'remind', 'later', { now: T0 });
  assert.equal(dated.type, 'scheduled');
  assert.equal(dated.time, T0 + 500_000);

  // Not due yet: nothing fires, rearm points at the earliest deadline.
  const early = await store.dispatchDue(target, T0);
  assert.equal(early.ran, 0);
  assert.equal(early.rearmAt, delayed.time);

  const info = { isRetry: true, retryCount: 2, scheduledTime: T0 + 60_000 };
  const fired = await store.dispatchDue(target, T0 + 60_000, info);
  assert.equal(fired.ran, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload, { what: 'tea' });
  assert.equal(calls[0].invocation.attempt, 1);
  assert.equal(calls[0].invocation.schedule.id, delayed.id);
  // The platform's alarm report reaches the callback.
  assert.deepEqual(calls[0].invocation.alarmInfo, info);
  // One-shot rows are gone after they run; the dated one remains.
  assert.equal(store.byId(delayed.id), undefined);
  assert.equal(store.byId(dated.id).id, dated.id);
  assert.equal(fired.rearmAt, dated.time);
}

// ── 2. Cron: computed at create, recomputed per fire, invalid throws now ────

{
  const store = new ScheduleStore(createCtx());
  const runs = [];
  const target = { tick(payload, { schedule }) { runs.push(schedule.time); } };

  // T0 is 2023-11-14T22:13:20Z; the next whole hour is 23:00:00.
  const hourly = store.create('0 * * * *', 'tick', undefined, { now: T0 });
  assert.equal(hourly.type, 'cron');
  assert.equal(hourly.cron, '0 * * * *');
  assert.equal(new Date(hourly.time).getUTCMinutes(), 0);
  assert.ok(hourly.time > T0 && hourly.time <= T0 + 3_600_000);

  await store.dispatchDue(target, hourly.time);
  assert.equal(runs.length, 1);
  const advanced = store.byId(hourly.id);
  assert.equal(advanced.time, hourly.time + 3_600_000);

  assert.throws(() => store.create('not a cron', 'tick'), /./);
  assert.throws(() => store.create(-5, 'tick'), /non-negative number of seconds/);
  assert.throws(() => store.create(true, 'tick'), /invalid schedule time/);
  assert.throws(() => store.create(60, ''), /must be a method name/);
}

// ── 3. Intervals re-arm from the dispatch that ran them ────────────────────

{
  const store = new ScheduleStore(createCtx());
  let ticks = 0;
  const target = { pulse() { ticks++; } };

  const interval = store.every(30, 'pulse', undefined, { now: T0 });
  assert.equal(interval.type, 'interval');
  assert.equal(interval.intervalSeconds, 30);
  assert.equal(interval.time, T0 + 30_000);

  await store.dispatchDue(target, T0 + 30_000);
  assert.equal(ticks, 1);
  assert.equal(store.byId(interval.id).time, T0 + 60_000);

  assert.throws(() => store.every(0, 'pulse'), /positive number of seconds/);
}

// ── 4. byId, list criteria, cancel ──────────────────────────────────────────

{
  const store = new ScheduleStore(createCtx());
  const a = store.create(10, 'x', undefined, { now: T0 });
  const b = store.create(new Date(T0 + 90_000), 'y', undefined, { now: T0 });
  const c = store.every(120, 'z', undefined, { now: T0 });

  assert.deepEqual(store.list().map((s) => s.id), [a.id, b.id, c.id]);
  assert.deepEqual(store.list({ type: 'interval' }).map((s) => s.id), [c.id]);
  assert.deepEqual(store.list({ id: b.id }).map((s) => s.id), [b.id]);
  assert.deepEqual(
    store.list({ timeRange: { start: new Date(T0 + 20_000), end: new Date(T0 + 100_000) } }).map((s) => s.id),
    [b.id],
  );

  assert.equal(store.cancel(b.id), true);
  assert.equal(store.cancel(b.id), false);
  assert.equal(store.byId(b.id), undefined);
  assert.equal(store.nextDue(), a.time);
}

// ── 5. Durable retries: backoff lives in the row, exhaustion advances ───────

{
  const store = new ScheduleStore(createCtx());
  const failures = [];
  let attemptsSeen = [];
  const target = {
    flaky(_payload, { attempt }) { attemptsSeen.push(attempt); throw new Error('still broken'); },
  };

  const s = store.create(0, 'flaky', undefined, { now: T0 });
  const onError = (schedule, error) => failures.push({ id: schedule.id, message: error.message });

  // Attempt 1 fails: the row survives with the backed-off deadline.
  await store.dispatchDue(target, T0, undefined, onError);
  let row = store.byId(s.id);
  assert.equal(row.time, T0 + SCHEDULE_RETRY_DEFAULTS.baseDelayMs);
  assert.equal(failures.length, 0);

  // Attempt 2 fails: backoff doubles.
  await store.dispatchDue(target, row.time, undefined, onError);
  row = store.byId(s.id);
  assert.equal(row.time, T0 + 100 + 200);

  // Attempt 3 is the last of the default budget: onError fires, the
  // one-shot row is gone.
  await store.dispatchDue(target, row.time, undefined, onError);
  assert.equal(store.byId(s.id), undefined);
  assert.deepEqual(attemptsSeen, [1, 2, 3]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'still broken');
}

// ── 6. Per-schedule retry policy, and recurring rows outlive exhaustion ────

{
  const store = new ScheduleStore(createCtx());
  const failures = [];
  const target = { flaky() { throw new Error('nope'); } };

  const s = store.every(60, 'flaky', undefined, { now: T0, retry: { maxAttempts: 1 } });
  await store.dispatchDue(target, T0 + 60_000, undefined, (sched, e) => failures.push(e.message));
  // maxAttempts 1: no retry row, straight to onError — but an interval
  // advances instead of dying, with its attempt budget reset.
  assert.equal(failures.length, 1);
  const advanced = store.byId(s.id);
  assert.equal(advanced.time, T0 + 120_000);
  assert.deepEqual(advanced.retry, { maxAttempts: 1 });
}

// ── 7. A missing method never retries ───────────────────────────────────────

{
  const store = new ScheduleStore(createCtx());
  const failures = [];
  store.create(0, 'vanished', undefined, { now: T0 });
  await store.dispatchDue({}, T0, undefined, (_s, e) => failures.push(e.message));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /'this\.vanished' is not a method on this actor/);
  assert.equal(store.nextDue(), null);
}

// ── 8. Rows persist across store instances (an instance reset) ─────────────

{
  const ctx = createCtx();
  const first = new ScheduleStore(ctx);
  const s = first.create(5, 'wake', 'payload survives', { now: T0 });

  const second = new ScheduleStore(ctx);
  const seen = [];
  await second.dispatchDue({ wake(p) { seen.push(p); } }, T0 + 5_000);
  assert.deepEqual(seen, ['payload survives']);
  assert.equal(second.byId(s.id), undefined);
}

// ── 9. An undefined payload arrives as undefined ────────────────────────────

{
  const store = new ScheduleStore(createCtx());
  const seen = [];
  store.create(0, 'bare', undefined, { now: T0 });
  await store.dispatchDue({ bare(p) { seen.push(p); } }, T0);
  assert.deepEqual(seen, [undefined]);
}

console.log('loom-schedules: all assertions passed');
