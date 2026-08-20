#!/usr/bin/env bun
// The Stage 4 W7 credit pool is the supervisor-side memory bound for every
// concurrent git/npm write stream targeting one session Durable Object.

import {
  BASE,
  deleteSession,
  makeAsserter,
  mintSession,
  sleep,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';
import { diagMemory, fmtBytes } from '../../heap-correctness/_diag.mjs';
import { W7_MAX_RECORD_BYTES } from '../../../../packages/platform/src/w7-frame.ts';

if (!process.env.BASE) {
  console.error('FATAL: BASE env required');
  process.exit(2);
}

const CREDIT_LIMIT = 8 * 1024 * 1024;
const MAX_ACTIVE_STREAMS = 8;
const RETAINED_LIMIT = CREDIT_LIMIT + (MAX_ACTIVE_STREAMS * W7_MAX_RECORD_BYTES);
const a = makeAsserter('install-performance/install-parallel-memory-bounded');
const sid = await mintSession();
const terminal = new Terminal(sid);
const samples = [];
let sampling = false;
let sampler = null;
let cloneOutput = '';
let installOutput = '';
let finalMemory = null;

console.log(`install-performance/install-parallel-memory-bounded — ${BASE} sid=${sid}`);

try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  const baseline = await diagMemory(sid);
  for (const field of [
    'creditRetainedBytes',
    'decoderRetainedBytes',
    'retainedWriteBytes',
    'stagedBytes',
  ]) {
    const value = baseline.vfsDetail?.[field];
    a.check(
      `${field} exposes finite current/peak telemetry`,
      Number.isFinite(value?.current) && Number.isFinite(value?.peak),
      JSON.stringify(value),
    );
  }

  sampling = true;
  sampler = (async () => {
    while (sampling) {
      try {
        const memory = await diagMemory(sid);
        samples.push(memory.vfsDetail);
      } catch (error) {
        console.warn(`[install-parallel-memory-bounded] sampler: ${error.message}`);
      }
      await sleep(100);
    }
  })();

  ({ output: cloneOutput } = await terminal.run(
    'git clone https://github.com/AshishKumar4/Markflow /home/user/Markflow',
    180_000,
  ));
  await terminal.run('cd /home/user/Markflow', 5_000);
  ({ output: installOutput } = await terminal.run('npm install', 300_000));
  await sleep(500);
  finalMemory = await diagMemory(sid);
} finally {
  sampling = false;
  if (sampler) await sampler.catch(() => {});
  try { await terminal.close(); } catch { /* cleanup continues */ }
  await deleteSession(sid).catch(() => {});
}

const cloneText = stripAnsi(cloneOutput);
const installText = stripAnsi(installOutput);
a.check(
  'clone completed without reset/timeout errors',
  !/reset|storage operation timed out|executionerror|error 1101|cancelled/i.test(cloneText),
  cloneText.slice(-500),
);
a.check(
  'parallel install completed successfully',
  /added\s+\d+\s+packages|up to date/i.test(installText)
    && !/npm install failed|batch-fanout.*aborted|storage operation timed out/i.test(installText),
  installText.slice(-800),
);

const peak = (field) => samples.reduce(
  (maximum, sample) => Math.max(maximum, sample?.[field]?.peak ?? 0),
  finalMemory?.vfsDetail?.[field]?.peak ?? 0,
);
const peakCredit = peak('creditRetainedBytes');
const peakRetained = peak('retainedWriteBytes');
const peakDecoder = peak('decoderRetainedBytes');

a.check(
  'credit telemetry observed real streamed payload',
  peakCredit > 0,
  `samples=${samples.length} peak=${fmtBytes(peakCredit)}`,
);
a.check(
  'aggregate credited payload stayed within 8 MiB',
  peakCredit <= CREDIT_LIMIT,
  `peak=${fmtBytes(peakCredit)} limit=${fmtBytes(CREDIT_LIMIT)}`,
);
a.check(
  'retained payload stayed within credit plus eight record envelopes',
  peakRetained > 0 && peakRetained <= RETAINED_LIMIT,
  `peak=${fmtBytes(peakRetained)} limit=${fmtBytes(RETAINED_LIMIT)}`,
);
a.check(
  'decoder-retained payload stayed within the same bounded envelope',
  peakDecoder <= RETAINED_LIMIT,
  `peak=${fmtBytes(peakDecoder)} limit=${fmtBytes(RETAINED_LIMIT)}`,
);

const idle = finalMemory?.vfsDetail ?? {};
for (const [label, value] of [
  ['creditRetainedBytes.current', idle.creditRetainedBytes?.current],
  ['retainedWriteBytes.current', idle.retainedWriteBytes?.current],
  ['decoderRetainedBytes.current', idle.decoderRetainedBytes?.current],
  ['stagedBytes.current', idle.stagedBytes?.current],
  ['writeStreamSpoolBytes', idle.writeStreamSpoolBytes],
]) {
  a.check(`${label} returned to zero`, value === 0, `actual=${value}`);
}

console.log(JSON.stringify({
  sid,
  samples: samples.length,
  peakCreditBytes: peakCredit,
  peakRetainedBytes: peakRetained,
  peakDecoderBytes: peakDecoder,
}, null, 2));

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
