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
//     returned when the two would not fit together; an abort ends a map's
//     wait; credit is taken before the worker (the lock order), and a warm
//     worker waits for none;
//   - the credit a load takes is its own and is given back however its wait
//     for a worker ends: a launch's dispatch killed as it regains its worker,
//     a refused call's readmission given up, an attempt a timeout left running;
//   - a launch's load refused its credit is refused at once, though the worker
//     it gave back for the wait is taken: it waits for no worker to say so.

import assert from 'node:assert/strict';
import { jest } from 'bun:test';
import {
  SupervisorAllocationBudget,
  SupervisorLoadWaitError,
  acquireSupervisorAllocation,
  readSupervisorAllocationBudget,
} from '../../packages/platform/src/heavy-alloc-coord.ts';
import { SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES as CAPACITY, SUPERVISOR_LOAD_WAIT_MS } from '../../packages/platform/src/limits.ts';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { DO_DYNAMIC_WORKER_LIMIT, beginLoaderFetch, withLaunchAdmission } from '../../packages/fabric/src/budgets.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LONG = 60_000;
const CAP_MESSAGE = 'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.';
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

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

// ── through IsolatePool: an abort ends a map's wait for credit ────────────
{
  const ctx = { id: { toString: () => 'load-abort-do' }, waitUntil() {} };
  const env = {
    LOADER: {
      get(_id, load) {
        return { getEntrypoint: () => ({ async execute() { await load(); return 'ok'; } }) };
      },
    },
  };
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
  console.log('  ✓ an abort ends a load\'s wait for credit');
}

// ── through IsolatePool: credit, then a worker ───────────────────────────────
// A load not made yet takes its images' credit before the loader is asked
// for its worker; one made before is answered warm without waiting for any;
// one the loader dropped finds its credit not free, ends its hold, and waits
// for credit before it asks again.
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'credit-order-do' }, waitUntil() {} };
  const cache = new Map();
  let gets = 0;
  let builds = 0;
  const env = {
    LOADER: {
      get(id, load) {
        gets++;
        return { getEntrypoint: () => ({ async fetch() { if (!cache.has(id)) { cache.set(id, await load()); builds++; } return new Response('ok'); } }) };
      },
    },
  };
  const image = { path: '/order.wasm', identity: 'order', size: 8 * MiB, peak: 8 * MiB, async read() { return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); } };
  const pool = new IsolatePool(env, ctx, { tag: 'order', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } });
  const call = async () => (await pool.submitRequest(facetTaskSource("async () => new Response('ok')"), new Request('https://facet.internal/run'))).text();
  const whole = await acquireSupervisorAllocation(CAPACITY);
  const first = call();
  await settled();
  assert.equal(gets, 0, 'a load not made yet waits for its credit before it holds a worker');
  whole.release();
  assert.equal(await first, 'ok');
  assert.equal(builds, 1);
  const full = await acquireSupervisorAllocation(CAPACITY);
  assert.equal(await call(), 'ok', 'a load made before is answered warm, waiting for no credit');
  assert.equal(builds, 1, 'and reads nothing');
  cache.clear();
  const dropped = call();
  await settled();
  assert.equal(gets, 3, 'dropped by the loader, it asked for its worker once');
  assert.equal(builds, 1, 'found its credit not free, and built nothing');
  full.release();
  assert.equal(await dropped, 'ok', 'then waited for credit and asked again');
  assert.equal(builds, 2);
  assert.equal(gets, 4);
  assert.equal(readSupervisorAllocationBudget().current, 0, 'nothing stays admitted');
  console.log('  ✓ credit, then a worker');
}

// ── through IsolatePool: a launch's dispatch killed as it regains its worker ─
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'resume-kill-do' }, waitUntil() {} };
  const env = { LOADER: { get(_id, load) { return { getEntrypoint: () => ({ async execute() { await load(); return 'ok'; } }) }; } } };
  const image = { path: '/resume.wasm', identity: 'resume', size: 8 * MiB, peak: 8 * MiB, async read() { return WASM; } };
  const pool = new IsolatePool(env, ctx, { tag: 'resume', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } });
  const whole = await acquireSupervisorAllocation(CAPACITY);
  const others = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - 1 }, (_, i) => beginLoaderFetch(ctx, `other-${i}`));
  const kill = new AbortController();
  let last;
  await withLaunchAdmission(ctx, { pid: 21, ancestors: [] }, undefined, async () => {
    const dispatch = pool.map(facetTaskSource('(value) => value'), [1], { signal: kill.signal });
    await settled();
    // Its worker given back while it waits for credit, another takes it.
    last = beginLoaderFetch(ctx, 'last');
    whole.release();
    await settled();
    assert.equal(readSupervisorAllocationBudget().current, 8 * MiB, 'its credit is granted; it waits to regain its worker');
    kill.abort(new Error('killed'));
    await assert.rejects(dispatch, /killed/);
  });
  assert.equal(readSupervisorAllocationBudget().current, 0, 'the credit it was granted is given back');
  last();
  for (const end of others) end();
  console.log('  ✓ a launch\'s dispatch killed as it regains its worker gives back its credit');
}

// ── through IsolatePool: a refused call's readmission given up ───────────────
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'readmit-kill-do' }, waitUntil() {} };
  let refused = 0;
  const env = { LOADER: { get() { return { getEntrypoint: () => ({ async execute() { refused++; throw new Error(CAP_MESSAGE); } }) }; } } };
  const image = { path: '/readmit.wasm', identity: 'readmit', size: 8 * MiB, peak: 8 * MiB, async read() { return WASM; } };
  const pool = new IsolatePool(env, ctx, { tag: 'readmit', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } });
  const others = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(ctx, `other-${i}`));
  const kill = new AbortController();
  const dispatch = pool.map(facetTaskSource('(value) => value'), [1], { signal: kill.signal });
  for (let i = 0; i < 100 && !(refused > 0 && readSupervisorAllocationBudget().current === 8 * MiB); i++) await sleep(10);
  assert.equal(readSupervisorAllocationBudget().current, 8 * MiB, 'refused, it waits for readmission holding its credit');
  kill.abort(new Error('killed'));
  await assert.rejects(dispatch);
  assert.equal(readSupervisorAllocationBudget().current, 0, 'and gives it back as it gives up');
  for (const end of others) end();
  console.log('  ✓ a refused call\'s readmission given up gives back its credit');
}

// ── through IsolatePool: an attempt a timeout left running keeps its own credit ─
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'overlap-do' }, waitUntil() {} };
  const env = { LOADER: { get(_id, load) { return { getEntrypoint: () => ({ async fetch() { await load(); return new Response('ok'); } }) }; } } };
  const image = { path: '/overlap.wasm', identity: 'overlap', size: 8 * MiB, peak: 8 * MiB, async read() { return WASM; } };
  const pool = new IsolatePool(env, ctx, { tag: 'overlap', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 100, retries: 1, wasmModules: { 'primary.wasm': image } });
  const whole = await acquireSupervisorAllocation(CAPACITY);
  const call = pool.submitRequest(facetTaskSource("async () => new Response('ok')"), new Request('https://facet.internal/run'));
  // The first attempt times out waiting for credit; the retry waits beside it.
  for (let i = 0; i < 100 && readSupervisorAllocationBudget().queued < 2; i++) await sleep(10);
  assert.equal(readSupervisorAllocationBudget().queued, 2, 'both attempts wait for credit');
  whole.release();
  assert.equal(await (await call).text(), 'ok');
  for (let i = 0; i < 100 && readSupervisorAllocationBudget().current > 0; i++) await sleep(10);
  assert.equal(readSupervisorAllocationBudget().current, 0, 'each attempt gave back the credit it was granted');
  console.log('  ✓ an attempt a timeout left running keeps its own credit');
}

// ── through IsolatePool: a launch's load refused its credit is refused at once ─
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'refused-credit-do' }, waitUntil() {} };
  const env = { LOADER: { get(_id, load) { return { getEntrypoint: () => ({ async execute() { await load(); return 'ok'; } }) }; } } };
  const image = { path: '/refused.wasm', identity: 'refused', size: 8 * MiB, peak: 8 * MiB, async read() { return WASM; } };
  const pool = new IsolatePool(env, ctx, { tag: 'refused', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } });
  const whole = await acquireSupervisorAllocation(CAPACITY);
  const others = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - 1 }, (_, i) => beginLoaderFetch(ctx, `other-${i}`));
  // A turn of the event loop the fake timers do not hold back.
  const turn = () => new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); resolve(); };
    port2.postMessage(null);
  });
  let last;
  jest.useFakeTimers();
  try {
    await withLaunchAdmission(ctx, { pid: 41, ancestors: [] }, undefined, async () => {
      let outcome = null;
      pool.map(facetTaskSource('(value) => value'), [1]).then(() => { outcome = 'ok'; }, (error) => { outcome = error; });
      for (let i = 0; i < 500 && readSupervisorAllocationBudget().queued === 0; i++) await turn();
      assert.equal(readSupervisorAllocationBudget().queued, 1, 'its load waits for credit');
      // The worker it gave back for the wait, another facet takes.
      last = beginLoaderFetch(ctx, 'last');
      jest.advanceTimersByTime(SUPERVISOR_LOAD_WAIT_MS);
      for (let i = 0; i < 500 && outcome === null; i++) await turn();
      assert.ok(outcome instanceof SupervisorLoadWaitError, `refused by name, at once: ${outcome}`);
    });
  } finally {
    jest.useRealTimers();
  }
  whole.release();
  last();
  for (const end of others) end();
  assert.equal(readSupervisorAllocationBudget().current, 0);
  console.log('  ✓ a launch\'s load refused its credit is refused at once');
}

console.log('facet-load-admission: ok');
