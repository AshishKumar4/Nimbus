#!/usr/bin/env bun
// heap-correctness/diag-reports-pending-writes — N3 probe.
//
// Bug: src/session/routes.ts:347-348 — `inFlightWriteBytes: 0` was
// hardcoded with the comment "matches reality (writes are flushed in
// microseconds)". Wrong: pendingWrites can hold up to 500 chunks ×
// 64 KiB = 32 MiB pre-flush, AND writeStream spools the active batch.
//
// Probe: assert the diag schema includes the new fields AND a real
// install drives them above 0 at some point. Same observability
// layer as the H10 probe — the underlying counter is shared.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { diagMemory, fmtBytes } from './_diag.mjs';

const sid = await mintSession();
console.log(`[N3] sid=${sid} BASE=${BASE}`);

// Schema check first — these fields must exist regardless of activity.
const baseline = await diagMemory(sid);
const baseDetail = baseline.vfsDetail ?? {};
const schemaHasFields =
  'pendingWriteBytes' in baseDetail &&
  'writeStreamSpoolBytes' in baseDetail &&
  'pendingWrites' in baseDetail;
console.log(`[N3] schema fields present: ${schemaHasFields} (pendingWriteBytes=${baseDetail.pendingWriteBytes}, writeStreamSpoolBytes=${baseDetail.writeStreamSpoolBytes})`);

// Drive real activity — same shape as N2 / H10 probes use. Install
// chunks pass through writeStream which holds the spool counter
// non-zero across many input-gate turns.
const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const m = await diagMemory(sid);
      samples.push({
        inFlight: m.heap?.breakdown?.vfsInFlightBytes ?? 0,
        pendingBytes: m.vfsDetail?.pendingWriteBytes ?? 0,
        spoolBytes: m.vfsDetail?.writeStreamSpoolBytes ?? 0,
        pendingEntries: m.vfsDetail?.pendingWrites ?? 0,
      });
    } catch {}
  }
})();

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
  if (/added\s+\d+\s+packages/.test(stripAnsi(t.buf))) outcome = 'SUCCESS';
} catch { outcome = 'TIMEOUT'; }

sampling = false;
await sampler;
await t.close();

const peakInFlight = samples.reduce((a, s) => Math.max(a, s.inFlight), 0);
const peakPendingBytes = samples.reduce((a, s) => Math.max(a, s.pendingBytes), 0);
const peakSpoolBytes = samples.reduce((a, s) => Math.max(a, s.spoolBytes), 0);
const peakPendingEntries = samples.reduce((a, s) => Math.max(a, s.pendingEntries), 0);

const findings = {
  bug: 'N3',
  sid,
  base: BASE,
  schemaHasFields,
  outcome,
  samples: samples.length,
  peakInFlightBytes: peakInFlight,
  peakPendingWriteBytes: peakPendingBytes,
  peakWriteStreamSpoolBytes: peakSpoolBytes,
  peakPendingWritesEntries: peakPendingEntries,
};

console.log(JSON.stringify(findings, null, 2));

const verdict = (() => {
  if (!schemaHasFields) {
    return { state: 'RED', reason: 'vfsDetail does not include the post-fix fields (pendingWriteBytes, writeStreamSpoolBytes)' };
  }
  if (outcome !== 'SUCCESS') return { state: 'RED', reason: `install ${outcome}` };
  if (peakInFlight === 0) {
    return { state: 'RED', reason: `vfsInFlightBytes peaked at 0 across ${samples.length} samples during a real install` };
  }
  return { state: 'GREEN', reason: `vfsInFlightBytes peak=${fmtBytes(peakInFlight)} (pending=${fmtBytes(peakPendingBytes)}, spool=${fmtBytes(peakSpoolBytes)}); schema correct` };
})();
console.log(`[N3] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'GREEN' ? 0 : 1);
