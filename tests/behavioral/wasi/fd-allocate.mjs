#!/usr/bin/env bun
// wasi/fd-allocate — Stream-B B4 — fd_allocate extends file size.
//
// Spec: WASI preview1 fd_allocate(fd, offset, len) — preallocates space
// in [offset, offset+len). Equivalent of posix_fallocate(3). Our in-
// memory FS extends the file's Uint8Array (zero-fill is implicit).
//
// Fixture: creates "ext", calls fd_allocate(_, 0, 16), then fd_filestat_get
// and checks size == 16. Prints '1' on match. Pre-B4 returned ENOSYS → no
// size change → '0'.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/fd-allocate] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('fd-allocate', 'all.wasm'), 30_000);

const r = await t.run('wasm-runner all.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/fd-allocate', sid, base: BASE, tail, ok }, null, 2));

const checks = [['fd_allocate(0, 16) extends file to 16 bytes', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/fd-allocate] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
