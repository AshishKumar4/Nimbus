#!/usr/bin/env bun
// wasi/poll-clock-timeout — Stream-B B8 — poll_oneoff CLOCK subscription.
//
// Spec: WASI preview1 poll_oneoff with subscription tag EVENTTYPE_CLOCK=0,
// clock id=MONOTONIC=1, relative timeout. Should block until the
// deadline, then return nevents=1 with event.type=EVENTTYPE_CLOCK=0.
//
// Fixture: subscribes to CLOCK_MONOTONIC at ~100ms relative. Asserts
// stdout '1' (poll returned nev=1 AND event.type==0).
//
// Runtime-behavioral: pre-B8 poll_oneoff returned ENOSYS so any
// sleep/select/poll based program failed at the syscall boundary. This
// probe validates the JSPI-wrapped setTimeout deadline path works on prod.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/poll-clock-timeout] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('poll-clock-timeout', 'pc.wasm'), 30_000);

const r = await t.run('wasm-runner pc.wasm', 30_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/poll-clock-timeout', sid, base: BASE, tail, ok }, null, 2));

const checks = [['poll_oneoff(CLOCK MONOTONIC +100ms) → nev=1, type=CLOCK', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/poll-clock-timeout] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
