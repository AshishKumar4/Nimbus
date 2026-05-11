#!/usr/bin/env bun
// wasi/filestat-set-times-path — Stream-B B2 — path_filestat_set_times.
//
// Spec: WASI preview1 path_filestat_set_times(fd, lookupflags, path,
// path_len, atim, mtim, fstflags). With fstflags = MTIM_NOW(8) the shim
// writes realtime into mtime; path_filestat_get's mtim field at +48
// must be nonzero (was always 0n before Stream-B).
//
// Fixture: creates "tf2.dat", calls path_filestat_set_times(_, 1, …, 8),
// reads back via path_filestat_get, prints '1' if mtime > 0 else '0'.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/filestat-set-times-path] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('fst-path', 'fst-p.wasm'), 30_000);

const r = await t.run('wasm-runner fst-p.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/filestat-set-times-path', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_filestat_set_times(MTIM_NOW) → mtime > 0', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/filestat-set-times-path] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
