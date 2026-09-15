#!/usr/bin/env bun
// esbuild-pool-resident-credit — the session's esbuild pool takes RESIDENT
// credit sized to the image it keeps, not the whole shared budget.
//
// The full-budget claim it used to make is grantable exactly once: the lease
// it shrinks to becomes a permanent floor, so the next claim of the same size
// asks for more than could ever be free and parks in the FIFO — no error, no
// CPU, and because the queue refuses everyone behind a waiter, the whole
// isolate stops. Measured on a deployed worker: capacity 41,943,040,
// resident 11,907,565, queued 1 for 222 s with the isolate healthy.
//
// Pinned on the SOURCE because constructing a real pool needs a workerd
// isolate and an ASSETS binding, and what matters is which claim it makes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRE_BUNDLE_SLICE_CAP_BYTES,
  SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES,
} from '../../packages/platform/src/limits.ts';
import { SupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';

const source = readFileSync('packages/worker/src/facets/esbuild-bundle-pool.ts', 'utf8');

assert.match(
  source,
  /acquireResidentSupervisorAllocation\(maxRetainedWasmBytes\)/,
  'the pool claims RESIDENT credit — its image is held until dispose, not for one operation',
);
assert.doesNotMatch(
  source,
  /acquireSupervisorAllocation\(\s*SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES/,
  'and never the whole shared budget, which is grantable only while nothing is resident',
);
assert.match(
  source,
  /const maxRetainedWasmBytes\s*=\s*\n?\s*SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES - PRE_BUNDLE_SLICE_CAP_BYTES;/,
  'sized to the same bound the payload is checked against, leaving the slice cap free',
);
assert.match(source, /setupAllocation\.shrinkTo\(wasmBytes\.byteLength\)/, 'and shrunk to what it actually keeps');
console.log('  the pool claims resident credit bounded by the retained-image bound');

// The shape that bound produces. With the claim bounded, two pools fit
// side by side and a slice claim still fits beside a live one — the
// arrangement the bound exists to guarantee. The OLD shape, a full-budget
// claim, is refused the moment anything is resident.
{
  const budget = new SupervisorAllocationBudget(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
  const bound = SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES - PRE_BUNDLE_SLICE_CAP_BYTES;
  const pool = await budget.acquireResidentBytes(bound);

  // A full-budget claim beside it can never be granted, and says so.
  await assert.rejects(
    budget.acquire(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES),
    (error) => {
      assert.match(error.message, /can never be granted/);
      assert.match(error.message, new RegExp(String(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES)));
      assert.match(error.message, new RegExp(String(bound)));
      return true;
    },
  );
  assert.equal(budget.stats.queued, 0, 'the refused full-budget claim is not parked');

  // Shrunk to a real esbuild image, a slice-cap claim fits beside it — which
  // is what the pool exists to do.
  pool.shrinkTo(11_907_565);
  const slice = await budget.acquire(PRE_BUNDLE_SLICE_CAP_BYTES);
  assert.equal(budget.stats.queued, 0, 'a slice claim beside a live pool is granted, not queued');
  slice.release();
  pool.release();
  console.log('  a full-budget claim beside a resident pool is refused with the numbers');
}

console.log('esbuild-pool-resident-credit OK');
