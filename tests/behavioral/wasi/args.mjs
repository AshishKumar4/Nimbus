#!/usr/bin/env bun
// wasi/args — args_sizes_get + args_get plumbing. Fixture writes
// ('0' + argc) + '\n' to fd 1. The first WASI arg is conventionally
// the program name; wasm-runner is responsible for setting argv up so
// the program sees its own filename as argv[0]. We don't pass extra
// args here, so argc should be 1 → output "1\n".

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi/args] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wasi && cd /home/user/wasi', 10_000);
await t.run(writeFixtureCmd('args', 'args.wasm'), 30_000);

const result = await t.run('wasm-runner args.wasm _start', 30_000);
const out = stripAnsi(result.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const argcOk = /^\s*1\s*$/m.test(tail);

await t.close();

const findings = { probe: 'wasi/args', sid, base: BASE, tail, argcOk };
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['argc (no extra args) → "1"', argcOk],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/args] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
