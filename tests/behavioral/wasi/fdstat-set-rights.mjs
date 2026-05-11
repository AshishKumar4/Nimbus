#!/usr/bin/env bun
// wasi/fdstat-set-rights — Stream-B B6 — capability tightening round-trip.
//
// Spec: WASI preview1 fd_fdstat_set_rights(fd, rights_base,
// rights_inheriting). Narrows the per-fd rights mask. fd_fdstat_get
// reads the active mask back at statbuf+8 (rights_base) and +16
// (rights_inheriting).
//
// Fixture: opens "r.dat", narrows to rb=7, ri=3, reads back via
// fd_fdstat_get, prints '1' if BOTH match exactly. Pre-B6 the shim
// returned a hardcoded 0x3FFFFFFF mask regardless of narrowing → '0'.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/fdstat-set-rights] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('fdstat-set-rights', 'fsr.wasm'), 30_000);

const r = await t.run('wasm-runner fsr.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/fdstat-set-rights', sid, base: BASE, tail, ok }, null, 2));

const checks = [['set_rights(7,3) round-trips through fdstat_get', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/fdstat-set-rights] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
