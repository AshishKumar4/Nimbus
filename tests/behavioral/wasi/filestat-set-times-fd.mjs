#!/usr/bin/env bun
// wasi/filestat-set-times-fd — Stream-B B2 — fd_filestat_set_times.
//
// Spec: WASI preview1 fd_filestat_set_times(fd, atim, mtim, fstflags).
// With fstflags = MTIM_NOW(8) | ATIM_NOW(2) = 10, the shim writes
// realtime clock into both. fd_filestat_get's mtim field at +48 of the
// statbuf must then be nonzero (was always 0n before Stream-B).
//
// Fixture: creates "tf.dat", calls fd_filestat_set_times(_, 0, 0, 10),
// reads back via fd_filestat_get, prints '1' if mtime > 0 else '0'.
//
// Runtime-behavioral: a user running `touch -m file.txt` from a WASI
// program would see this stat field; pre-B2 every touch was a silent
// no-op. Now mtime advances.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/filestat-set-times-fd] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('fst-fd', 'fst.wasm'), 30_000);

const r = await t.run('wasm-runner fst.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/filestat-set-times-fd', sid, base: BASE, tail, ok }, null, 2));

const checks = [['fd_filestat_set_times(MTIM_NOW) → mtime > 0', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/filestat-set-times-fd] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
