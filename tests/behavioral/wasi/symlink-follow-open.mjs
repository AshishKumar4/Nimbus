#!/usr/bin/env bun
// wasi/symlink-follow-open — Stream-B B3 — symlink follow on path_open.
//
// Spec: dirflags & LOOKUPFLAGS_SYMLINK_FOLLOW (bit 1) makes path_open
// dereference symlinks transparently. The shim's __wasiResolvePathFull
// walks the chain (bounded by SYMLOOP_MAX=40) and opens the final
// non-symlink target.
//
// Fixture: writes "real.txt" containing "OK\\n", creates symlink "lnk"
// → "real.txt", opens "lnk" with follow=on, reads 3 bytes, echoes them
// to stdout. Expected: "OK\\n" in output.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/symlink-follow-open] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('symlink-follow-open', 'sfo.wasm'), 30_000);

const r = await t.run('wasm-runner sfo.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const ok = /OK/.test(tail);

await t.close();

console.log(JSON.stringify({ probe: 'wasi/symlink-follow-open', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_open(follow) on symlink reads target contents', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/symlink-follow-open] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
