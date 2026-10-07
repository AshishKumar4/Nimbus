#!/usr/bin/env bun
/**
 * recordCacheStatEvents (core _shared/cache-stats.ts), the one fold of the
 * cache hit/miss events the R2 cache client, the supervisor's RPCs and the
 * install and resolve facets return: hits count with their bytes, misses
 * count, and an event of another kind (a malformed one from across an
 * isolate boundary) is skipped rather than counted or thrown on.
 */

import assert from 'node:assert/strict';
import { recordCacheStatEvents, reset, snapshot } from '../../packages/core/src/_shared/cache-stats.ts';

reset();
recordCacheStatEvents([
  { kind: 'hit', tier: 'L2', cacheKind: 'tarball', bytes: 100 },
  { kind: 'hit', tier: 'L2', cacheKind: 'tarball', bytes: 50 },
  { kind: 'miss', tier: 'L3', cacheKind: 'packument' },
  { kind: 'evicted', tier: 'L2', cacheKind: 'tarball' },
]);
recordCacheStatEvents(undefined);
recordCacheStatEvents([]);
const { byTier, hitRate } = snapshot();
assert.deepEqual(byTier.L2.tarball, { hits: 2, misses: 0, bytes: 150 }, 'two hits with their bytes; the unknown kind is no miss');
assert.deepEqual(byTier.L3.packument, { hits: 0, misses: 1, bytes: 0 });
assert.equal(hitRate.L2.tarball, 1);
assert.equal(hitRate.L3.packument, 0);
console.log('cache-stat-events: hits, misses and an unknown kind fold as recorded');
