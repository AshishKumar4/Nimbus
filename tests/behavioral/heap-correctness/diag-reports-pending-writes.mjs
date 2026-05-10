#!/usr/bin/env bun
// heap-correctness/diag-reports-pending-writes — N3 probe.
//
// Bug: src/session/routes.ts:347-348 — `inFlightWriteBytes: 0` is
// hardcoded with the comment "matches reality (writes are flushed in
// microseconds)". That comment is wrong: pendingWrites can hold up to
// 500 chunks × 64 KiB = 32 MiB AND writeStream's spool array can hold
// the whole batch (up to 32 MiB cap). Both are invisible to ops.
//
// What we assert:
//
//   GREEN — heap.contributions.vfsInFlightBytes is REAL (sum of
//   pendingWrites payload bytes + chunkIter spool size if any +
//   transient cacheSet retained bytes since the last flush).
//
//   RED — counter is always 0 regardless of activity.
//
// We test by:
//   1. Sample baseline.
//   2. POST a 4 MiB file via /api/write-file (multi-chunk path).
//   3. RACE: sample memory ASAP after the POST returns. The flush
//      runs in queueMicrotask, so an immediate next-tick sample sees
//      pendingWrites populated. Then poll a second time after a
//      brief sleep so the second reading should be back to 0.
//
//      In practice, queueMicrotask can fire before our follow-up
//      fetch even reaches the supervisor, so getting "non-zero in
//      sample 1" is racey on the wire. Instead, we drive a HEAVIER
//      load (multiple writes back-to-back without awaiting) so
//      pending stays > 500 entries → forced sync flush → AT LEAST
//      one sample catches non-zero state.

import { mintSession, BASE } from '../_driver.mjs';
import { diagMemory, fmtBytes } from './_diag.mjs';

const sid = await mintSession();
console.log(`[N3] sid=${sid} BASE=${BASE}`);

const baseline = await diagMemory(sid);
const baseInFlight = baseline.heap?.breakdown?.vfsInFlightBytes ?? 0;
console.log(`[N3] baseline vfsInFlightBytes=${fmtBytes(baseInFlight)}`);

// Burst: 8 parallel 4-MiB writes. Each splits into 64 chunks; total
// 512 chunks queued ⇒ pendingWrites threshold (500) trips a sync
// flush, but in the steady-state racing window between dispatches
// at least one diag sample should catch live in-flight bytes.
const SIZE = 4 * 1024 * 1024;
const N = 8;
const content = 'y'.repeat(SIZE);
const writes = [];
for (let i = 0; i < N; i++) {
  writes.push(fetch(`${BASE}/s/${sid}/api/write-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `home/user/heap-n3-${i}.bin`, content }),
  }));
}

// Sample memory while writes are in flight.
const samples = [];
const sampler = (async () => {
  for (let i = 0; i < 30; i++) {
    try {
      const m = await diagMemory(sid);
      samples.push({
        ts: Date.now(),
        inFlight: m.heap?.breakdown?.vfsInFlightBytes ?? 0,
        heap: m.heap?.estimatedBytes ?? 0,
        pendingWrites: m.vfsDetail?.pendingWrites ?? 0,
      });
    } catch {}
    // No await — back-to-back samples to catch the transient.
  }
})();

await Promise.all(writes);
await sampler;

const peakInFlight = samples.reduce((a, s) => Math.max(a, s.inFlight ?? 0), 0);
const peakHeap = samples.reduce((a, s) => Math.max(a, s.heap ?? 0), 0);
const peakPending = samples.reduce((a, s) => Math.max(a, s.pendingWrites ?? 0), 0);

const findings = {
  bug: 'N3',
  sid,
  base: BASE,
  baselineInFlight: baseInFlight,
  bursts: N,
  bytesPerWrite: SIZE,
  totalWriteBytes: N * SIZE,
  samples: samples.length,
  peakInFlightBytes: peakInFlight,
  peakHeapBytes: peakHeap,
  peakPendingWritesEntries: peakPending,
  // Inspect the sample track shape — a flat zero is the RED tell.
  sampleSummary: samples.map(s => ({ inFlight: s.inFlight, pending: s.pendingWrites })),
};

console.log(JSON.stringify(findings, null, 2));

const verdict = (() => {
  // RED: the counter is constantly 0. peakPendingWritesEntries also
  // helps confirm there WAS in-flight activity to be observed.
  if (peakInFlight === 0) {
    return {
      state: 'RED',
      reason: `vfsInFlightBytes peaked at 0 across ${samples.length} samples (peakPending=${peakPending} confirms activity)`,
    };
  }
  return { state: 'GREEN', reason: `vfsInFlightBytes peak=${fmtBytes(peakInFlight)}` };
})();
console.log(`[N3] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'GREEN' ? 0 : 1);
