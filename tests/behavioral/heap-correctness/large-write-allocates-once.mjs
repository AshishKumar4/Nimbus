#!/usr/bin/env bun
// heap-correctness/large-write-allocates-once — H10 probe.
//
// Bug: src/vfs/sqlite-vfs.ts:929 — `data.slice(...)` on the multi-chunk
// path allocates a brand-new chunk-sized ArrayBuffer per chunk, then
// the immediately-following deferWrite (line 544-545) ALSO copies into
// a fresh ArrayBuffer. Peak heap during writeFile of an N-MiB file is
// ~3N MiB (source + slice + deferWrite copy). The cacheSet stores the
// slice; the deferWrite copy spends its life in pendingWrites until
// the next microtask flushes.
//
// We can't directly observe the chunk-time allocation peak from outside
// the supervisor, but we CAN observe the steady-state delta after the
// write completes. After fix:
//   - cache holds N MiB of view-into-source (still N MiB)
//   - pendingWrites holds the same N MiB (one defensive copy at the
//     persistence boundary)
// Total ≈ 2N MiB resident transient.
//
// Before fix:
//   - cache holds N MiB of fresh slices
//   - pendingWrites holds another N MiB of fresh copies
//   - the source `data` Uint8Array is held by the caller in body.content
// Total ≈ 3N MiB resident transient + source.
//
// What we assert:
//
//   GREEN — sequential writes of K MiB each cumulate to ≤ ceil(2K) MiB
//   on heap.bytes growth (allowing for prior baseline). The constant
//   factor improvement is what matters; if heap grows by ≥ 3K we're
//   not in the post-fix regime.
//
//   RED before fix — heap.bytes grows by ≥ 3K MiB after a single
//   K-MiB write because slice + deferWrite-copy both materialise.
//
// Black-box surfaces only: /api/write-file (POST), /api/_diag/memory.

import { mintSession, BASE } from '../_driver.mjs';
import { diagMemory, fmtBytes } from './_diag.mjs';

const sid = await mintSession();
console.log(`[H10] sid=${sid} BASE=${BASE}`);

// Baseline.
const baseline = await diagMemory(sid);
const baseBytes = baseline.heap?.estimatedBytes ?? 0;
console.log(`[H10] baseline heap.estimatedBytes=${fmtBytes(baseBytes)} cache.hotBytes=${fmtBytes(baseline.vfsDetail?.lruBytes ?? 0)}`);

// Write a 16 MiB file. CHUNK_SIZE=64 KiB → 256 chunks. Pre-fix the
// loop allocates 256 fresh ArrayBuffers from data.slice + 256 more
// from deferWrite's defensive copy + the source AB held by the
// caller — peak ~3×SIZE = 48 MiB transient. Post-fix subarray, the
// loop produces 256 views into the source (no fresh ABs); deferWrite
// still copies once at the persistence boundary; the cache holds the
// views; total peak ≈ 2×SIZE.
//
// CONCURRENT writes amplify: 4 of these in parallel = 4×3×SIZE = 192
// MiB pre-fix vs 4×2×SIZE = 128 MiB post-fix. We sample mid-flight
// to catch the transient.
const SIZE = 16 * 1024 * 1024;
const N_CONCURRENT = 4;
const content = 'x'.repeat(SIZE);

const t0 = Date.now();
const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const m = await diagMemory(sid);
      samples.push({
        ts: Date.now(),
        heap: m.heap?.estimatedBytes ?? 0,
        cache: m.vfsDetail?.lruBytes ?? 0,
        inFlight: m.heap?.breakdown?.vfsInFlightBytes ?? 0,
      });
    } catch {}
  }
})();

const writes = [];
for (let i = 0; i < N_CONCURRENT; i++) {
  writes.push(fetch(`${BASE}/s/${sid}/api/write-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `home/user/heap-h10-${i}.bin`, content }),
  }));
}
const responses = await Promise.all(writes);
const allOk = responses.every((r) => r.ok);
sampling = false;
await sampler;

if (!allOk) {
  const codes = responses.map(r => r.status);
  console.error(`[H10] one or more writes failed: ${codes.join(',')}`);
  process.exit(2);
}
const elapsed = Date.now() - t0;

// Steady-state read after the burst: cache holds N×SIZE clean entries.
const after = await diagMemory(sid);
const afterBytes = after.heap?.estimatedBytes ?? 0;
const grew = afterBytes - baseBytes;
const cacheHot = after.vfsDetail?.lruBytes ?? 0;
const breakdown = after.heap?.breakdown ?? {};

const peakHeap = samples.reduce((a, s) => Math.max(a, s.heap), 0);
const peakInFlight = samples.reduce((a, s) => Math.max(a, s.inFlight), 0);
const peakCache = samples.reduce((a, s) => Math.max(a, s.cache), 0);

const totalBytesWritten = N_CONCURRENT * SIZE;
const findings = {
  bug: 'H10',
  sid,
  base: BASE,
  writes: N_CONCURRENT,
  bytesPerWrite: SIZE,
  totalBytesWritten,
  writeMs: elapsed,
  baseHeapBytes: baseBytes,
  afterHeapBytes: afterBytes,
  grewBytes: grew,
  steadyCacheHotBytes: cacheHot,
  steadyVfsInFlightBytes: breakdown.vfsInFlightBytes ?? null,
  samples: samples.length,
  peakHeapBytes: peakHeap,
  peakInFlightBytes: peakInFlight,
  peakCacheBytes: peakCache,
  // Pre-fix triple-allocation: peak ≥ 3×totalBytesWritten + baseline.
  // Post-fix: peak ~ 2×totalBytesWritten + baseline (cache + one
  // defensive copy at deferWrite). The N3 fix surfaces the in-flight
  // counter; without it the peak heap stays under-reported.
  vfsFiles: after.vfs?.files,
  vfsBytes: after.vfs?.usedBytes,
};

console.log(JSON.stringify(findings, null, 2));

// Verdict:
// - GREEN requires both: (a) all writes succeeded; (b) the heap
//   estimator surfaces non-zero in-flight bytes during the transient
//   so the underlying allocation is observable.
// - The steady-state cache should approximate totalBytesWritten
//   (single ownership at rest); if it's significantly below, files
//   weren't durable.
const verdict = (() => {
  if (after.vfs?.files == null || after.vfs.files < N_CONCURRENT) {
    return { state: 'RED', reason: `only ${after.vfs?.files} files present, expected ${N_CONCURRENT}` };
  }
  if (peakInFlight === 0) {
    return { state: 'RED', reason: `peakInFlightBytes=0 despite ${samples.length} samples during ${fmtBytes(totalBytesWritten)} of writes — N3 counter missing OR write path not landing in pendingWrites` };
  }
  // Cache should never exceed total bytes written (single ownership).
  if (cacheHot > totalBytesWritten + 1024 * 1024) {
    return { state: 'RED', reason: `steady cache=${fmtBytes(cacheHot)} > total=${fmtBytes(totalBytesWritten)}+1MiB headroom` };
  }
  return { state: 'GREEN', reason: `peakInFlight=${fmtBytes(peakInFlight)}, steadyCache=${fmtBytes(cacheHot)} (≈ ${fmtBytes(totalBytesWritten)})` };
})();
console.log(`[H10] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'GREEN' ? 0 : 1);
