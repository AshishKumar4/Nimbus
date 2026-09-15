#!/usr/bin/env bun
// loader-slot-ownership — a warm IsolatePool slot executes ONE dispatch
// at a time, the tail covers the slot's in-flight work rather than the
// caller's settle, and dispose() rejects what never started.
//
// Two dispatches on the same slot used to interleave on the isolate's
// QueueState: submit() pinned everything to slot 0, and map() trusted
// the caller's round-robin — which could not stop submit() or a second
// map() landing on a slot a task still occupied. The pool keeps a
// per-slot tail and queues each dispatch behind it. This file pins the
// seam via the public IsolatePool + a LOADER seam:
//
//   - overlapping submits run one at a time;
//   - a submit() during map() waits for slot 0 (per-slot in-flight);
//   - different slots still overlap — the tail is per-slot;
//   - a timeout releases the caller but NOT the tail: the queued
//     dispatch waits until the timed-out execute actually settles;
//   - dispose() rejects a queued, never-started dispatch while an
//     active one settles normally.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';

// A LOADER stub whose execute() reports how many dispatches are live on
// its isolate at once — the evidence slot-ownership has to keep at 1.
function makeLoader(record) {
  return {
    get() {
      return {
        getEntrypoint: () => ({
          async execute(value) {
            record.inFlight++;
            record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
            await new Promise((resolve) => setTimeout(resolve, 10));
            record.inFlight--;
            return value;
          },
        }),
      };
    },
  };
}

const deferred = () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release };
};

// ── submit() + submit() on slot 0 never overlap ──────────────────────────
{
  const record = { inFlight: 0, maxInFlight: 0 };
  const ctx = { id: { toString: () => 'slot-owner-a' } };
  const pool = new IsolatePool({ LOADER: makeLoader(record) }, ctx, { omitSupervisor: true });
  await Promise.all([
    pool.submit((value) => value, 'first'),
    pool.submit((value) => value, 'second'),
  ]);
  assert.equal(record.maxInFlight, 1, 'two submits on slot 0 ran serially, never concurrently');
  pool.dispose();
  console.log('  overlapping submits on the same slot execute one at a time');
}

// ── submit() while map() holds slot 0 waits ──────────────────────────────
//
// Per-slot in-flight, not a global max: the loader id carries the slot
// index (`…:slot-N:…`), so this proves slot 0 specifically never ran
// two executions at once — a second slot running in parallel is legal.
{
  const perSlot = new Map();
  const maxPerSlot = new Map();
  const loader = {
    get(id) {
      const slot = Number((id.match(/slot-(\d+)/) || [])[1]);
      return {
        getEntrypoint: () => ({
          async execute(value) {
            const cur = (perSlot.get(slot) ?? 0) + 1;
            perSlot.set(slot, cur);
            maxPerSlot.set(slot, Math.max(maxPerSlot.get(slot) ?? 0, cur));
            await new Promise((resolve) => setTimeout(resolve, 10));
            perSlot.set(slot, cur - 1);
            return value;
          },
        }),
      };
    },
  };
  const ctx = { id: { toString: () => 'slot-owner-b' } };
  const pool = new IsolatePool({ LOADER: loader }, ctx, { omitSupervisor: true, concurrency: 2 });
  const mapping = pool.map((value) => value, ['a', 'b', 'c', 'd', 'e', 'f']);
  await pool.submit((value) => value, 'during-map');
  await mapping;
  assert.ok((maxPerSlot.get(0) ?? 0) <= 1, 'slot 0 never had two executions in flight');
  assert.equal(Math.max(...maxPerSlot.values()), 1, 'no slot ran two executions at once');
  pool.dispose();
  console.log('  a submit() during map() waits for slot 0 instead of double-dispatching it');
}

// ── different slots still run in parallel ────────────────────────────────
//
// The tail serializes a SLOT, not the pool: at concurrency 2 the two
// slots must still overlap, or map() quietly degraded to sequential.
{
  const record = { inFlight: 0, maxInFlight: 0 };
  const ctx = { id: { toString: () => 'slot-owner-c' } };
  const pool = new IsolatePool({ LOADER: makeLoader(record) }, ctx, { omitSupervisor: true, concurrency: 2 });
  await pool.map((value) => value, ['a', 'b', 'c', 'd']);
  assert.equal(record.maxInFlight, 2, 'two slots still ran concurrently — ownership is per-slot, not global');
  pool.dispose();
  console.log('  different slots still overlap — the tail is per-slot, not global');
}

// ── a timeout releases the caller, not the tail ─────────────────────────
//
// The slot tail used to release when the caller's Promise.race settled —
// on a timeout that left runOnce's execute live on the Worker while the
// next queued dispatch started on top of it. Now the tail waits for the
// tracked execution itself to settle.
{
  const barrier = deferred();
  const record = { started: 0 };
  const loader = {
    get() {
      return {
        getEntrypoint: () => ({
          async execute(value) {
            record.started++;
            await barrier.gate;
            return value;
          },
        }),
      };
    },
  };
  const ctx = { id: { toString: () => 'slot-owner-d' } };
  const pool = new IsolatePool({ LOADER: loader }, ctx, { omitSupervisor: true });
  const first = pool.submit((value) => value, 'first', { timeoutMs: 20 });
  const second = pool.submit((value) => value, 'second', { timeoutMs: 5_000 });
  const firstOutcome = await first.then(() => 'resolved', (e) => e.constructor.name);
  assert.equal(firstOutcome, 'TimeoutError', `the first submit rejects on timeout (got ${firstOutcome})`);
  assert.equal(record.started, 1, 'the timed-out execute is still live — the second has NOT started');
  barrier.release();
  assert.equal(await second, 'second', 'the queued dispatch runs after the straggler settles');
  assert.equal(record.started, 2, 'the second execute started only once the tail released');
  pool.dispose();
  console.log('  a timed-out dispatch holds the slot tail until its execute settles');
}

// ── dispose() rejects a queued dispatch, never interrupts the active ────
{
  const barrier = deferred();
  const record = { started: 0, finished: 0 };
  const loader = {
    get() {
      return {
        getEntrypoint: () => ({
          async execute(value) {
            record.started++;
            await barrier.gate;
            record.finished++;
            return value;
          },
        }),
      };
    },
  };
  const ctx = { id: { toString: () => 'slot-owner-e' } };
  const pool = new IsolatePool({ LOADER: loader }, ctx, { omitSupervisor: true });
  const first = pool.submit((value) => value, 'first');
  const second = pool.submit((value) => value, 'second');
  // Wait until the first dispatch is actually in-flight on the slot.
  while (record.started === 0) await new Promise((r) => setTimeout(r, 1));
  pool.dispose();
  barrier.release();
  assert.equal(await first, 'first', 'the active dispatch settles normally under dispose');
  const secondOutcome = await second.then(() => 'resolved', (e) => e.constructor.name);
  assert.equal(secondOutcome, 'BindingError', `a queued dispatch rejects on dispose (got ${secondOutcome})`);
  assert.equal(record.started, 1, 'the queued dispatch never executed');
  assert.equal(record.finished, 1, 'the active dispatch completed');
  console.log('  dispose() rejects queued dispatches; the active one finishes');
}

console.log('loader-slot-ownership: all assertions passed');
