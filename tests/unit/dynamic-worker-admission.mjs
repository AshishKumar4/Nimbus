#!/usr/bin/env bun
// Waiting for room on the Dynamic Worker ledger (Kinu ask 13).
//
// A Durable Object may have DO_DYNAMIC_WORKER_LIMIT distinct Dynamic Workers
// in flight. A holder ends its hold with the function beginLoaderFetch
// returned; before beginLoaderFetchWhenFree, nobody could be woken when that
// happened, so an embedder polled on a timer or saw only its own releases,
// and Nimbus's own pool polled the platform for 15 s. What has to hold:
//
//   (1) with headroom, or for a worker already held, the wait resolves at
//       once, holding the worker (its end function is beginLoaderFetch's);
//   (2) waiters are let in in the order they asked, one per freed slot and
//       no more, by anyone's release: a hold's end, a claim's release, a
//       begin on the key one waits for;
//   (3) a release in the same turn as the wait is not lost;
//   (4) an aborted wait rejects with the signal's reason, takes no hold,
//       and leaves its place to the next waiter;
//   (5) a fan-out's own dispatches count inside its claim, not twice;
//   (6) a limit refusal the ledger had room for (the platform still counts
//       a worker the ledger released) pauses every admission for a backoff
//       that doubles while refusals continue, and then lets waiters in;
//   (7) under a randomised load, no admission exceeds the limit, the order
//       holds, and every waiter that was not aborted gets in;
//   (8) a pooled call the platform refuses at the limit is sent again the
//       moment a hold ends, not at its next poll.

import assert from 'node:assert/strict';
import {
  beginLoaderFetch,
  beginLoaderFetchWhenFree,
  claimDynamicWorkers,
  DO_DYNAMIC_WORKER_LIMIT,
  dynamicWorkerHeadroom,
  loaderLedgerStats,
} from '../../packages/fabric/src/budgets.ts';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';

const CAP_MESSAGE = 'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.';

let ctxCount = 0;
const freshCtx = () => ({ id: { toString: () => `admission-${++ctxCount}` } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fill the ledger with `n` distinct holds; return their ends. */
function fill(ctx, n, prefix = 'held') {
  return Array.from({ length: n }, (_, i) => beginLoaderFetch(ctx, `${prefix}-${i}`));
}

/** Start a wait and record when (and whether) it was let in. */
function wait(ctx, key, options, log) {
  const entry = { key, end: null, error: null };
  entry.promise = beginLoaderFetchWhenFree(ctx, key, options).then(
    (end) => { entry.end = end; log?.push(key); },
    (error) => { entry.error = error; },
  );
  return entry;
}

// ── (1) at once, with headroom or for a held worker ─────────────────────────
{
  const ctx = freshCtx();
  const end = await beginLoaderFetchWhenFree(ctx, 'free');
  assert.equal(typeof end, 'function');
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, ['free'], 'the wait holds the worker it let in');
  end();
  end();
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT, 'its end is idempotent and frees the slot');

  const ends = fill(ctx, DO_DYNAMIC_WORKER_LIMIT);
  assert.equal(dynamicWorkerHeadroom(ctx), 0);
  const joined = await beginLoaderFetchWhenFree(ctx, 'held-3');
  assert.equal(loaderLedgerStats(ctx).waiting, 0, 'a held worker is joined, not queued');
  joined();
  assert.ok(loaderLedgerStats(ctx).inFlightWorkers.includes('held-3'), 'ending the join leaves the original hold');
  for (const e of ends) e();
}

// ── (2) order, one per slot, woken by any release ───────────────────────────
{
  const ctx = freshCtx();
  const ends = fill(ctx, DO_DYNAMIC_WORKER_LIMIT);
  const order = [];
  const waiters = ['w0', 'w1', 'w2', 'w3', 'w4'].map((key) => wait(ctx, key, {}, order));
  await tick();
  assert.deepEqual(order, [], 'nobody gets in while the ledger is full');
  assert.equal(loaderLedgerStats(ctx).waiting, 5);

  ends[0]();
  await tick();
  assert.deepEqual(order, ['w0'], 'one freed slot lets exactly the first waiter in');
  assert.equal(dynamicWorkerHeadroom(ctx), 0, 'and the slot is its own: no headroom is left over');

  ends[1]();
  ends[2]();
  await tick();
  assert.deepEqual(order, ['w0', 'w1', 'w2'], 'two freed slots, the next two, in order');

  // A begin on the key a waiter asks for lets it in: holds on one worker count once.
  const waitsOnHeld = wait(ctx, 'shared', {}, order);
  await tick();
  assert.equal(waitsOnHeld.end, null);
  const endShared = beginLoaderFetch(ctx, 'shared');
  await tick();
  assert.equal(typeof waitsOnHeld.end, 'function', 'a begin on the waited key lets its waiter in');
  assert.deepEqual(order.slice(3), ['shared'], 'ahead of waiters for new workers, which it costs nothing');
  waitsOnHeld.end();
  endShared();
  await tick();
  assert.deepEqual(order.slice(4), [], 'the begin went past the limit, so ending it leaves the ledger full');
  ends[3]();
  await tick();
  assert.deepEqual(order.slice(4), ['w3']);

  // A claim's release frees its whole width, which goes to the queue in order.
  for (const waiter of waiters.slice(0, 4)) waiter.end();
  await tick();
  assert.deepEqual(order.slice(5), ['w4']);
  for (const e of ends.slice(4)) e();
  const claim = claimDynamicWorkers(ctx, DO_DYNAMIC_WORKER_LIMIT - 1);
  assert.ok(claim);
  const behindClaim = ['c0', 'c1', 'c2'].map((key) => wait(ctx, key, {}, order));
  await tick();
  assert.deepEqual(order.slice(6), []);
  claim.release();
  await tick();
  assert.deepEqual(order.slice(6), ['c0', 'c1', 'c2']);
  waiters[4].end();
  for (const waiter of behindClaim) waiter.end();
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT);
}

// ── (3) a release in the same turn as the wait is not lost ──────────────────
{
  const ctx = freshCtx();
  const ends = fill(ctx, DO_DYNAMIC_WORKER_LIMIT);
  assert.equal(dynamicWorkerHeadroom(ctx), 0, 'the caller checked: no room');
  const waiter = wait(ctx, 'late');
  ends[0]();
  await waiter.promise;
  assert.equal(typeof waiter.end, 'function', 'the release right after the check let the waiter in');

  ends[1]();
  const after = wait(ctx, 'after');
  await after.promise;
  assert.equal(typeof after.end, 'function', 'a wait right after a release sees the slot');
  waiter.end();
  after.end();
  for (const e of ends.slice(2)) e();
}

// ── (4) abort ───────────────────────────────────────────────────────────────
{
  const ctx = freshCtx();
  const ends = fill(ctx, DO_DYNAMIC_WORKER_LIMIT);
  const order = [];
  const controller = new AbortController();
  const aborted = wait(ctx, 'gives-up', { signal: controller.signal }, order);
  const next = wait(ctx, 'next', {}, order);
  controller.abort(new Error('caller gave up'));
  await aborted.promise;
  assert.equal(aborted.error?.message, 'caller gave up', 'the wait rejects with the signal reason');
  assert.equal(loaderLedgerStats(ctx).waiting, 1, 'and leaves the queue');
  ends[0]();
  await tick();
  assert.deepEqual(order, ['next'], 'its place goes to the next waiter');
  assert.ok(!loaderLedgerStats(ctx).inFlightWorkers.includes('gives-up'), 'an aborted wait holds nothing');

  const already = AbortSignal.abort(new Error('already'));
  const pre = wait(ctx, 'pre', { signal: already });
  await pre.promise;
  assert.equal(pre.error?.message, 'already', 'an aborted signal refuses even a wait that would get in');
  assert.ok(!loaderLedgerStats(ctx).inFlightWorkers.includes('pre'));
  next.end();
  for (const e of ends.slice(1)) e();
}

// ── (5) a claim's own dispatches count inside it ────────────────────────────
{
  const ctx = freshCtx();
  const claim = claimDynamicWorkers(ctx, 4);
  const inside = ['t0', 't1', 't2', 't3'].map((key) => beginLoaderFetch(ctx, key, claim));
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT - 4, 'four tasks in a claim of four spend four');
  const outside = fill(ctx, DO_DYNAMIC_WORKER_LIMIT - 4, 'other');
  assert.equal(dynamicWorkerHeadroom(ctx), 0);
  inside[0]();
  // The claim keeps its width until released; a task inside it waiting for
  // a fresh worker gets the freed slot of the claim, not the ledger's.
  const retried = await beginLoaderFetchWhenFree(ctx, 't0-retry', { claim });
  assert.equal(dynamicWorkerHeadroom(ctx), 0, 'the claim slot was reused, nobody else lost one');
  retried();
  for (const e of inside.slice(1)) e();
  claim.release();
  assert.equal(dynamicWorkerHeadroom(ctx), 4);
  for (const e of outside) e();
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT);
}

// ── (6) a refusal the ledger had room for pauses admission ──────────────────
{
  const ctx = freshCtx();
  const resident = beginLoaderFetch(ctx, 'resident');
  const end = beginLoaderFetch(ctx, 'refused-1');
  end(new Error(CAP_MESSAGE));
  assert.equal(loaderLedgerStats(ctx).pauseMs, 50, 'the refusal pauses admission');
  assert.equal(dynamicWorkerHeadroom(ctx), 0, 'and no headroom is offered while it lasts');
  const join = await beginLoaderFetchWhenFree(ctx, 'resident');
  assert.equal(loaderLedgerStats(ctx).pauseMs, 50, 'a worker already held is joined while paused');
  join();
  const started = Date.now();
  const first = await beginLoaderFetchWhenFree(ctx, 'retry-1');
  const firstWait = Date.now() - started;
  assert.ok(firstWait >= 40, `a new worker waits the pause out (${firstWait} ms)`);
  assert.equal(loaderLedgerStats(ctx).pauseMs, 0);
  first(new Error(CAP_MESSAGE));
  assert.equal(loaderLedgerStats(ctx).pauseMs, 100, 'a refusal again, right after the pause, doubles it');
  const second = await beginLoaderFetchWhenFree(ctx, 'retry-2');
  second();
  assert.equal(loaderLedgerStats(ctx).pauseMs, 0);

  // The platform let a new worker in, so the next refusal starts over; and
  // the calls of one batch refused together pause once, not once each.
  const batch = ['batch-a', 'batch-b', 'batch-c'].map((key) => beginLoaderFetch(ctx, key));
  for (const e of batch) e(new Error(CAP_MESSAGE));
  assert.equal(loaderLedgerStats(ctx).pauseMs, 50, 'one pause for a batch refused together');
  await beginLoaderFetchWhenFree(ctx, 'drain').then((e) => e());
  resident();
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT);
}

// ── (7) stress ──────────────────────────────────────────────────────────────
{
  const ctx = freshCtx();
  // A seeded generator, so a failure replays.
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const held = new Map();
  let peak = 0;
  const requested = [];
  const outcomes = [];
  const KEYS = 40;
  for (let i = 0; i < 400; i++) {
    const key = `k${Math.floor(random() * KEYS)}`;
    const controller = random() < 0.15 ? new AbortController() : null;
    requested.push({ i, key, aborts: controller !== null });
    outcomes.push(beginLoaderFetchWhenFree(ctx, key, controller ? { signal: controller.signal } : {}).then(
      async (end) => {
        held.set(key, (held.get(key) ?? 0) + 1);
        peak = Math.max(peak, held.size);
        assert.ok(held.size <= DO_DYNAMIC_WORKER_LIMIT, `admitted past the limit: ${held.size}`);
        await sleep(Math.floor(random() * 4));
        const open = held.get(key) - 1;
        if (open > 0) held.set(key, open); else held.delete(key);
        end();
        return 'in';
      },
      () => 'aborted',
    ));
    if (controller) setTimeout(() => controller.abort(new Error('stress abort')), Math.floor(random() * 6));
    if (random() < 0.3) await tick();
  }
  const results = await Promise.all(outcomes);
  for (const [n, result] of results.entries()) {
    if (!requested[n].aborts) assert.equal(result, 'in', `waiter ${n} was never let in`);
  }
  assert.equal(peak, DO_DYNAMIC_WORKER_LIMIT, 'the load did fill the ledger');
  const stats = loaderLedgerStats(ctx);
  assert.equal(stats.waiting, 0);
  assert.deepEqual(stats.inFlightWorkers, []);
  assert.equal(stats.headroom, DO_DYNAMIC_WORKER_LIMIT);
}

// FIFO under load, without joins: distinct keys, each admitted in the order asked.
{
  const ctx = freshCtx();
  const order = [];
  const outcomes = [];
  for (let i = 0; i < 200; i++) {
    outcomes.push(beginLoaderFetchWhenFree(ctx, `fifo-${i}`).then(async (end) => {
      order.push(i);
      await sleep(i % 3);
      end();
    }));
  }
  await Promise.all(outcomes);
  assert.deepEqual(order, [...Array(200).keys()], 'distinct workers get in in the order they asked');
}

// ── (8) a pooled call refused at the limit goes again when a hold ends ──────
{
  const ctx = freshCtx();
  // The platform: an eleventh distinct worker is refused before it starts.
  const counted = new Set();
  let refused = 0;
  let ranAt = 0;
  const loader = {
    get(id) {
      return {
        getEntrypoint: () => ({
          async execute(arg) {
            if (!counted.has(id) && counted.size >= DO_DYNAMIC_WORKER_LIMIT) { refused++; throw new Error(CAP_MESSAGE); }
            ranAt = Date.now();
            return arg;
          },
        }),
      };
    },
  };
  const others = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => {
    counted.add(`resident-${i}`);
    return beginLoaderFetch(ctx, `resident-${i}`);
  });
  const pool = new IsolatePool({ LOADER: loader }, ctx, { omitSupervisor: true, timeoutMs: 0 });
  const started = Date.now();
  const result = pool.submit((value) => value, 'payload');
  const RELEASE_AT = 1000;
  await sleep(RELEASE_AT);
  counted.delete('resident-0');
  others[0]();
  assert.equal(await result, 'payload');
  const after = ranAt - started;
  assert.ok(refused >= 1, 'the platform refused the call at first');
  // Polling (50 ms doubling) would have sent it again at 1,550 ms.
  assert.ok(after >= RELEASE_AT && after < RELEASE_AT + 200, `sent again when the hold ended, at ${after} ms`);
  assert.equal(loaderLedgerStats(ctx).waiting, 0);
  for (const e of others.slice(1)) e();
  pool.dispose();
}

console.log('ok - dynamic-worker-admission (order, one per slot, abort, held keys, claims, refusal pause, stress, pool wakes on release)');
