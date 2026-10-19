#!/usr/bin/env bun
// A credit pool wakes its first waiter to its turn and never hands it the
// credit: the waiter takes it in its own continuation. workerd cancels the
// continuations of a request that ended when another request resolves its
// promise, so a waiter whose request is gone is woken and never takes. Its
// turn lapses after CREDIT_TURN_MS, holding nothing, and the next waiter's
// comes. Credit handed to such a waiter was held for the isolate's life,
// and every later ask for the whole budget waited forever.
//
// A turn that is never taken is what such a waiter is: queued, woken, and
// nothing after (CreditTurn). credit-pool-cross-request-workerd shows one in
// workerd itself.

import assert from 'node:assert/strict';
import { CREDIT_TURN_MS, WeightedCreditPool } from '../../packages/platform/src/weighted-credit-pool.ts';

const MiB = 1024 * 1024;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
/** `promise`, or a failure naming `what` after `ms`. */
const within = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
};

// ── a turn never taken holds nothing, lapses, and the next waiter's comes ─
{
  const pool = new WeightedCreditPool(40 * MiB);
  const held = await pool.acquire(40 * MiB);
  const gone = pool.queue(10 * MiB);
  let woken = false;
  gone.woken().then(() => { woken = true; });
  const whole = pool.acquire(40 * MiB);
  const started = Date.now();
  held.release();
  await settled();
  assert.equal(woken, true, 'the first waiter is woken to its turn');
  assert.equal(pool.stats.current, 0, 'and holds nothing until it takes it');
  assert.equal(pool.tryAcquire(MiB), null, 'its turn is kept for it: nothing passes it');
  const lease = await within(whole, 4 * CREDIT_TURN_MS, 'the waiter after a turn never taken is served');
  assert.ok(Date.now() - started >= CREDIT_TURN_MS, 'once that turn lapsed');
  assert.equal(pool.stats.current, 40 * MiB);
  assert.equal(gone.take(), null, 'taken late, the lapsed turn holds nothing: it waits again, at the end of the line');
  lease.release();
  const late = await within(gone.woken().then(() => gone.take()), 4 * CREDIT_TURN_MS, 'the late waiter is woken again');
  assert.equal(late.bytes, 10 * MiB);
  gone.leave();
  late.release();
  assert.equal(pool.stats.current, 0);
  assert.equal(pool.stats.queued, 0);
  console.log('  ✓ a turn never taken holds nothing and lapses; the next waiter is served');
}

// ── a turn taken in time: strict order, one turn at a time ───────────────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const held = await pool.acquire(40 * MiB);
  const order = [];
  const first = pool.acquire(30 * MiB).then((lease) => { order.push('first'); return lease; });
  const second = pool.acquire(5 * MiB).then((lease) => { order.push('second'); return lease; });
  await settled();
  held.release();
  const leases = await within(Promise.all([first, second]), 1000, 'both waiters, which fit together, are served');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(pool.stats.current, 35 * MiB);
  for (const lease of leases) lease.release();
  console.log('  ✓ live waiters take their turns in order, at once');
}

// ── a running ask comes first: a woken ordinary turn yields to one ───────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const kept = await pool.acquire(10 * MiB);
  const held = await pool.acquire(30 * MiB);
  const ordinary = pool.queue(30 * MiB);
  held.release();
  await settled();
  // Woken with room for it; then a running ask that does not fit beside what is kept waits before it.
  const running = pool.acquireAhead(35 * MiB);
  await settled();
  assert.equal(ordinary.take(), null, 'the ordinary turn yields to the running ask waiting before it');
  kept.release();
  const lease = await within(running, 1000, 'the running ask is served');
  assert.equal(pool.stats.current, 35 * MiB);
  lease.release();
  const taken = await within(ordinary.woken().then(() => ordinary.take()), 1000, 'the ordinary waiter keeps its place and is served next');
  assert.equal(taken.bytes, 30 * MiB);
  ordinary.leave();
  taken.release();
  assert.equal(pool.stats.current, 0);
  console.log('  ✓ a woken ordinary turn yields to a running ask');
}

// ── both woken at once, the running ask's turn still comes first ─────────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const kept = await pool.acquire(10 * MiB);
  const held = await pool.acquire(30 * MiB);
  const ordinary = pool.queue(30 * MiB);
  held.release();
  const running = pool.acquireAhead(35 * MiB);
  // The running ask's turn comes as `kept` goes, before either continuation runs.
  kept.release();
  assert.equal(ordinary.take(), null, 'the ordinary turn, woken first, does not take what the running turn is woken to');
  const lease = await within(running, 1000, 'the running ask takes its turn');
  assert.equal(lease.bytes, 35 * MiB);
  lease.release();
  const taken = await within(ordinary.woken().then(() => ordinary.take()), 1000, 'then the ordinary waiter');
  ordinary.leave();
  taken.release();
  assert.equal(pool.stats.current, 0);
  console.log('  ✓ of two woken turns, the running ask takes first');
}

// ── taken past its turn, between two looks at the line ───────────────────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const held = await pool.acquire(40 * MiB);
  const late = pool.queue(10 * MiB);
  // Woken half a turn after it queued, between its own looks at the line.
  await new Promise((resolve) => setTimeout(resolve, CREDIT_TURN_MS / 2));
  held.release();
  await late.woken();
  await new Promise((resolve) => setTimeout(resolve, CREDIT_TURN_MS + 100));
  assert.equal(late.take(), null, 'a turn taken past its time has lapsed');
  assert.equal(pool.stats.current, 0, 'and holds nothing');
  assert.equal(pool.stats.queued, 1, 'it waits again');
  const lease = await within(late.woken().then(() => late.take()), 1000, 'and is woken again');
  late.leave();
  lease.release();
  console.log('  ✓ a turn taken past its time lapses');
}

// ── a turn left is gone: a late take does not bring it back ──────────────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const held = await pool.acquire(40 * MiB);
  const left = pool.queue(10 * MiB);
  held.release();
  left.leave();
  assert.equal(left.take(), null);
  assert.equal(pool.stats.queued, 0, 'nothing is queued');
  const lease = await within(pool.acquire(40 * MiB), 100, 'the next ask is served at once');
  lease.release();
  console.log('  ✓ a turn left stays gone');
}

// ── a turn asked with a signal already aborted is refused, holding nothing ─
{
  const pool = new WeightedCreditPool(40 * MiB);
  const abort = new AbortController();
  abort.abort(new Error('gone before it asked'));
  const turn = pool.queue(10 * MiB, abort.signal);
  await assert.rejects(turn.woken(), { name: 'AbortError' });
  assert.equal(turn.take(), null);
  assert.equal(pool.stats.current, 0);
  assert.equal(pool.stats.queued, 0);
  turn.leave();
  console.log('  ✓ a turn asked already aborted is refused');
}

// ── a turn never even looked at lapses too ───────────────────────────────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const held = await pool.acquire(40 * MiB);
  pool.queue(10 * MiB);
  const next = pool.acquire(40 * MiB);
  held.release();
  const lease = await within(next, 4 * CREDIT_TURN_MS, 'the next waiter is served once that turn lapses');
  lease.release();
  console.log('  ✓ a turn never looked at lapses');
}

// ── an abort during a woken turn gives the turn to the next waiter ───────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const held = await pool.acquire(40 * MiB);
  const abort = new AbortController();
  const aborted = pool.acquire(10 * MiB, abort.signal);
  const next = pool.acquire(40 * MiB);
  // Woken, then aborted before its continuation runs.
  held.release();
  abort.abort(new Error('the waiter left'));
  await assert.rejects(aborted, { name: 'AbortError' });
  const lease = await within(next, CREDIT_TURN_MS / 2, 'the next waiter is served at once');
  lease.release();
  assert.equal(pool.stats.queued, 0);
  console.log('  ✓ an aborted turn passes to the next waiter at once');
}

// ── a small request's reserve lane works the same way ───────────────────
{
  const pool = new WeightedCreditPool(40 * MiB, { smallRequestBytes: 64 * 1024, reserve: MiB });
  const heavy = await pool.acquire(40 * MiB);
  const reads = await Promise.all(Array.from({ length: 16 }, () => pool.acquire(64 * 1024)));
  assert.equal(pool.stats.current, 41 * MiB, 'the reserve is full beside the full shared lane');
  const gone = pool.queue(64 * 1024);
  gone.woken();
  const read = pool.acquire(64 * 1024);
  reads.pop().release();
  await settled();
  const lease = await within(read, 4 * CREDIT_TURN_MS, 'the read after a reserve turn never taken is served');
  lease.release();
  gone.leave();
  for (const done of reads) done.release();
  heavy.release();
  assert.equal(pool.stats.current, 0);
  console.log('  ✓ the reserve lane lapses a turn never taken too');
}

console.log('credit-pool-turns: ok');
