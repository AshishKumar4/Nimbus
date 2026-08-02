#!/usr/bin/env bun
// heap-estimate-blind-spots — the supervisor heap estimate must not present
// itself as a total when it is a lower bound.
//
// estimateSupervisorHeap sums only INSTRUMENTED allocation sources. The
// prefetch-bundle path in facets/manager.ts contains no
// acquireSupervisorAllocation call and bumps no diag counter, so its bytes
// are invisible. Observed consequence: the supervisor DO was reset three
// times under prefetch-bundle construction while the estimate reported a
// 9.4 MiB baseline and 35 KB of LRU — a reading of ~15% of ceiling taken
// moments before a memory kill.
//
// Pre-fix the returned estimate carried no signal that anything was
// missing, and constants.ts asserted the opposite ("Every supervisor
// allocation site is accounted for"). This test pins the honesty, not a
// number: whatever the estimator can see, it must also say what it cannot.

import assert from 'node:assert/strict';
import {
  estimateSupervisorHeap,
  HEAP_BLIND_SPOTS,
} from '../../packages/worker/src/observability/heap-estimate.ts';
import { readDiagCounters } from '../../packages/worker/src/observability/diag-counters.ts';
import {
  BUNDLE_MAX_ENCODED_BYTES,
  SUPERVISOR_HEAP_CEILING_BYTES,
  VFS_BUNDLE_MAX_BYTES,
} from '../../packages/worker/src/constants.ts';

const estimate = estimateSupervisorHeap(readDiagCounters(), {
  cacheHotBytes: 35 * 1024,
  inFlightWriteBytes: 0,
});

// ── The estimate declares its own incompleteness ────────────────────────
assert.ok(Array.isArray(estimate.blindSpots), 'estimate carries a blind-spot list');
assert.ok(estimate.blindSpots.length > 0,
  'the prefetch-bundle path is unaccounted for, so the list cannot be empty');
assert.equal(estimate.blindSpots, HEAP_BLIND_SPOTS);

for (const spot of estimate.blindSpots) {
  assert.equal(typeof spot.source, 'string');
  assert.ok(spot.source.length > 0, 'a blind spot names its allocation site');
  assert.ok(spot.reason.length > 0, 'a blind spot explains what it allocates');
  assert.ok(spot.capBytes === null || spot.capBytes > 0,
    'capBytes is a positive bound or null for unbounded');
}

// ── The unaccounted path is named specifically ──────────────────────────
// Naming it is the difference between "this number is incomplete" and "go
// instrument buildPrefetchBundle". Both entries must point at manager.ts,
// which is where the missing acquireSupervisorAllocation call belongs.
const sources = estimate.blindSpots.map((s) => s.source);
assert.ok(sources.some((s) => s.includes('buildPrefetchBundle')),
  'the per-exec bundle build is named');
assert.ok(sources.some((s) => s.includes('prefetchBundleCache')),
  'the cross-exec bundle cache is named');
assert.ok(sources.every((s) => s.startsWith('facets/manager.ts:')),
  'blind spots are module-qualified so they are actionable');

// ── An unbounded blind spot forbids a finite worst case ─────────────────
// prefetchBundleCache is an LRU bounded by ENTRY COUNT, not bytes, so no
// finite ceiling can honestly be stated. Reporting a number here would be
// the same class of lie the module is being fixed for.
const unbounded = estimate.blindSpots.filter((s) => s.capBytes === null);
assert.ok(unbounded.length > 0, 'the entry-count-bounded cache is unbounded in bytes');
assert.equal(estimate.blindSpotCeilingBytes, null,
  'an unbounded blind spot must yield a null worst case, not a number');

// ── The gap dwarfs what the estimator does see ──────────────────────────
// This is the whole point: a single retained cache entry can hold more than
// the entire supervisor ceiling the estimate is being measured against.
const perCacheEntryBytes = VFS_BUNDLE_MAX_BYTES + BUNDLE_MAX_ENCODED_BYTES;
assert.ok(perCacheEntryBytes > estimate.estimatedBytes,
  'one unaccounted cache entry exceeds the entire instrumented estimate');
assert.ok(perCacheEntryBytes * 16 > SUPERVISOR_HEAP_CEILING_BYTES,
  'a full cache exceeds the supervisor ceiling many times over');

// ── The instrumented sum is still coherent ──────────────────────────────
// Honesty about coverage must not break the arithmetic that already worked.
const b = estimate.breakdown;
const sum =
  b.supervisorBaselineBytes + b.vfsLruBytes + b.vfsInFlightBytes +
  b.preBundleSliceBytes + b.streamingBuffersBytes + b.unattributedReservationBytes;
assert.equal(estimate.estimatedBytes, sum, 'estimatedBytes still equals the breakdown sum');
assert.equal(estimate.ceilingBytes, SUPERVISOR_HEAP_CEILING_BYTES);
assert.equal(b.vfsLruBytes, 35 * 1024, 'VFS LRU input is passed through');

// The blind spots are NOT folded into estimatedBytes — inventing a number
// for something unmeasured would replace one lie with another.
assert.ok(estimate.estimatedBytes < perCacheEntryBytes,
  'unmeasured bytes are never guessed into the total');

console.log('heap-estimate-blind-spots: OK');
