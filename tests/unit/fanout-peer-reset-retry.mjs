#!/usr/bin/env bun
// fanout-peer-reset-retry — the peer-DO fanout must survive a TRANSIENT
// Durable Object reset (platform code roll-over / storage cold-start
// hiccup) by re-dispatching the idempotent shard, instead of failing the
// whole submitMany. This is the exact condition that failed pi's install
// ~2/5 as `resolver-fanout failed at layer 2: Durable Object reset because
// its code was updated.` / `Internal error while starting up Durable
// Object storage caused object to be reset`.

//
// The same budget covers a peer that workerd SHED as overloaded — the
// object is alive and the shard never ran, so re-dispatching it after a
// longer backoff is what turns `[batch-fanout] aborted: Durable Object is
// overloaded` from a whole-install abort into a completed install.

import assert from 'node:assert/strict';
import { FanoutPool } from '../../packages/fabric/src/fanout-pool.ts';
import { describeError, isDoOverloaded, isTransientDoReset } from '../../packages/core/src/observability/oom-classify.ts';

// ── Classifier: transient resets are retryable, resource resets are not ──
assert.equal(isTransientDoReset(new Error('Durable Object reset because its code was updated.')), true);
assert.equal(isTransientDoReset(new Error(
  'Internal error while starting up Durable Object storage caused object to be reset; reference = ga1j754dr4bl2c1ujh1jb39j')), true);
// The live-write wording of the same condition. Measured resetting a session
// DO mid-install on 2026-08-10 (probe agentic-cli/new/pi-official-installer);
// matching only the startup wording is why a shard that hit it still failed
// the whole install.
assert.equal(isTransientDoReset(new Error(
  'Internal error in Durable Object storage caused object to be reset; reference = 1uuko9ualhs30arc7l9u2mvs')), true);
assert.equal(isTransientDoReset('Durable Object storage operation exceeded timeout which caused the object to be reset.'), true);
// Must NOT treat memory/CPU resets as transient — those recur on retry.
assert.equal(isTransientDoReset(new Error("Durable Object's isolate exceeded its memory limit and was reset")), false);
assert.equal(isTransientDoReset(new Error('some unrelated failure')), false);
// Overload is its own class: the object is alive, the call was shed.
assert.equal(isDoOverloaded(new Error('Durable Object is overloaded.')), true);
assert.equal(isTransientDoReset(new Error('Durable Object is overloaded.')), false);
assert.equal(isDoOverloaded(new Error("Durable Object's isolate exceeded its memory limit and was reset")), false);
assert.equal(isDoOverloaded(new Error('some unrelated failure')), false);

function makeEnv(stubFactory) {
  return {
    LOADER: { get() { return {}; } },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      get(id) { return stubFactory(id.name); },
    },
  };
}
const ctx = { id: { toString: () => 'coord-do-id-abcdef' } };
const TASKS = Array.from({ length: 8 }, (_, i) => ({ key: `pkg-${i}`, args: i }));

// ── Case 1: every shard's first RPC hits a transient reset, then recovers.
{
  const calls = new Map(); // siblingName -> attempt count
  const env = makeEnv((name) => ({
    async _rpcFanoutExecute(_fnSource, args) {
      const n = (calls.get(name) ?? 0) + 1;
      calls.set(name, n);
      if (n === 1) throw new Error('Durable Object reset because its code was updated.');
      return { results: args }; // echo — peer would run fn; plumbing is what we test
    },
  }));
  const pool = new FanoutPool(env, ctx, { tag: 'reset-retry-test', omitSupervisor: true });
  const results = await pool.submitMany(TASKS, (x) => x);
  assert.deepEqual(results, TASKS.map((t) => t.args), 'all tasks resolved in order after retry');
  for (const [name, n] of calls) assert.equal(n, 2, `shard ${name} retried exactly once`);
  console.log(`  case1: recovered across ${calls.size} shards, each retried once`);
}

// ── Case 2: persistent transient reset → exhaust retries, then throw.
{
  let attempts = 0;
  const env = makeEnv(() => ({
    async _rpcFanoutExecute() {
      attempts++;
      throw new Error('Internal error while starting up Durable Object storage caused object to be reset; reference = x');
    },
  }));
  const pool = new FanoutPool(env, ctx, { tag: 'reset-exhaust-test', omitSupervisor: true });
  await assert.rejects(
    pool.submitMany(TASKS, (x) => x),
    /starting up Durable Object storage/,
    'exhausted transient retries propagate the real platform message',
  );
  // 1 shard (all keys collide? no) — at least one shard tried 1 + 3 retries = 4 times.
  assert.ok(attempts >= 4, `a shard exhausted the retry budget (attempts=${attempts})`);
  console.log(`  case2: exhausted and threw after ${attempts} attempts`);
}

// ── Case 3: a NON-transient throw is NOT retried — propagates on first hit.
{
  let attempts = 0;
  const env = makeEnv(() => ({
    async _rpcFanoutExecute() {
      attempts++;
      throw new Error('genuine task failure — not a reset');
    },
  }));
  const pool = new FanoutPool(env, ctx, { tag: 'nonretry-test', omitSupervisor: true });
  await assert.rejects(pool.submitMany(TASKS, (x) => x), /genuine task failure/);
  // However the 8 tasks split across dispatch phases, each one that runs
  // throws exactly once and no shard is retried; a phase that aborts the
  // batch leaves later phases undispatched, hence the range rather than 8.
  assert.ok(attempts >= 1 && attempts <= 8, `non-transient not retried (attempts=${attempts})`);
  console.log(`  case3: non-transient propagated without retry (attempts=${attempts})`);
}

// ── Case 4: an overloaded peer is re-dispatched, not surfaced as an abort.
{
  const calls = new Map();
  const env = makeEnv((name) => ({
    async _rpcFanoutExecute(_fnSource, args) {
      const n = (calls.get(name) ?? 0) + 1;
      calls.set(name, n);
      if (n === 1) throw new Error('Durable Object is overloaded.');
      return { results: args };
    },
  }));
  const pool = new FanoutPool(env, ctx, { tag: 'overload-retry-test', omitSupervisor: true });
  const results = await pool.submitMany(TASKS, (x) => x);
  assert.deepEqual(results, TASKS.map((t) => t.args), 'all tasks resolved in order after the shed');
  for (const [name, n] of calls) assert.equal(n, 2, `shard ${name} retried exactly once`);
  console.log(`  case4: recovered from overload across ${calls.size} shards`);
}

// ── Case 5: a rejection the platform declines to describe still names the
// shard that produced it. `internal error` is the whole message workerd hands
// back for a Durable Object call it will not explain, and re-throwing it bare
// is what put `resolver-fanout failed at layer 2: internal error` in front of
// users — a sentence carrying no layer, no sibling, no attempt count.
{
  const env = makeEnv(() => ({
    async _rpcFanoutExecute() { throw new Error('internal error'); },
  }));
  const pool = new FanoutPool(env, ctx, { tag: 'opaque-test', omitSupervisor: true });
  const err = await pool.submitMany(TASKS, (x) => x).then(
    () => { throw new Error('expected submitMany to reject'); },
    (e) => e,
  );
  assert.match(err.message, /peer shard nbf:opaque-test:coord-do-id-:\d+/, 'names the sibling DO');
  assert.match(err.message, /\(\d+ tasks?\) failed after 1 attempt:/, 'names the shard width and the attempt count');
  assert.match(err.message, /internal error/, 'keeps what the platform did say');
  assert.equal(err.cause?.message, 'internal error', 'the original error survives as cause');
  console.log(`  case5: ${err.message}`);
}

// ── describeError: the message is the least of what an error carries. ──
assert.equal(
  describeError(new Error('Internal error in Durable Object storage caused object to be reset; reference = x')),
  'Internal error in Durable Object storage caused object to be reset; reference = x [transient-do-reset]',
);
assert.equal(describeError(new Error('Durable Object is overloaded.')), 'Durable Object is overloaded. [do-overloaded]');
assert.equal(describeError(new TypeError('fs[method] is not a function')), 'TypeError: fs[method] is not a function');
assert.equal(describeError(new Error('internal error')), 'internal error');
assert.equal(
  describeError(Object.assign(new Error('wrapped'), { name: 'ExecutionError', remoteMessage: 'boom in the facet' })),
  'ExecutionError: boom in the facet (remote)',
);

console.log('fanout-peer-reset-retry: ok');
