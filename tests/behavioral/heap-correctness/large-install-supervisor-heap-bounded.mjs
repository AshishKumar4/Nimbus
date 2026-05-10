#!/usr/bin/env bun
// heap-correctness/large-install-supervisor-heap-bounded — N2 probe.
//
// Bug: src/vfs/sqlite-vfs.ts:1193-1209 — writeStream's contract
// promised heap-bounded streaming via `chunkIter: AsyncIterable`.
// The implementation drains the whole iterator into a `chunks: []`
// array BEFORE calling writeBatch (line 1201-1204). The peer side
// already capped its in-flight bytes (single-shared-flush, ~8 MiB),
// but a 600+ pkg install can fan out 8 peers × 8 MiB = 64 MiB of
// concurrent in-flight bytes — and the supervisor still buffers
// each one in full inside `chunks`.
//
// Probe: drive a real Markflow npm install (620 packages, 71 MiB
// tarballs, 48 K files) and SAMPLE /api/_diag/memory continuously.
// Track the peak vfsInFlightBytes (or whatever counter the post-N3
// fix surfaces).
//
// What we assert:
//
//   GREEN — peak heap.bytes during install stays below a documented
//   ceiling (e.g. 32 MiB above baseline). Specifically:
//     - heap.contributions.vfsInFlightBytes peak ≤ 8 MiB (one shard
//       in flight at a time on the supervisor side, even if peers
//       send multiple in parallel).
//   RED — peak vfsInFlightBytes grows unbounded with package count,
//   OR the counter is absent (N3 also broken).

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { diagMemory, fmtBytes } from './_diag.mjs';

const sid = await mintSession();
console.log(`[N2] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2000);
await t.waitForPrompt(15_000).catch(() => {});

const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const m = await diagMemory(sid);
      samples.push({
        ts: Date.now(),
        heapBytes: m.heap?.estimatedBytes ?? 0,
        breakdown: m.heap?.breakdown ?? {},
        cacheHotBytes: m.vfsDetail?.lruBytes ?? 0,
        pendingWrites: m.vfsDetail?.pendingWrites ?? null,
      });
    } catch { /* sampler error — stop quietly */ }
    await sleep(800);
  }
})();

// Drive a real install — same flow Markflow probe uses.
t.cmd('git clone https://github.com/AshishKumar4/Markflow');
await t.waitFor((b) => /clone complete|done\./i.test(b), 180_000, 'clone');
await t.run('cd /home/user/Markflow', 5_000);
t.reset();
const t0 = Date.now();
t.cmd('npm i');
let outcome = 'TIMEOUT';
try {
  await t.waitFor(
    (b) => /added \d+ packages|npm install failed|\[batch-fanout\] aborted/i.test(b),
    300_000,
    'install end',
  );
  const out = stripAnsi(t.buf);
  if (/added\s+\d+\s+packages/.test(out)) outcome = 'SUCCESS';
  else if (/\[batch-fanout\] aborted/.test(out)) outcome = 'BATCH_FANOUT_ABORT';
  else if (/npm install failed/.test(out)) outcome = 'FAIL';
} catch {
  outcome = 'TIMEOUT';
}
const installMs = Date.now() - t0;

// Stop sampler.
sampling = false;
await sampler;
await t.close();

// Compute peaks from the sample stream.
const peakHeap = samples.reduce((a, s) => Math.max(a, s.heapBytes ?? 0), 0);
const peakInFlight = samples.reduce((a, s) => Math.max(a, s.breakdown?.vfsInFlightBytes ?? 0), 0);
const peakPending = samples.reduce((a, s) => Math.max(a, s.pendingWrites ?? 0), 0);
const peakCacheHot = samples.reduce((a, s) => Math.max(a, s.cacheHotBytes ?? 0), 0);

const findings = {
  bug: 'N2',
  sid,
  base: BASE,
  outcome,
  installMs,
  samples: samples.length,
  peakHeapBytes: peakHeap,
  peakInFlightWriteBytes: peakInFlight,
  peakPendingWritesEntries: peakPending,
  peakCacheHotBytes: peakCacheHot,
  // Surface contributors at peak so we can identify the dominant.
  breakdownKeysSeen: [...new Set(samples.flatMap(s => Object.keys(s.breakdown ?? {})))],
};

console.log(JSON.stringify(findings, null, 2));

const verdict = (() => {
  if (outcome !== 'SUCCESS') return { state: 'RED', reason: `install ${outcome}` };
  // Without N3 fix, peakInFlightWriteBytes is always 0 (constant). The
  // structural N2 property is observable only if we can SEE the
  // counter. So this probe is RED until both N2 + N3 ship together.
  if (peakInFlight === 0) return { state: 'RED', reason: 'peakInFlightWriteBytes always 0 — counter is hardcoded (N3) so N2 invisible' };
  // Post-fix: a single-shard cap of ~8 MiB at the supervisor side.
  // Allow some headroom since multiple shards can arrive in quick
  // succession; we cap at 16 MiB.
  const CEILING = 16 * 1024 * 1024;
  if (peakInFlight > CEILING) {
    return { state: 'RED', reason: `peakInFlightWriteBytes=${fmtBytes(peakInFlight)} > ${fmtBytes(CEILING)}` };
  }
  return { state: 'GREEN', reason: `peakInFlightWriteBytes=${fmtBytes(peakInFlight)} ≤ ${fmtBytes(CEILING)}` };
})();
console.log(`[N2] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'GREEN' ? 0 : 1);
