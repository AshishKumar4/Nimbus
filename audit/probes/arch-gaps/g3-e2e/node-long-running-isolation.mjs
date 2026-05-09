#!/usr/bin/env bun
// G3 e2e — node-long-running-isolation.
//
// Asserts:
//   1. A node script that imports http and calls .listen() is detected
//      as long-running and fork-to-loader: the shell prompt returns
//      WITHIN 2 SECONDS with a "[started (long-running): pid=N]" line.
//      Pre-G4: the shell blocks for the full facet timeout (5 min).
//   2. After fork, the supervisor's heap stays bounded (no monotonic
//      growth across 5 sequential long-running spawns).
//   3. The forked process appears in /api/processes with
//      `longRunning=true`.
//
// Phase 1 acceptance: items 1 and 3. Item 2 is a soft observation.

import { mintSession, WsSession, sleep } from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'node-long-running-isolation.log');
fs.writeFileSync(OUT, `==== node-long-running-isolation @ ${new Date().toISOString()} ====\n`);
const log = (s) => fs.appendFileSync(OUT, s + '\n');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); log(`PASS: ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); log(`FAIL: ${label} (${detail})`); fail++; }
};

console.log('G3 e2e/node-long-running-isolation — http.listen forks to loader, shell returns fast');

const sid = await mintSession();
log(`SID: ${sid}`);
const ws = new WsSession(sid);
await ws.connect();
await sleep(2000);
ws.reset();

async function runShell(cmd, timeoutMs = 30_000) {
  ws.reset();
  ws.send(cmd + '\r');
  try { await ws.waitForNewPrompt(timeoutMs); }
  catch (e) { log(`(timeout for ${cmd.slice(0, 60)}): ${String(e?.message).slice(0, 160)}`); }
  await sleep(100);
  return ws.buf;
}

await runShell('mkdir -p /home/user/app && cd /home/user/app');

// Setup: a real http.listen server.
const serverJs = `
const http = require('http');
const srv = http.createServer((req, res) => res.end('hi'));
srv.listen(0, () => { console.log('[server] listening'); });
// Hold for >=10s. The fork-to-loader path means the shell node
// command should return within ~1-2s with [started (long-running)].
setTimeout(() => { srv.close(); process.exit(0); }, 12000);
`.trim();
const serverB64 = Buffer.from(serverJs, 'utf8').toString('base64');
await runShell(`node -e "require('fs').writeFileSync('/home/user/app/server.js', Buffer.from('${serverB64}','base64').toString('utf8'))"`);

// Drive — record wall-clock from send-to-prompt-return.
ws.reset();
const t0 = Date.now();
ws.send('node /home/user/app/server.js\r');
let returnedFast = false;
try {
  await ws.waitForNewPrompt(3000);  // expect prompt within 3s if forked
  returnedFast = true;
} catch {
  // didn't return within 3s
}
const promptElapsed = Date.now() - t0;
const tail = ws.buf;
log(`---- node command tail ----\n${tail.slice(-1200)}\n----`);

check('shell returned within 3s (fork-to-loader)', returnedFast,
  `prompt elapsed ${promptElapsed}ms (pre-G4 expects ≥5min OR script-completion)`);
check('output contains [started (long-running)] marker',
  /started \(long-running\)/.test(tail),
  'expected the long-running fork notification line');

// Item 3: check /api/processes shape.
const procsResp = await fetch(`${BASE}/s/${sid}/api/processes`).catch(() => null);
const procs = procsResp && procsResp.ok ? await procsResp.json() : null;
log(`procs: ${JSON.stringify(procs?.processes ?? [], null, 2)}`);
const longRunning = procs?.processes?.find((p) => p.longRunning === true);
check('a process has longRunning=true', !!longRunning,
  `procs=${JSON.stringify(procs?.processes?.map((p) => ({pid: p.pid, longRunning: p.longRunning})))}`);

// Cleanup — let the script's setTimeout exit. We don't kill from outside.
await sleep(500);
await ws.close();

console.log(`\n  ──── ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
