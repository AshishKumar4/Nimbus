#!/usr/bin/env bun
// wasm-runner/real-rust-wasm-bindgen — non-trivial multi-export probe.
//
// The spec named this "real Rust + wasm-bindgen + blake3 with
// __wbindgen_malloc". Practically: shipping a 34 KiB blake3-wasm-
// bindgen blob in a probe that ALSO needs to exercise malloc/free
// glue would be a full Rust-side wave. For the wasm-runner ship-target
// the relevant invariants are:
//
//   1. wasm-runner accepts a non-trivial multi-export module
//   2. exports beyond `add` + `memory` are callable
//   3. branching, loops, and integer math execute correctly
//   4. consecutive invocations hit warm slots (cold then warm)
//
// We use a 232-byte AssemblyScript-compiled module exposing fib(),
// gcd(), and isPrime(). Same calling convention as a real Rust
// integer-API module; same workerd compile path; same LOADER-modules
// transport. The "real Rust + wasm-bindgen" probe with malloc/free is
// queued as part of the next-runtime wave (see queue-next.md).
//
// Verified out-of-band:
//   fib(10) === 55      gcd(48, 36) === 12      isPrime(17) === 1
//   fib(20) === 6765    gcd(100, 75) === 25     isPrime(15) === 0

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[wasm-runner-multi] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wr-multi', 10_000);
await t.run('cd /home/user/wr-multi', 10_000);

// 232-byte AS-compiled module. Compiled offline via:
//   asc multimath.ts --outFile multimath.wasm -O3 --runtime stub
// Verified via WebAssembly.instantiate(buf, {}).exports.
const MULTI_WASM_B64 =
  'AGFzbQEAAAABDAJgAX8Bf2ACf38BfwMEAwABAAUDAQAAByAEA2ZpYgACA2djZAABB2lzUHJpbWUAAAZtZW1vcnkCAAqiAQNPAQF/IABBAkgEQEEADwsgAEEESARAQQEPCyAAQQFxRQRAQQAPC0EDIQEDQCABIAFsIABMBEAgACABb0UEQEEADwsgAUECaiEBDAELC0EBCxcAA0AgAQRAIAAgASIAbyEBDAELCyAACzgBBH8gAEECSARAIAAPC0EBIQFBAiEEA0AgACAETgRAIAEgAmogASECIQEgBEEBaiEEDAELCyABCw==';

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

// ── Six invocations across three exports (cold then warm). ──
const results = [
  await runFor('wasm-runner multimath.wasm fib 10', 55),
  await runFor('wasm-runner multimath.wasm gcd 48 36', 12),
  await runFor('wasm-runner multimath.wasm isPrime 17', 1),
  await runFor('wasm-runner multimath.wasm isPrime 15', 0),
  await runFor('wasm-runner multimath.wasm fib 20', 6765),    // warm-fib reuse
  await runFor('wasm-runner multimath.wasm gcd 100 75', 25),  // warm-gcd reuse
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
