#!/usr/bin/env bun
// sdk/new/live-sdk-exec-stream — `sandbox.execStream` delivers a command's
// output while it runs, through the remote SDK path (HTTP body ← the session
// DO's RPC stream), and a 14.9 MB output does not cost the session.
//
// `exec` used to return one string at exit. Kinu measured `seq 1 2000000`
// through exec dropping its socket after 6.6 s while the terminal streamed
// the same output (Kinu report K10/K11, Nimbus ask N4).

import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('sdk/new/live-sdk-exec-stream');
console.log(`sdk/new/live-sdk-exec-stream — BASE=${BASE}`);

const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');

const box = Nimbus.connect({
  endpoint: BASE,
  ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}),
}).sandbox(`exec-stream-${Date.now()}`);

const SEQ_2M_BYTES = 14_888_896;
const decoder = new TextDecoder();

try {
  const early = await box.execStream('echo first; sleep 2; echo second');
  const reader = early.output.getReader();
  const started = Date.now();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  let rest = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    rest += decoder.decode(next.value.data);
  }
  const doneAt = Date.now() - started;
  a.check('the first line arrives before the command exits',
    decoder.decode(first.value?.data) === 'first\n' && firstAt < 1500 && doneAt >= 1800 && rest === 'second\n',
    JSON.stringify({ first: decoder.decode(first.value?.data), firstAt, doneAt, rest }));
  a.check('exit reports the exit code', (await early.exit).exitCode === 0);

  const split = await box.execStream('echo out; echo err >&2; exit 3');
  const seen = { stdout: '', stderr: '' };
  for await (const chunk of split.output) seen[chunk.stream] += decoder.decode(chunk.data);
  const splitExit = await split.exit;
  a.check('stderr arrives on its own stream, with the exit code',
    seen.stdout === 'out\n' && seen.stderr === 'err\n' && splitExit.exitCode === 3,
    JSON.stringify({ seen, exitCode: splitExit.exitCode }));

  const big = await box.execStream('seq 1 2000000');
  const bigStarted = Date.now();
  let bytes = 0;
  let chunks = 0;
  let last = new Uint8Array();
  for await (const chunk of big.output) {
    if (chunk.stream !== 'stdout') continue;
    bytes += chunk.data.byteLength;
    chunks++;
    last = chunk.data;
  }
  const bigExit = await big.exit;
  const tail = decoder.decode(last.subarray(Math.max(0, last.byteLength - 8)));
  console.log(`  seq 1 2000000: ${bytes} bytes in ${chunks} chunks, ${Date.now() - bigStarted} ms`);
  a.check('seq 1 2000000 streams all 14.9 MB and exits 0',
    bytes === SEQ_2M_BYTES && tail.endsWith('2000000\n') && bigExit.exitCode === 0,
    JSON.stringify({ bytes, chunks, tail, exitCode: bigExit.exitCode }));

  const cancelled = await box.execStream('seq 1 100000000');
  const cancelReader = cancelled.output.getReader();
  await cancelReader.read();
  await cancelReader.cancel('probe stops reading');
  const cancelOutcome = await cancelled.exit.then(() => 'resolved', () => 'rejected');
  a.check('cancelling the output rejects exit', cancelOutcome === 'rejected', cancelOutcome);

  let stillRunning = true;
  for (let i = 0; i < 40 && stillRunning; i++) {
    const listed = await box.processes.list();
    stillRunning = listed.some((p) => p.command === 'seq 1 100000000' && p.state === 'running');
    if (stillRunning) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  a.check('the cancelled command stops', !stillRunning);

  const moved = await box.execStream('cd /tmp', { shellId: 'probe-shell' });
  for await (const _ of moved.output) { /* no output */ }
  await moved.exit;
  const where = await box.exec('pwd', { shellId: 'probe-shell' });
  a.check('a named shell keeps the cwd a streamed call set',
    where.stdout === '/tmp\n', JSON.stringify(where));

  const after = await box.exec('echo alive');
  a.check('the session survives and still runs commands',
    after.exitCode === 0 && after.stdout === 'alive\n',
    JSON.stringify(after));
} finally {
  await box.destroy({ reason: 'live-sdk-exec-stream-complete' }).catch(() => {});
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
