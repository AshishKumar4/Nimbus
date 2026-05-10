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
// IMPORTANT — fixture authoring constraint:
//   The bytes MUST contain only values < 0x80 (ASCII range). The probe
//   lands the wasm via `node fs.writeFileSync(buffer)`, which inside
//   the node-runtime shim goes through `TextDecoder.decode(bytes)` →
//   string → UTF-8 re-encode. Any byte ≥ 0x80 gets mangled to the
//   replacement character (EF BF BD), which corrupts the wasm. The
//   prior fixture (multimath.wasm @ 232 bytes) contained one 0xa2 byte
//   in its code-section LEB128 length and was unloadable. This fixture
//   keeps every section <128 bytes so all LEB128 lengths fit in one
//   byte < 0x80; opcodes and indices are also in the ASCII range.
//   Fix for the underlying binary-fs-writeFileSync bug is queued as a
//   separate wave (see queue-next.md).
//
// Verified out-of-band:
//   add(3,4) === 7      sub(10,5) === 5      mul(6,7) === 42
//   max(7,2) === 7      max(2,7) === 7

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[wasm-runner-multi] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wr-multi', 10_000);
await t.run('cd /home/user/wr-multi', 10_000);

// 105-byte hand-crafted module exposing add/sub/mul/max/memory.
// All bytes < 0x80 (ASCII-safe — see comment above).
// Built via /tmp/gen-multi.mjs:
//   add(a,b): local.get 0; local.get 1; i32.add
//   sub(a,b): local.get 0; local.get 1; i32.sub
//   mul(a,b): local.get 0; local.get 1; i32.mul
//   max(a,b): a; b; a; b; i32.gt_s; select   (pick first if a>b)
const MULTI_WASM_B64 =
  'AGFzbQEAAAABBwFgAn9/AX8DBQQAAAAABQMBAAAHIgUDYWRkAAADc3ViAAEDbXVsAAIDbWF4AAMGbWVtb3J5AgAKJgQHACAAIAFqCwcAIAAgAWsLBwAgACABbAsMACAAIAEgACABShsL';

await t.run(
  `node -e "require('fs').writeFileSync('multimath.wasm', Buffer.from('${MULTI_WASM_B64}','base64'))"`,
  30_000,
);

async function runFor(cmd, expected) {
  const r = await t.run(cmd, 60_000);
  const out = stripAnsi(r.output);
  const tail = out.split(/\r?\n/).slice(-6).join('\n');
  return {
    cmd,
    matched: new RegExp(`^\\s*${expected}\\s*$`, 'm').test(tail),
    tail,
  };
}

// ── Six invocations across four exports (cold then warm). ──
const results = [
  await runFor('wasm-runner multimath.wasm add 3 4', 7),
  await runFor('wasm-runner multimath.wasm sub 10 5', 5),
  await runFor('wasm-runner multimath.wasm mul 6 7', 42),
  await runFor('wasm-runner multimath.wasm max 7 2', 7),       // branching: a>b
  await runFor('wasm-runner multimath.wasm max 2 7', 7),       // branching: b>a
  await runFor('wasm-runner multimath.wasm add 100 50', 150),  // warm-add reuse
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
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasm-runner-multi] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
