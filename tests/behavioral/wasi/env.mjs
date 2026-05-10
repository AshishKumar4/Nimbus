#!/usr/bin/env bun
// wasi/env — environ_sizes_get plumbing. Fixture writes ('0' + envc) + '\n'.
// Nimbus's process.env (HOME/USER/PATH/etc.) gives at least one entry, so
// envc will be ≥ 1 and ≤ 9 (single-digit assumption is fine for the
// platform defaults; if Nimbus's env grows past 9, this needs adjustment).

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
// At least one digit + newline. If Nimbus ships more than 9 env entries
// the fixture's single-byte print would overflow — flag for the next wave.
const envcOk = /^\s*[1-9]\s*$/m.test(tail);

await t.close();

const findings = { probe: 'wasi/env', sid, base: BASE, tail, envcOk };
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['envc is a non-zero single digit', envcOk],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/env] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
