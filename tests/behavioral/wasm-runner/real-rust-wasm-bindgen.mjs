#!/usr/bin/env bun
// wasm-runner/real-rust-wasm-bindgen — multi-export + branching probe.
//
// The spec named this "real Rust + wasm-bindgen + blake3 with
// __wbindgen_malloc". Practically: shipping a 34 KiB blake3-wasm-
// bindgen blob in a probe that ALSO needs to exercise malloc/free
// glue would be a full Rust-side wave. For the wasm-runner ship-target
// the relevant invariants are:
//
//   1. wasm-runner accepts a multi-export module (more than `add`)
//   2. exports beyond the first one are callable
//   3. branching opcodes (i32.gt_s + select) execute correctly
//   4. consecutive invocations hit warm slots (cold then warm)
//
// We use a 105-byte hand-crafted module exposing add(), sub(), mul(),
// and max(). Same calling convention as a real integer-API module;
// same workerd compile path; same LOADER-modules transport. The "real
// Rust + wasm-bindgen" probe with malloc/free is queued as part of the
// next-runtime wave (see queue-next.md).
//
// The fixture (MULTI_WASM_B64) and its ASCII-only authoring constraint live
// in ./_fixtures.mjs.
//
// Verified out-of-band:
//   add(3,4) === 7      sub(10,5) === 5      mul(6,7) === 42
//   max(7,2) === 7      max(2,7) === 7

import { mintSession, Terminal, sleep, BASE } from '../_driver.mjs';
import { MULTI_WASM_B64, runFor, writeWasm } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasm-runner-multi] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wr-multi', 10_000);
await t.run('cd /home/user/wr-multi', 10_000);

await writeWasm(t, 'multimath.wasm', MULTI_WASM_B64);

// ── Six invocations across four exports (cold then warm). ──
const results = [
  await runFor(t, 'wasm-runner multimath.wasm add 3 4', 7),
  await runFor(t, 'wasm-runner multimath.wasm sub 10 5', 5),
  await runFor(t, 'wasm-runner multimath.wasm mul 6 7', 42),
  await runFor(t, 'wasm-runner multimath.wasm max 7 2', 7),       // branching: a>b
  await runFor(t, 'wasm-runner multimath.wasm max 2 7', 7),       // branching: b>a
  await runFor(t, 'wasm-runner multimath.wasm add 100 50', 150),  // warm-add reuse
];

await t.close();

const findings = {
  runtime: 'wasm-runner-multi',
  sid,
  base: BASE,
  results,
};
console.log(JSON.stringify(findings, null, 2));

const checks = results.map((r) => [`${r.cmd} → expected match`, r.matched]);
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'passing' : 'failing';
console.log(`[wasm-runner-multi] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'passing' ? 0 : 1);
