#!/usr/bin/env bun
// wasi/poll-file-ready — Stream-B B8 — FD_READ on regular file is always-ready.
//
// Spec: WASI preview1 poll_oneoff with subscription tag EVENTTYPE_FD_READ=1
// on a regular file fd. POSIX: regular files never block on read; the
// event must fire immediately with type=FD_READ.
//
// Fixture: creates "p.dat", subscribes to FD_READ on its fd, asserts
// poll returns nev=1 AND event.type==1.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/poll-file-ready] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('poll-file-ready', 'pf.wasm'), 30_000);

const r = await t.run('wasm-runner pf.wasm', 30_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/poll-file-ready', sid, base: BASE, tail, ok }, null, 2));

const checks = [['poll_oneoff(FD_READ on regular file) → nev=1, type=FD_READ', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/poll-file-ready] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
