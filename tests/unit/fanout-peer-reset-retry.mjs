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
import { NimbusFanoutPool } from '../../packages/worker/src/loaders/fanout-pool.ts';
import { isDoOverloaded, isTransientDoReset } from '../../packages/worker/src/observability/oom-classify.ts';

// ── Classifier: transient resets are retryable, resource resets are not ──
assert.equal(isTransientDoReset(new Error('Durable Object reset because its code was updated.')), true);
assert.equal(isTransientDoReset(new Error(
  'Internal error while starting up Durable Object storage caused object to be reset; reference = ga1j754dr4bl2c1ujh1jb39j')), true);
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
  const pool = new NimbusFanoutPool(env, ctx, { tag: 'reset-retry-test', omitSupervisor: true });
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
  const pool = new NimbusFanoutPool(env, ctx, { tag: 'reset-exhaust-test', omitSupervisor: true });
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
  const pool = new NimbusFanoutPool(env, ctx, { tag: 'nonretry-test', omitSupervisor: true });
  await assert.rejects(pool.submitMany(TASKS, (x) => x), /genuine task failure/);
  // With 8 tasks the first phase dispatches up to 4 shards concurrently;
  // each throws exactly once (no retry). No shard is retried.
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
  const pool = new NimbusFanoutPool(env, ctx, { tag: 'overload-retry-test', omitSupervisor: true });
  const results = await pool.submitMany(TASKS, (x) => x);
  assert.deepEqual(results, TASKS.map((t) => t.args), 'all tasks resolved in order after the shed');
  for (const [name, n] of calls) assert.equal(n, 2, `shard ${name} retried exactly once`);
  console.log(`  case4: recovered from overload across ${calls.size} shards`);
}

console.log('fanout-peer-reset-retry: ok');
