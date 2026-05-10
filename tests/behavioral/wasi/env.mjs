#!/usr/bin/env bun
// wasi/env — environ_sizes_get plumbing. Fixture writes the single byte
// ('0' + envc) + '\n'. Nimbus's session env grows over time as primitive
// waves add keys (PATH/HOME/USER/PWD/NIMBUS_SESSION_ID/PORT/HOST/...).
// envc=20 manifests as 'D' (= '0' + 20). The fixture is single-byte, so
// any printable ASCII byte > '0' indicates a non-zero envc — that's what
// we assert. The '0' character would mean envc=0 which is the only fail
// state we care about for this probe.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi/env] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wasi && cd /home/user/wasi', 10_000);
await t.run(writeFixtureCmd('env', 'env.wasm'), 30_000);

const result = await t.run('wasm-runner env.wasm _start', 30_000);
const out = stripAnsi(result.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
// envc > 0 → fixture writes '0' + envc as one byte. We accept any
// printable ASCII byte that isn't '0' or '\n' itself; the '0' fail
// state corresponds to envc=0 which would mean environ_sizes_get is
// broken. Anything else (digit, letter, or punctuation) is fine.
//
// Nimbus's actual env (post primitives + heap waves) is ~20 keys → 'D'.
const envcOk = /^[!-~]$/m.test(
  tail.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0).at(-1) || '',
);
const notZeroEnvc = !/^\s*0\s*$/m.test(tail);

await t.close();

const findings = { probe: 'wasi/env', sid, base: BASE, tail, envcOk, notZeroEnvc };
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['environ_sizes_get returned and last line is one printable byte', envcOk],
  ['envc != 0 (environ_sizes_get really populated something)',       notZeroEnvc],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/env] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
