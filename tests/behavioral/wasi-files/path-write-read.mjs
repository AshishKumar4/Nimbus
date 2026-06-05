#!/usr/bin/env bun
// wasi-files/path-write-read — full WASI write+read+close cycle.
//
// Fixture (439 B): opens hello.txt with O_CREAT, writes "write+read OK\n",
// closes; reopens RDONLY, reads it back, closes; echoes the readback to
// stdout. filesystem WASI fns exercised: path_open (twice), fd_close (twice).
//
// Pass: stdout includes "write+read OK".

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi-files/path-write-read] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/w2 && cd /home/user/w2', 10_000);
await t.run(writeFixtureCmd('path-write-read', 'pwr.wasm'), 30_000);

const r = await t.run('wasm-runner pwr.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const ok = /write\+read OK/.test(tail);

await t.close();

console.log(JSON.stringify({ probe: 'wasi-files/path-write-read', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_open + fd_write + fd_close + path_open RDONLY + fd_read → "write+read OK"', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'passing' : 'failing';
console.log(`[wasi-files/path-write-read] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'passing' ? 0 : 1);
