#!/usr/bin/env bun
// wasm-runner/hand-crafted-add — minimum-viable wasm-runner probe.
//
// Tests the new `wasm-runner` shell command end-to-end with a 70-byte
// hand-crafted AssemblyScript-compiled add(a,b) → a+b module:
//
//   $ wasm-runner add.wasm 3 4
//   7
//
// Assertions:
//   1. wasm-runner --version              → semver string, exit 0
//   2. wasm-runner add.wasm add 3 4       → stdout contains "7"
//   3. exit code 0 on success
//   4. ps shows a wasm-runner row for the invocation
//   5. logs <pid> captured the "7" output (Process tab integration)
//   6. wasm-runner ./missing.wasm add 1 2 → diagnostic, exit non-zero
//   7. wasm-runner add.wasm missing-fn 1 2 → diagnostic mentions missing export
//
// Fixture verification: the b64-encoded bytes below were verified out
// of band — `WebAssembly.instantiate(buf, {}).exports.add(3, 4) === 7`
// (run inside Node, not workerd, where instantiate(bytes) is allowed).
// 70 bytes including the `name` custom section.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[wasm-runner] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wr-add', 10_000);
await t.run('cd /home/user/wr-add', 10_000);

// 70-byte AssemblyScript-compiled add(i32,i32) → i32. Hand-typed once,
// verified via WebAssembly.instantiate(buf).exports.add(3, 4) === 7.
const ADD_WASM_B64 =
  'AGFzbQEAAAABBwFgAn9/AX8DAgEABQMBAAAHEAIDYWRkAAAGbWVtb3J5AgAKCQEHACAAIAFqCwANBG5hbWUBBgEAA2FkZA==';

await t.run(
  `node -e "require('fs').writeFileSync('add.wasm', Buffer.from('${ADD_WASM_B64}','base64'))"`,
  30_000,
);

// Verify the file lives in VFS (ls is supervisor-visible; statSync
// inside facets returns 0 for fresh writes — see the multi-runtime
// wave's notes on facet-vs-supervisor VFS split).
const lsResult = await t.run('ls add.wasm', 5_000);
const fixtureOk = /\badd\.wasm\b/.test(stripAnsi(lsResult.output));

// ── A: --version smoke ──
const versionResult = await t.run('wasm-runner --version', 15_000);
const versionOut = stripAnsi(versionResult.output);
const versionOk = /\b\d+\.\d+\.\d+\b/.test(versionOut.split(/\r?\n/).slice(-3).join('\n'));

// ── B: add(3, 4) → 7 ──
const addResult = await t.run('wasm-runner add.wasm add 3 4', 60_000);
const addOut = stripAnsi(addResult.output);
// The literal "7" must appear AFTER the user's command echo (last 4 lines).
const tail = addOut.split(/\r?\n/).slice(-6).join('\n');
const addOk = /^\s*7\s*$/m.test(tail) && !/\berror\b/i.test(tail.toLowerCase());

// ── C: ps shows wasm-runner row ──
const psResult = await t.run('ps', 10_000);
const psOut = stripAnsi(psResult.output);
const psRows = psOut.split(/\r?\n/).filter((l) => /^\s+\d+\s+/.test(l));
const psHasWasmRow = psRows.some((l) => /wasm-runner|add\.wasm/.test(l));

// ── D: logs <pid> captured the stdout ──
let logsOk = false;
let logsHead = '';
const wasmRows = psRows.filter((l) => /wasm-runner|add\.wasm/.test(l));
if (wasmRows.length > 0) {
  const pidMatch = wasmRows[wasmRows.length - 1].match(/^\s+(\d+)\s+/);
  if (pidMatch) {
    const logsResult = await t.run(`logs ${pidMatch[1]}`, 10_000);
    logsHead = stripAnsi(logsResult.output);
    logsOk = /\b7\b/.test(logsHead);
  }
}

// ── E: missing file diagnostic ──
const missingResult = await t.run('wasm-runner nope.wasm add 1 2', 30_000);
const missingOut = stripAnsi(missingResult.output);
const missingOk = /no such file|cannot find|cannot read|ENOENT/i.test(missingOut);

// ── F: missing export diagnostic ──
const missingFnResult = await t.run('wasm-runner add.wasm subtract 5 1', 30_000);
const missingFnOut = stripAnsi(missingFnResult.output);
const missingFnOk = /export|not exported|not found|no function/i.test(missingFnOut);

await t.close();

const findings = {
  runtime: 'wasm-runner',
  sid,
  base: BASE,
  fixtureOk,
  versionOk,
  versionTail: versionOut.slice(-200),
  addOk,
  addTail: tail,
  psHasWasmRow,
  psHead: psOut.slice(-400),
  logsOk,
  logsHead: logsHead.slice(-200),
  missingOk,
  missingHead: missingOut.slice(-300),
  missingFnOk,
  missingFnHead: missingFnOut.slice(-300),
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['fixture .wasm materialised in VFS',                  fixtureOk],
  ['wasm-runner --version → semver',                     versionOk],
  ['wasm-runner add.wasm add 3 4 → 7',                   addOk],
  ['ps shows wasm-runner row',                           psHasWasmRow],
  ['logs <pid> captured stdout containing 7',            logsOk],
  ['missing .wasm → diagnostic',                         missingOk],
  ['missing export → diagnostic',                        missingFnOk],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasm-runner] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
