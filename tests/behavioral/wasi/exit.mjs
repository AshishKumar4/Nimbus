#!/usr/bin/env bun
// wasi/exit — proc_exit(7) must surface as wasm-runner exit code 7, NOT 0
// and NOT a crash. The wasm-runner shell handler maps proc_exit's
// thrown sentinel into the supervisor's exit-code path; the shell
// echoes `$?` if we run it after.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi/exit] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wasi && cd /home/user/wasi', 10_000);
await t.run(writeFixtureCmd('exit7', 'exit7.wasm'), 30_000);

// Run, then read $? via the shell `echo $?` convention.
await t.run('wasm-runner exit7.wasm _start', 30_000);
const ec = await t.run('echo "rc=$?"', 10_000);
const ecOut = stripAnsi(ec.output);
const tail = ecOut.split(/\r?\n/).slice(-5).join('\n');
const codeOk = /\brc=7\b/.test(tail);

await t.close();

const findings = { probe: 'wasi/exit', sid, base: BASE, tail, codeOk };
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['proc_exit(7) → shell rc=7', codeOk],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/exit] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
