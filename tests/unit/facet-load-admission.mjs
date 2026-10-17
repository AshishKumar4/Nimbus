#!/usr/bin/env bun
// A facet's load is admitted on the isolate's transient budget, which every
// session the isolate hosts shares: loads that would overlap take turns.
//
// What has to hold:
//   - a load larger than the whole budget takes all of it, alone, and every
//     owner asking after it waits, however small;
//   - the waits are FIFO: no owner queued after a load is granted before it,
//     even one that would fit beside what is held;
//   - a wait is bounded: one not granted in time is refused by name
//     (SupervisorLoadWaitError, EAGAIN), never left waiting, and leaves
//     nothing queued; an abort ends a wait as an abort;
//   - through IsolatePool: an image is read inside the loader's callback, and
//     a second load's images are not read until the first's callback has
//     returned when the two would not fit together; a refusal arrives as
//     itself, unretried; an abort ends a map's wait.

import assert from 'node:assert/strict';
import {
  SupervisorAllocationBudget,
  SupervisorLoadWaitError,
  acquireSupervisorAllocation,
  readSupervisorAllocationBudget,
} from '../../packages/platform/src/heavy-alloc-coord.ts';
import { SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES as CAPACITY } from '../../packages/platform/src/limits.ts';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const LONG = 60_000;

// ── a load larger than the budget holds all of it, alone ────────────────────
{
  const budget = new SupervisorAllocationBudget(100);
  const held = await budget.acquire(60);
  let big = null;
  const waiting = budget.acquireLoad('big', 250, { waitMs: LONG }).then((lease) => { big = lease; return lease; });
  await settled();
  assert.equal(big, null, 'a load larger than the budget waits until nothing else holds it');
  held.release();
  await waiting;
  assert.equal(big.bytes, 100, 'and then holds the whole budget');
  let small = null;
  const after = budget.acquire(1).then((lease) => { small = lease; return lease; });
  await settled();
  assert.equal(small, null, 'while it holds the budget, nothing else is granted');
  big.release();
  (await after).release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ a load larger than the budget takes all of it, alone');
}

// ── FIFO: nothing queued after a load overtakes it ──────────────────────────
{
  const budget = new SupervisorAllocationBudget(100);
  const held = await budget.acquire(60);
  let load = null;
  let small = null;
  const loading = budget.acquireLoad('load', 80, { waitMs: LONG }).then((lease) => { load = lease; return lease; });
  const smalling = budget.acquire(30).then((lease) => { small = lease; return lease; });
  await settled();
  assert.equal(small, null, 'an owner that would fit beside what is held still waits behind the queued load');
  held.release();
  await loading;
  await settled();
  assert.equal(small, null, 'the load is granted first, and the owner behind it waits for room beside it');
  load.release();
  await smalling;
  small.release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ the waits are FIFO');
}

// ── bounded: refused by name, nothing left queued; an abort is an abort ─────
{
  const budget = new SupervisorAllocationBudget(100);
  const held = await budget.acquire(100);
  await assert.rejects(
    budget.acquireLoad("facet 'clang-runner-clang' images", 50, { waitMs: 20 }),
    (error) => error instanceof SupervisorLoadWaitError && error.code === 'EAGAIN' && /clang-runner-clang/.test(error.message) && /100 of 100 bytes held/.test(error.message),
    'a load not admitted in time is refused, naming what waited and what was held',
  );
  assert.equal(budget.stats.queued, 0, 'a refused wait leaves nothing queued');
  const controller = new AbortController();
  const aborted = budget.acquireLoad('load', 50, { waitMs: LONG, signal: controller.signal });
  controller.abort(new Error('killed'));
  await assert.rejects(aborted, (error) => !(error instanceof SupervisorLoadWaitError) && /killed/.test(error.message), 'an abort ends a wait as the abort');
  held.release();
  assert.equal(budget.stats.queued, 0);
  console.log('  ✓ a wait is bounded, and an abort ends it');
}

// ── through IsolatePool: images read in the callback, loads take turns ──────
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'load-admission-do' }, waitUntil() {} };
  const env = {
    LOADER: {
      get(_id, load) {
        return { getEntrypoint: () => ({ async fetch() { await load(); return new Response('ok'); } }) };
      },
    },
  };
  const events = [];
  /** An image of `size` whose read waits for `gate`, logging when it starts. */
  const gated = (name, size, gate) => ({
    path: `/${name}`, identity: name, size, peak: size,
    async read() { events.push(`read ${name}`); await gate; return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); },
  });
  let openFirst;
  const firstGate = new Promise((resolve) => { openFirst = resolve; });
  const pool = (name, image) => new IsolatePool(env, ctx, { tag: name, network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } });
  const run = (p) => p.submitRequest(facetTaskSource("async () => new Response('ok')"), new Request('https://facet.internal/run'));
  // Two clang-sized images: either fits the budget alone, not both at once.
  const first = run(pool('first', gated('first', 31 * MiB, firstGate)));
  await settled();
  assert.deepEqual(events, ['read first'], 'the first load reads its image inside the callback');
  assert.equal(readSupervisorAllocationBudget().current, 31 * MiB, 'admitted for its size');
  const second = run(pool('second', gated('second', 31 * MiB, Promise.resolve())));
  await settled();
  assert.deepEqual(events, ['read first'], 'a second load that would not fit beside it waits, unread');
  openFirst();
  assert.equal(await (await first).text(), 'ok');
  assert.equal(await (await second).text(), 'ok');
  assert.deepEqual(events, ['read first', 'read second'], 'and reads once the first callback has returned');
  assert.equal(readSupervisorAllocationBudget().current, 0, 'nothing stays admitted after a load');
  assert.ok(31 * MiB < CAPACITY && 62 * MiB > CAPACITY);
  console.log('  ✓ IsolatePool loads take turns on the isolate budget');
}

// ── through IsolatePool: a refusal arrives as itself; an abort ends the wait ─
{
  const ctx = { id: { toString: () => 'load-refusal-do' }, waitUntil() {} };
  let calls = 0;
  const env = {
    LOADER: {
      get(_id, load) {
        return { getEntrypoint: () => ({ async fetch() { calls++; await load(); return new Response('ok'); }, async execute() { calls++; await load(); return 'ok'; } }) };
      },
    },
  };
  const held = { usage: { current: 0, capacity: CAPACITY, peak: 0, queued: 0 } };
  const refusing = {
    path: '/refused.wasm', identity: 'refused', size: 8, peak: 8,
    async read() { throw new SupervisorLoadWaitError("facet 'refused' images", 8, 60_000, held.usage); },
  };
  const pool = new IsolatePool(env, ctx, { tag: 'refused', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, retries: 2, wasmModules: { 'primary.wasm': refusing } });
  await assert.rejects(
    pool.submit(facetTaskSource('() => 1'), null),
    (error) => error instanceof SupervisorLoadWaitError && error.code === 'EAGAIN',
    'a load the budget refused is said as the refusal, EAGAIN, not as an execution failure',
  );
  assert.equal(calls, 1, 'and it is not retried');

  // An abort ends a map's wait for the budget, rather than its bound.
  const MiB = 1024 * 1024;
  // Held whole, so the map's load must wait.
  const lease = await acquireSupervisorAllocation(CAPACITY);
  const big = { path: '/big.wasm', identity: 'big', size: 31 * MiB, peak: 31 * MiB, async read() { return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); } };
  const mapping = new IsolatePool(env, ctx, { tag: 'mapped', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': big } });
  const controller = new AbortController();
  const started = Date.now();
  const waiting = mapping.map(facetTaskSource('(value) => value'), [1], { signal: controller.signal });
  await settled();
  controller.abort(new Error('killed'));
  await assert.rejects(waiting, /killed/, 'an abort ends the wait');
  assert.ok(Date.now() - started < 10_000, 'at once, not at the bound');
  lease.release();
  console.log('  ✓ refusals and aborts through IsolatePool');
}

console.log('facet-load-admission: ok');
