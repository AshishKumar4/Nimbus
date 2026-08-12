#!/usr/bin/env bun
// heap-estimate-blind-spots — the supervisor heap estimate must not present
// itself as a total when it is a lower bound, and must not caveat what it can
// simply measure.
//
// estimateSupervisorHeap sums only INSTRUMENTED allocation sources. The
// prefetch-bundle path was the large uninstrumented one: the supervisor DO was
// reset three times under bundle construction while the estimate reported a
// 9.4 MiB baseline and 35 KB of LRU — ~15% of ceiling, moments before a memory
// kill. Naming it as a blind spot was the first fix; measuring it is the real
// one, and a measured site belongs in the breakdown, not beside it.
//
// This test pins both halves: every reported blind spot is actionable, and the
// prefetch path is no longer one because it now has components of its own.

import assert from 'node:assert/strict';
import {
  estimateSupervisorHeap,
  HEAP_BLIND_SPOTS,
} from '../../packages/core/src/observability/heap-estimate.ts';
import {
  readDiagCounters,
  prefetchBundleStart,
  prefetchBundleEnd,
  setPrefetchCacheBytes,
} from '../../packages/core/src/observability/diag-counters.ts';
import { SUPERVISOR_HEAP_CEILING_BYTES } from '../../packages/core/src/constants.ts';

const vfsInputs = { cacheHotBytes: 35 * 1024, inFlightWriteBytes: 0 };
const estimate = estimateSupervisorHeap(readDiagCounters(), vfsInputs);

// ── The estimate still declares its own coverage ────────────────────────
assert.ok(Array.isArray(estimate.blindSpots), 'estimate carries a blind-spot list');
assert.equal(estimate.blindSpots, HEAP_BLIND_SPOTS);

// Whatever is listed must be actionable — a blind spot that does not name its
// site is indistinguishable from a shrug.
for (const spot of estimate.blindSpots) {
  assert.ok(spot.source.length > 0, 'a blind spot names its allocation site');
  assert.ok(spot.source.includes(':'), 'blind spots are module-qualified');
  assert.ok(spot.reason.length > 0, 'a blind spot explains what it allocates');
  assert.ok(spot.capBytes === null || spot.capBytes > 0,
    'capBytes is a positive bound or null for unbounded');
}

// ── The prefetch path is measured, not caveated ─────────────────────────
const sources = estimate.blindSpots.map((s) => s.source);
assert.equal(sources.some((s) => s.includes('buildPrefetchBundle')), false,
  'the per-exec bundle build leases its budget, so it is no longer a blind spot');
assert.equal(sources.some((s) => s.includes('prefetchBundleCache')), false,
  'the cross-exec bundle cache is byte-bounded and reports its total');

assert.equal(typeof estimate.breakdown.prefetchBundleBytes, 'number',
  'the build has a breakdown component of its own');
assert.equal(typeof estimate.breakdown.prefetchCacheBytes, 'number',
  'so does the retained cache');

// With nothing unbounded left, a finite worst case can honestly be stated.
assert.equal(estimate.blindSpotCeilingBytes, 0,
  'no unbounded blind spot remains, so the worst case is a number and it is zero');

// ── The reported bytes are the counters, not a guess ────────────────────
{
  const buildBytes = 3 * 1024 * 1024;
  const cacheBytes = 5 * 1024 * 1024;
  prefetchBundleStart(buildBytes);
  setPrefetchCacheBytes(cacheBytes);
  try {
    const live = estimateSupervisorHeap(readDiagCounters(), vfsInputs);
    assert.equal(live.breakdown.prefetchBundleBytes, buildBytes,
      'an in-flight build is visible while it is in flight');
    assert.equal(live.breakdown.prefetchCacheBytes, cacheBytes,
      'the retained cache total is reported live');
    assert.equal(
      live.estimatedBytes - estimate.estimatedBytes,
      buildBytes + cacheBytes,
      'both land in the total — this is the pressure the estimator used to miss',
    );
  } finally {
    prefetchBundleEnd(buildBytes);
    setPrefetchCacheBytes(0);
  }
  const settled = estimateSupervisorHeap(readDiagCounters(), vfsInputs);
  assert.equal(settled.breakdown.prefetchBundleBytes, 0,
    'a finished build releases its reservation');
  assert.equal(settled.estimatedBytes, estimate.estimatedBytes);
}

// A leased build is inside the allocation budget already, so attributing it
// must move bytes out of the unattributed remainder rather than count twice.
{
  const leased = 2 * 1024 * 1024;
  prefetchBundleStart(leased);
  try {
    const live = estimateSupervisorHeap(readDiagCounters(), vfsInputs);
    const b = live.breakdown;
    const sum =
      b.supervisorBaselineBytes + b.vfsLruBytes + b.vfsInFlightBytes +
      b.preBundleSliceBytes + b.streamingBuffersBytes + b.prefetchBundleBytes +
      b.prefetchCacheBytes + b.unattributedReservationBytes;
    assert.equal(live.estimatedBytes, sum, 'estimatedBytes equals the breakdown sum');
    assert.ok(b.unattributedReservationBytes >= 0, 'attribution never goes negative');
  } finally {
    prefetchBundleEnd(leased);
  }
}

// ── The instrumented sum is still coherent ──────────────────────────────
const b = estimate.breakdown;
const sum =
  b.supervisorBaselineBytes + b.vfsLruBytes + b.vfsInFlightBytes +
  b.preBundleSliceBytes + b.streamingBuffersBytes + b.prefetchBundleBytes +
  b.prefetchCacheBytes + b.unattributedReservationBytes;
assert.equal(estimate.estimatedBytes, sum, 'estimatedBytes still equals the breakdown sum');
assert.equal(estimate.ceilingBytes, SUPERVISOR_HEAP_CEILING_BYTES);
assert.equal(b.vfsLruBytes, 35 * 1024, 'VFS LRU input is passed through');

console.log('heap-estimate-blind-spots: OK');
