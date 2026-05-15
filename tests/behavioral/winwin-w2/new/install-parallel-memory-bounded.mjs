#!/usr/bin/env bun
// winwin-w2/install-parallel-memory-bounded — peakInFlightWriteBytes
// stays bounded during a parallel clang install.
//
// Risk being guarded: with concurrency=3, three large blobs could
// concurrently allocate ArrayBuffers (worst case clang.wasm 31 MB +
// wasm-ld 19 MB + memfs.wasm 345 KB ≈ 50 MB held). Plus pendingWrites
// cumulative chunks until auto-flush at ~32 MiB (sqlite-vfs.ts:606).
//
// Threshold: 64 MiB. The N2 baseline probe asserts ≤ 32 MiB for the
// install path, but that measures `peakInFlightWriteBytes` which
// reflects pendingWrites (the post-writeFile state). Caller-side
// ArrayBuffers during fetch are not in that counter. We assert the
// counter stays under 64 MiB as a defense-in-depth measure: the
// auto-flush at 500-entries / 32 MiB should keep this well under
// our threshold even with concurrency=3.

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w2/install-parallel-memory-bounded');
console.log(`winwin-w2/install-parallel-memory-bounded — ${BASE}`);

const PEAK_LIMIT_BYTES = 64 * 1024 * 1024; // 64 MiB

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const { output } = await t.run('nimbus install clang', 180_000);
const installedOk = /installed at/.test(stripAnsi(output));
a.check('clang install completed', installedOk,
  `tail=${JSON.stringify(stripAnsi(output).slice(-200))}`);

// Snapshot heap stats immediately after install. The peak counters
// are cumulative since isolate boot; they'll reflect what happened
// during the (just-completed) install.
const mem = await diagMemory(sid);
const peakInFlight = mem?.heap?.breakdown?.peakInFlightWriteBytes
  ?? mem?.heap?.breakdown?.vfsInFlightBytes
  ?? 0;
console.log(`[install-parallel-memory-bounded] peakInFlightWriteBytes=${(peakInFlight / 1024 / 1024).toFixed(2)} MiB threshold=${(PEAK_LIMIT_BYTES / 1024 / 1024).toFixed(0)} MiB`);

a.check(
  `peakInFlightWriteBytes ≤ ${(PEAK_LIMIT_BYTES / 1024 / 1024).toFixed(0)} MiB`,
  peakInFlight <= PEAK_LIMIT_BYTES,
  `peakInFlight=${(peakInFlight / 1024 / 1024).toFixed(2)} MiB limit=${(PEAK_LIMIT_BYTES / 1024 / 1024).toFixed(0)} MiB rawBytes=${peakInFlight}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
