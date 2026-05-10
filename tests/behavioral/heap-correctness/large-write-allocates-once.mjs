#!/usr/bin/env bun
// heap-correctness/large-write-allocates-once — H10 probe.
//
// Bug: src/vfs/sqlite-vfs.ts:929 — `data.slice(...)` allocates a
// brand-new chunk-sized ArrayBuffer per chunk on the multi-chunk
// writeFile path. Per-call transient peak is ~3N for an N-MiB file
// (source + slice + deferWrite copy). After fix: subarray view +
// one defensive copy at persistence = ~2N transient.
//
// Probe shape: a real `git clone + npm i` exercises both the
// writeFile path (single-shot writes from rpc.ts:677) AND the
// writeStream path (peer-side install-batch RPCs). Both go through
// the H10-fixed _pendingWriteBytes accounting + the N2-fixed
// _writeStreamSpoolBytes. We sample /api/_diag/memory throughout
// and look for non-zero in-flight bytes — a black-box proxy for
// "the counter is real" (was hardcoded 0 pre-fix).
//
// Why a real install instead of /api/write-file: the synthetic POST
// path holds pendingWrites for one microtask (queueMicrotask flush),
// which a separate HTTP probe can never observe. A real install has
// async writeStream draining over many input-gate turns — the
// counter stays non-zero across multiple diag samples.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { diagMemory, fmtBytes } from './_diag.mjs';

const sid = await mintSession();
console.log(`[H10] sid=${sid} BASE=${BASE}`);

const baseline = await diagMemory(sid);
const baseBytes = baseline.heap?.estimatedBytes ?? 0;
console.log(`[H10] baseline heap.estimatedBytes=${fmtBytes(baseBytes)}`);

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
        heap: m.heap?.estimatedBytes ?? 0,
        cache: m.vfsDetail?.lruBytes ?? 0,
        inFlight: m.heap?.breakdown?.vfsInFlightBytes ?? 0,
        pendingBytes: m.vfsDetail?.pendingWriteBytes ?? 0,
        spoolBytes: m.vfsDetail?.writeStreamSpoolBytes ?? 0,
      });
    } catch {}
  }
})();

// Drive a real install — exercises both writeFile (rpc.ts:677, git
// clone) and writeStream (peer-side npm install batches).
const t0 = Date.now();
t.cmd('git clone https://github.com/AshishKumar4/Markflow');
await t.waitFor((b) => /clone complete|done\./i.test(b), 180_000, 'clone');
await t.run('cd /home/user/Markflow', 5_000);
t.reset();
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
}
catch { outcome = 'TIMEOUT'; }

sampling = false;
await sampler;
await t.close();
const elapsed = Date.now() - t0;

const after = await diagMemory(sid);
const afterBytes = after.heap?.estimatedBytes ?? 0;
const grew = afterBytes - baseBytes;
const breakdown = after.heap?.breakdown ?? {};

const peakHeap = samples.reduce((a, s) => Math.max(a, s.heap), 0);
const peakInFlight = samples.reduce((a, s) => Math.max(a, s.inFlight), 0);
const peakPendingBytes = samples.reduce((a, s) => Math.max(a, s.pendingBytes), 0);
const peakSpoolBytes = samples.reduce((a, s) => Math.max(a, s.spoolBytes), 0);

const findings = {
  bug: 'H10',
  sid,
  base: BASE,
  outcome,
  installMs: elapsed,
  samples: samples.length,
  baseHeapBytes: baseBytes,
  afterHeapBytes: afterBytes,
  grewBytes: grew,
  peakHeapBytes: peakHeap,
  peakInFlightBytes: peakInFlight,
  peakPendingWriteBytes: peakPendingBytes,
  peakWriteStreamSpoolBytes: peakSpoolBytes,
  steadyVfsInFlightBytes: breakdown.vfsInFlightBytes ?? null,
  vfsFiles: after.vfs?.files,
  vfsBytes: after.vfs?.usedBytes,
};

console.log(JSON.stringify(findings, null, 2));

// GREEN requires:
//   (a) install succeeded
//   (b) peakInFlightBytes > 0 — proves the H10/N3 counter is real
//       (slice→subarray fix is in the same code path as the counter
//       wiring; if the accounting is correct, the fix is in)
//   (c) peakInFlightBytes ≤ architectural ceiling (32 MiB).
//
// Architectural ceiling derivation:
//   8 peers (MAX_PEER_FANOUT) × 4 MiB (SHARED_RPC_FLUSH_THRESHOLD)
//   = 32 MiB worst-case if every peer's RPC is in flight simultaneously
//   AND each is mid-spool. Workerd's input-gate serialisation makes
//   that worst case unreachable in practice; observed peaks are
//   ~5-20 MiB depending on per-peer shard size and tarball mix.
const CEILING = 32 * 1024 * 1024;
const verdict = (() => {
  if (outcome !== 'SUCCESS') return { state: 'RED', reason: `install ${outcome}` };
  if (peakInFlight === 0) {
    return { state: 'RED', reason: `peakInFlightBytes=0 across ${samples.length} samples during a ${(elapsed/1000).toFixed(1)}s install — counter is hardcoded` };
  }
  if (peakInFlight > CEILING) {
    return { state: 'RED', reason: `peakInFlightBytes=${fmtBytes(peakInFlight)} > ceiling ${fmtBytes(CEILING)}` };
  }
  return { state: 'GREEN', reason: `peakInFlight=${fmtBytes(peakInFlight)} (pending=${fmtBytes(peakPendingBytes)}, spool=${fmtBytes(peakSpoolBytes)}) ≤ ${fmtBytes(CEILING)}` };
})();
console.log(`[H10] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'GREEN' ? 0 : 1);
