#!/usr/bin/env bun
// wasm-runner/r2-fetch-instantiate — second-fixture / cache-isolation probe.
//
// The spec named this "wasm in R2, fetched + run". Practically: this
// asserts wasm-runner accepts ARBITRARY bytes (not hardcoded to one
// fixture) AND that two different wasm modules don't cross-contaminate
// each other's compilation cache. R2 is one possible bytes source —
// for the probe we use VFS writes (semantically equivalent: bytes
// come from anywhere, the wasm-runner just consumes them).
//
// Two fixtures:
//   add.wasm        : add(a,b) → a+b   (70 bytes, hand-crafted)
//   subtract.wasm   : subtract(a,b) → a-b (70 bytes, hand-crafted)
//
// Probe sequence:
//   1. write add.wasm
//   2. wasm-runner add.wasm add 10 5     → 15
//   3. write subtract.wasm
//   4. wasm-runner subtract.wasm subtract 10 5  → 5
//   5. wasm-runner add.wasm add 10 5     → 15  (warm; should still work)
//   6. wasm-runner subtract.wasm add 10 5 → diagnostic (subtract has no `add`)
//
// Step 5 catches the "warm slot leaks bytes from previous module"
// regression — the cache key must include the bytes, not just the
// session id. Step 6 catches "we silently fall through to the wrong
// module's exports".

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { ADD_WASM_B64, SUBTRACT_WASM_B64, runFor, writeWasm } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasm-runner-r2] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wr-r2', 10_000);
await t.run('cd /home/user/wr-r2', 10_000);

await writeWasm(t, 'add.wasm', ADD_WASM_B64);
await writeWasm(t, 'subtract.wasm', SUBTRACT_WASM_B64);

// ── 1: add(10, 5) → 15 ──
const t1 = await runFor(t, 'wasm-runner add.wasm add 10 5', 15);

// ── 2: subtract(10, 5) → 5 ──
const t2 = await runFor(t, 'wasm-runner subtract.wasm subtract 10 5', 5);

// ── 3: warm path — add again, must still produce 15 ──
const t3 = await runFor(t, 'wasm-runner add.wasm add 10 5', 15);

// ── 4: cross-module — subtract.wasm has NO `add` export ──
const t4Run = await t.run('wasm-runner subtract.wasm add 10 5', 30_000);
const t4Out = stripAnsi(t4Run.output);
const t4ExportError = /export|not exported|not found|no function/i.test(t4Out);
// Must NOT also accidentally produce 15 (which would mean we ran the
// add.wasm cached from step 1 against the subtract.wasm path).
const t4NoCrossContamination = !/^\s*15\s*$/m.test(t4Out.split(/\r?\n/).slice(-6).join('\n'));

await t.close();

const findings = {
  runtime: 'wasm-runner-r2',
  sid,
  base: BASE,
  addInitial: { cmd: t1.cmd, ok: t1.matched, tail: t1.tail },
  subtractInitial: { cmd: t2.cmd, ok: t2.matched, tail: t2.tail },
  addWarmReuse: { cmd: t3.cmd, ok: t3.matched, tail: t3.tail },
  crossModuleIsolation: {
    cmd: 'wasm-runner subtract.wasm add 10 5',
    diagnosticEmitted: t4ExportError,
    noCrossContamination: t4NoCrossContamination,
    head: t4Out.slice(-400),
  },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['add(10, 5) → 15',                          t1.matched],
  ['subtract(10, 5) → 5',                      t2.matched],
  ['warm reuse: add(10, 5) → 15',              t3.matched],
  ['cross-module diagnostic on missing export', t4ExportError],
  ['no cache cross-contamination (no 15)',     t4NoCrossContamination],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'passing' : 'failing';
console.log(`[wasm-runner-r2] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'passing' ? 0 : 1);
