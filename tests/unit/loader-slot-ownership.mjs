#!/usr/bin/env bun
// loader-slot-ownership — a warm IsolatePool slot executes ONE dispatch
// at a time.
//
// Two dispatches on the same slot used to interleave on the isolate's
// QueueState: submit() pinned everything to slot 0, and map() trusted
// the caller's round-robin — which could not stop submit() or a second
// map() landing on a slot a task still occupied. The pool now keeps a
// per-slot tail and queues each dispatch behind it. This file pins the
// seam via the public IsolatePool + a LOADER seam:

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
{
  const record = { inFlight: 0, maxInFlight: 0 };
  const ctx = { id: { toString: () => 'slot-owner-b' } };
  const pool = new IsolatePool({ LOADER: makeLoader(record) }, ctx, { omitSupervisor: true, concurrency: 2 });
  const mapping = pool.map((value) => value, ['a', 'b', 'c', 'd', 'e', 'f']);
  await pool.submit((value) => value, 'during-map');
  await mapping;
  assert.ok(record.maxInFlight <= 2, `no more than the pool's slots ever ran at once (max=${record.maxInFlight})`);
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

console.log('loader-slot-ownership: all assertions passed');
