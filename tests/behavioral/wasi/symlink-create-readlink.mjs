#!/usr/bin/env bun
// wasi/symlink-create-readlink — Stream-B B3 — round-trip a symlink.
//
// Spec:
//   path_symlink(old_path, fd, new_path) — creates a symlink at
//     fd/new_path whose stored target string is old_path (verbatim).
//   path_readlink(fd, path, buf, buf_len, *bufused) — reads the target
//     into buf (truncated to buf_len), writes byte count to *bufused.
//
// Fixture: creates symlink "b" → "target123" (9 bytes), readlinks it
// into a 16-byte buffer, writes (bufused-many bytes + "\\n") to stdout.
// Expected stdout line: "target123".
//
// Runtime-behavioral: pre-B3 path_symlink/readlink returned ENOSYS so
// any user program (git, npm linking node_modules/.bin/*) crashed.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/symlink-create-readlink] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('symlink-create-readlink', 'sym.wasm'), 30_000);

const r = await t.run('wasm-runner sym.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === 'target123');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/symlink-create-readlink', sid, base: BASE, tail, ok }, null, 2));

const checks = [['symlink+readlink round-trip "target123"', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/symlink-create-readlink] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
