#!/usr/bin/env bun
// wasi/hardlink — Stream-B B3 — path_link creates a hardlink.
//
// Spec: WASI preview1 path_link(old_fd, old_flags, old_path, new_fd,
// new_path). Both names refer to the same on-disk inode (in our in-
// memory FS: the same Uint8Array reference).
//
// Fixture: writes 1-byte file "src" containing 'X', calls path_link to
// create "dst", then path_filestat_get("dst") expects size=1. Prints
// '1' on match.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/hardlink] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('hardlink', 'hl.wasm'), 30_000);

const r = await t.run('wasm-runner hl.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/hardlink', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_link(src,dst) + stat(dst).size == 1', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/hardlink] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
