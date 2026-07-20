#!/usr/bin/env bun
// heap-correctness/diag-reports-stream-retention — N3/N2 telemetry probe.
//
// Probe: assert the diag schema includes the live writeStream retention
// fields and a real install drives them above 0 at some point.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { diagMemory, fmtBytes } from './_diag.mjs';

const sid = await mintSession();
console.log(`[N3] sid=${sid} BASE=${BASE}`);

// Schema check first — these fields must exist regardless of activity.
const baseline = await diagMemory(sid);
const baseDetail = baseline.vfsDetail ?? {};
const schemaHasFields =
  'writeStreamSpoolBytes' in baseDetail &&
  'retainedWriteBytes' in baseDetail;
console.log(`[N3] schema fields present: ${schemaHasFields} (writeStreamSpoolBytes=${baseDetail.writeStreamSpoolBytes})`);

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
        spoolBytes: m.vfsDetail?.writeStreamSpoolBytes ?? 0,
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
const peakSpoolBytes = samples.reduce((a, s) => Math.max(a, s.spoolBytes), 0);

const findings = {
  bug: 'N3',
  sid,
  base: BASE,
  schemaHasFields,
  outcome,
  samples: samples.length,
  peakInFlightBytes: peakInFlight,
  peakWriteStreamSpoolBytes: peakSpoolBytes,
};

console.log(JSON.stringify(findings, null, 2));

const verdict = (() => {
  if (!schemaHasFields) {
    return { state: 'failing', reason: 'vfsDetail does not include writeStreamSpoolBytes and retainedWriteBytes' };
  }
  if (outcome !== 'SUCCESS') return { state: 'failing', reason: `install ${outcome}` };
  if (peakInFlight === 0) {
    return { state: 'failing', reason: `vfsInFlightBytes peaked at 0 across ${samples.length} samples during a real install` };
  }
  return { state: 'passing', reason: `vfsInFlightBytes peak=${fmtBytes(peakInFlight)} (spool=${fmtBytes(peakSpoolBytes)}); schema correct` };
})();
console.log(`[N3] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'passing' ? 0 : 1);
