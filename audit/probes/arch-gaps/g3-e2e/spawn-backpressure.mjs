#!/usr/bin/env bun
// G3 e2e — spawn-backpressure.
//
// Asserts that a burst of N concurrent cp.spawn calls completes
// without errors. Pre-G4: the supervisor handles each spawn
// in-context (sequential, no fan-out) — works but no isolation.
// Post-G4: NimbusFanoutPool routes the burst (1-4 in-DO via POC C,
// ≥5 to peer-DO via POC B with stable-id router); each spawn runs
// in a fresh isolate.
//
// Acceptance: 8 concurrent spawns, all complete with exit code 0,
// total wall-time under 30s. The probe checks completion shape;
// G3-isolation is asserted by the spawn-isolation probe.

import { mintSession, WsSession, sleep } from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'spawn-backpressure.log');
fs.writeFileSync(OUT, `==== spawn-backpressure @ ${new Date().toISOString()} ====\n`);
const log = (s) => fs.appendFileSync(OUT, s + '\n');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); log(`PASS: ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); log(`FAIL: ${label} (${detail})`); fail++; }
};

console.log('G3 e2e/spawn-backpressure — 8 concurrent spawns complete cleanly');

const sid = await mintSession();
log(`SID: ${sid}`);
const ws = new WsSession(sid);
await ws.connect();
await sleep(2000);
ws.reset();

async function runShell(cmd, timeoutMs = 60_000) {
  ws.reset();
  ws.send(cmd + '\r');
  try { await ws.waitForNewPrompt(timeoutMs); }
  catch (e) { log(`(timeout for ${cmd.slice(0, 60)}): ${String(e?.message).slice(0, 200)}`); }
  await sleep(150);
  return ws.buf;
}

await runShell('mkdir -p /home/user/app && cd /home/user/app');

const driverJs = `
const cp = require('child_process');
const N = 8;
let completed = 0;
let errors = 0;
let exits = [];
for (let i = 0; i < N; i++) {
  // Use 'node' since echo isn't a registered shell builtin; node IS
  // a registered command that goes through facet-direct.
  const c = cp.spawn('node', ['-e', 'console.log("burst-' + i + '")']);
  c.stdout.on('data', () => {});
  c.stderr.on('data', () => {});
  c.on('close', (code) => {
    exits.push(code);
    if (code !== 0) errors++;
    completed++;
    if (completed === N) {
      console.log('BURST_COMPLETE n=' + N + ' errors=' + errors + ' exits=' + JSON.stringify(exits));
      process.exit(0);
    }
  });
  c.on('error', () => { errors++; completed++; });
}
setTimeout(() => {
  console.log('BURST_PARTIAL completed=' + completed + ' errors=' + errors);
  process.exit(1);
}, 25000);
`.trim();
const driverB64 = Buffer.from(driverJs, 'utf8').toString('base64');
await runShell(`node -e "require('fs').writeFileSync('/home/user/app/burst.js', Buffer.from('${driverB64}','base64').toString('utf8'))"`);

const t0 = Date.now();
const out = await runShell(`node /home/user/app/burst.js`, 60_000);
const elapsed = Date.now() - t0;
log(`---- burst output (last 1500 chars) ----\n${out.slice(-1500)}\n----`);
log(`burst elapsed ${elapsed}ms`);

const m = out.match(/BURST_COMPLETE n=(\d+) errors=(\d+) exits=(\[[^\]]*\])/);
check('all 8 spawns reported close', !!m, `output: ${out.slice(-300)}`);
if (m) {
  const n = Number(m[1]);
  const errors = Number(m[2]);
  const exits = JSON.parse(m[3]);
  check(`n=8`, n === 8);
  check(`errors=0`, errors === 0);
  check(`all exits = 0`, exits.every((c) => c === 0), `exits=${JSON.stringify(exits)}`);
}
check('burst completed within 30s', elapsed < 30_000, `elapsed=${elapsed}ms`);

await ws.close();
console.log(`\n  ──── ${pass} pass / ${fail} fail (elapsed ${elapsed}ms)`);
process.exit(fail === 0 ? 0 : 1);
