#!/usr/bin/env bun
// wasi/fdstat-rights-no-widen — Stream-B B6 — rights can only narrow.
//
// Spec: POSIX capability model — rights are monotonically-decreasing
// once set. Attempting to widen via fd_fdstat_set_rights must return
// ENOTCAPABLE (errno 76). Our shim enforces this via a bitmask check:
//   (new_rb & ~cur_rb) !== 0n   → reject
//
// Fixture: opens "rw.dat", narrows to rb=7, ri=7, then attempts to
// widen to rb=~0, ri=~0. Expects errno 76 = ENOTCAPABLE. Prints
// '0' + (errno%10) + '\\n' = '6\\n'.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/fdstat-rights-no-widen] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('fdstat-rights-no-widen', 'fsr2.wasm'), 30_000);

const r = await t.run('wasm-runner fsr2.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
// ENOTCAPABLE = 76; last digit '6'.
const ok = lines.some(s => s === '6');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/fdstat-rights-no-widen', sid, base: BASE, tail, ok }, null, 2));

const checks = [['set_rights widen attempt → ENOTCAPABLE (errno 76)', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/fdstat-rights-no-widen] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
