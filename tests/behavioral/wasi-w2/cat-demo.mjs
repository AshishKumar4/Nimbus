#!/usr/bin/env bun
// wasi-w2/cat-demo — the Wave-2 end-to-end demo.
//
// Write hello.txt with known content via the user shell, then run
//   wasm-runner cat.wasm hello.txt
// and assert the wasm program echoes the file content. This is the
// "real WASI program reading real files from SqliteFS" proof point
// per the Wave-2 scope re-frame (clang deferred to Wave-3).
//
// Fixture path length is hardcoded to 9 ('hello.txt'). The full path
// resolution exercise lives in path-write-read; this probe specifically
// validates argv-driven path_open + multi-block fd_read loop + fd_write
// to stdout.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const CONTENTS = 'hello, world from cat.wasm running on Nimbus WASI Wave-2\n';

const sid = await mintSession();
console.log(`[wasi-w2/cat-demo] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/w2 && cd /home/user/w2', 10_000);
await t.run(writeFixtureCmd('cat', 'cat.wasm'), 30_000);

// Write hello.txt via shell — supervisor VFS-visible.
const b64 = Buffer.from(CONTENTS, 'utf8').toString('base64');
await t.run(`node -e "require('fs').writeFileSync('hello.txt', Buffer.from('${b64}','base64'))"`, 30_000);

const r = await t.run('wasm-runner cat.wasm hello.txt', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-5).join('\n');
const ok = /hello, world from cat\.wasm/.test(tail);

await t.close();

console.log(JSON.stringify({ probe: 'wasi-w2/cat-demo', sid, base: BASE, tail, ok }, null, 2));

const checks = [['cat.wasm hello.txt → echoes file content via WASI fd_read+fd_write', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi-w2/cat-demo] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
