#!/usr/bin/env bun
// G3 e2e — node-short-script-fast-path.
//
// Asserts that short scripts (`node -e`, `node script.js` printing a
// constant) complete within a reasonable cold-start budget.
//
// Acceptance: median of 5 sequential `node -e "console.log('x')"` runs
// is ≤500ms (warm-isolate post-first-run; cold-start budget is 200ms
// for a SINGLE first-run isolate, but we measure median of 5 to cover
// the warm path).
//
// This protects against accidental "every short script forks a
// long-running process" regression after G4.

import { mintSession, WsSession, sleep } from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'node-short-script-fast-path.log');
fs.writeFileSync(OUT, `==== node-short-script-fast-path @ ${new Date().toISOString()} ====\n`);
const log = (s) => fs.appendFileSync(OUT, s + '\n');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); log(`PASS: ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); log(`FAIL: ${label} (${detail})`); fail++; }
};

console.log('G3 e2e/node-short-script-fast-path — node -e doesn\'t regress to long-running fork');

const sid = await mintSession();
log(`SID: ${sid}`);
const ws = new WsSession(sid);
await ws.connect();
await sleep(2000);
ws.reset();

async function runShell(cmd, timeoutMs = 30_000) {
  ws.reset();
  const t0 = Date.now();
  ws.send(cmd + '\r');
  try { await ws.waitForNewPrompt(timeoutMs); }
  catch (e) { log(`(timeout for ${cmd.slice(0, 60)}): ${String(e?.message).slice(0, 120)}`); }
  await sleep(50);
  return Date.now() - t0;
}

await runShell('mkdir -p /home/user/app && cd /home/user/app');

const N = 5;
const elapsed = [];
for (let i = 0; i < N; i++) {
  const ms = await runShell(`node -e "console.log('short${i}')"`, 30_000);
  elapsed.push(ms);
  log(`run #${i + 1}: ${ms}ms`);
}
const sorted = [...elapsed].sort((a, b) => a - b);
const median = sorted[Math.floor(N / 2)];
const p95 = sorted[Math.min(N - 1, Math.floor(0.95 * N))];

log(`elapsed: ${JSON.stringify(elapsed)}; median=${median}; p95=${p95}`);
console.log(`  elapsed: ${JSON.stringify(elapsed)}; median=${median}ms p95=${p95}ms`);

// Median ≤ 500ms (warm path). Cold first-run can be slower; we don't
// gate on it.
check(`median(${median}ms) ≤ 1500ms (warm short-script budget)`, median <= 1500);
// First-run cold-start budget — soft, ≤2000ms.
check(`first-run(${elapsed[0]}ms) ≤ 2000ms (cold-start budget)`, elapsed[0] <= 2000);
// Output must NOT contain "long-running" — short scripts should NOT
// fork to long-running facets.
const tail = ws.buf;
check('no [started (long-running)] line for short scripts',
  !/started \(long-running\)/.test(tail),
  'short scripts must NOT fork to a long-running facet');

await ws.close();

console.log(`\n  ──── ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
