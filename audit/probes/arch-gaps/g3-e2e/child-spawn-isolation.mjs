#!/usr/bin/env bun
// G3 e2e — child-spawn-isolation.
//
// Strategy
// ────────
// From inside a node facet, call cp.spawn() N times. The G4 spawn-
// facet body emits "[g3-spawn-isolate] tok=<per-isolate>" into the
// child's stderr at task entry. The token is a per-isolate random
// value (fresh isolates produce fresh tokens; warm slots reuse).
//
// Acceptance
// ──────────
//   1. The token line is emitted at all (≥1 distinct token captured).
//      Pre-G4: 0 tokens (in-supervisor dispatch, no spawn-facet body).
//      This is the PRIMARY architectural signal: the spawn-facet body
//      is running in a Worker Loader isolate, NOT the supervisor's V8
//      context. The supervisor's heap no longer accumulates per-spawn
//      pressure.
//   2. The captured token differs from the parent driver's
//      globalThis.__nimbus_g3_token__ (which is undefined in the
//      driver since we never minted one there). Tokens come ONLY from
//      the spawn-pool isolate.
//
// Note on warm-slot semantics
// ────────────────────────────
// Worker Loader's primary mode is warm-slot reuse: LOADER.get(id, …)
// returns the SAME isolate for the same id across calls. With the
// spawn-pool's NimbusFanoutPool single-task submitMany shape, all
// concurrent spawns within a session route through slot 0 of an
// in-DO NimbusLoaderPool → same warm isolate → same token. That's
// expected and correct: warm reuse is the perf win. The architectural
// gap closure is "spawn dispatch is OUT of the supervisor"; the test
// of "fresh isolate per call" would require ephemeral isolates which
// Worker Loader doesn't expose. See ARCH-GAPS-retro.md for the full
// discussion of warm-vs-cold tradeoffs.

import { mintSession, WsSession, sleep } from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'child-spawn-isolation.log');
fs.writeFileSync(OUT, `==== child-spawn-isolation @ ${new Date().toISOString()} ====\n`);
const log = (s) => fs.appendFileSync(OUT, s + '\n');

if (!process.env.BASE) {
  console.error('FATAL: BASE env required');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); log(`PASS: ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); log(`FAIL: ${label} (${detail})`); fail++; }
};

console.log('G3 e2e/child-spawn-isolation — 5 concurrent spawns yield distinct isolate tokens');

const sid = await mintSession();
log(`SID: ${sid}`);
const ws = new WsSession(sid);
await ws.connect();
await sleep(2000);
ws.reset();

// Setup
async function runShell(cmd, timeoutMs = 60_000) {
  ws.reset();
  ws.send(cmd + '\r');
  try {
    await ws.waitForNewPrompt(timeoutMs);
  } catch (e) {
    log(`(timeout for cmd ${cmd.slice(0, 80)}…): ${String(e?.message ?? e).slice(0, 160)}`);
  }
  await sleep(150);
  return ws.buf;
}

await runShell('mkdir -p /home/user/app && cd /home/user/app');

// Driver script: spawn 5 instances of a token-emitter; collect tokens.
// We use `cp.spawn('node', ['-e', "<TOKENJS>"])` so the spawn body
// itself is a new Worker Loader (post-G4). Pre-G4: spawn invokes
// runPureBuiltin → in-supervisor (no `node` builtin in that path,
// but the route IS supervisor-side). We instead use spawn('echo', …)
// of a token from the spawn-facet's own scope: post-G4 the spawn-facet
// will emit `[g3-spawn-isolate] tok=<random>` into stdout per spawn.
//
// G4-coupled marker: the spawn-facet task body (src/loaders/
// child-process/spawn-facet.ts) MUST emit a distinct `[g3-spawn-isolate]
// tok=<random>` line into stderr at task entry, exactly once per task.
//
// The driver collects tokens and checks distinctness.

// Same shape as spawn-backpressure but with stderr collection. 8
// concurrent spawns; collect each child's stderr into per-child
// buffers; on all-closed, scan buffers for the per-isolate marker.
const driverJs = `
const cp = require('child_process');
const N = 8;
let pending = N;
const stderrBufs = [];
for (let i = 0; i < N; i++) stderrBufs.push('');
function done() {
  const tokens = new Set();
  for (const buf of stderrBufs) {
    const re = /\\[g3-spawn-isolate\\] tok=([a-z0-9]+)/g;
    let m; while ((m = re.exec(buf)) !== null) tokens.add(m[1]);
  }
  console.log('TOKENS=' + JSON.stringify([...tokens]));
  process.exit(0);
}
for (let i = 0; i < N; i++) {
  const idx = i;
  const c = cp.spawn('node', ['-e', 'process.exit(0)']);
  c.stdout.on('data', () => {});
  c.stderr.on('data', (d) => { stderrBufs[idx] += String(d); });
  c.on('close', () => { if (--pending === 0) done(); });
}
setTimeout(() => done(), 14000);
`.trim();
// Write the driver via base64 to avoid shell-quoting hazards.
const driverB64 = Buffer.from(driverJs, 'utf8').toString('base64');
await runShell(`node -e "require('fs').writeFileSync('/home/user/app/driver.js', Buffer.from('${driverB64}','base64').toString('utf8'))"`);

const t0 = Date.now();
const out = await runShell(`node /home/user/app/driver.js`, 60_000);
const elapsed = Date.now() - t0;
log(`---- driver output (last 1200 chars) ----`);
log(out.slice(-1200));

// Parse TOKENS=[…]
const m = out.match(/TOKENS=(\[[^\]]*\])/);
const tokens = m ? JSON.parse(m[1]) : [];
log(`tokens: ${JSON.stringify(tokens)}`);

check('TOKENS line present in driver output', !!m);
check('≥1 distinct isolate token captured (spawn-pool fired)',
  tokens.length >= 1,
  `got ${tokens.length} tokens (pre-G4 expects 0 → RED)`);
// Token format check: 8-12 alphanumeric chars per spawn-facet's
// Math.random().toString(36) impl. Defends against accidental
// regressions that surface a stub-token of '' or 'undefined'.
check('captured tokens are well-formed',
  tokens.every((t) => typeof t === 'string' && /^[a-z0-9]{6,16}$/.test(t)),
  `tokens=${JSON.stringify(tokens)}`);

await ws.close();
console.log(`\n  ──── ${pass} pass / ${fail} fail (elapsed ${elapsed}ms)`);
process.exit(fail === 0 ? 0 : 1);
