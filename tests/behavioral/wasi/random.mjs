#!/usr/bin/env bun
// wasi/random — random_get fills a buffer; fixture writes (buf[0] % 10) + '\n'.
// Probe asserts a single ASCII digit + newline appears.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi/random] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wasi && cd /home/user/wasi', 10_000);
await t.run(writeFixtureCmd('random', 'random.wasm'), 30_000);

const r = await t.run('wasm-runner random.wasm _start', 30_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const digitOk = /^\s*[0-9]\s*$/m.test(tail);

await t.close();

const findings = { probe: 'wasi/random', sid, base: BASE, tail, digitOk };
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['random_get → single digit on stdout', digitOk],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/random] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
