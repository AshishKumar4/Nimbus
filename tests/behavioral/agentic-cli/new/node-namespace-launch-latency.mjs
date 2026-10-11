#!/usr/bin/env bun
// Small-program launch timing and sequential namespace checks.
import { mintSession, Terminal, makeAsserter, deleteSession, termBody } from '../../_driver.mjs';

if (!process.env.BASE) process.exit(2);
const label = 'agentic-cli/new/node-namespace-launch-latency';
const a = makeAsserter(label);
const sid = await mintSession(), terminal = new Terminal(sid);
console.log(`${label} — ${process.env.BASE} SID=${sid}`);
const durations = [];
try {
  await terminal.connect(); await terminal.waitForPrompt(60_000);
  for (let n = -2; n < 20; n++) {
    const r = await terminal.run('node -e 1; echo NODE_LATENCY_RC=$?', 120_000);
    const out = termBody(r.output);
    a.check(`single launch ${n}`, /NODE_LATENCY_RC=0/.test(out) && !/the process was not started/.test(out), out.slice(-1000));
    if (n >= 0) durations.push(r.elapsed);
  }
  const sorted = [...durations].sort((x, y) => x - y);
  console.log('NODE_LATENCY ' + JSON.stringify({ samplesMs: durations, p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }));
  for (let n = 1; n <= 6; n++) {
    const r = await terminal.run('for i in $(seq 50); do echo NODE_NS_ITER=$i; node -e 1; done; echo NODE_BURST_RC=$?', 180_000);
    const out = termBody(r.output);
    let iteration = 0;
    const failed = [];
    for (const line of out.split('\n')) {
      const marker = /NODE_NS_ITER=(\d+)/.exec(line); if (marker) iteration = Number(marker[1]);
      if (/the process was not started/.test(line)) failed.push({ iteration, error: line });
    }
    console.log('NODE_BURST ' + JSON.stringify({ loop: n, wallMs: r.elapsed, failed }));
    a.check(`small loop50 #${n}`, /NODE_BURST_RC=0/.test(out) && failed.length === 0, out.slice(-1500));
  }
} finally {
  await terminal.close().catch(() => {});
  const cleanup = await deleteSession(sid); a.check('cleanup confirmed', cleanup.ok, String(cleanup.status));
}
process.exit(a.summary().fail > 0 ? 1 : 0);
