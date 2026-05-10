#!/usr/bin/env bun
// wasi-w2/mkdir-readdir — path_create_directory + fd_readdir.
//
// Fixture creates "sub" dir, opens it with O_DIRECTORY, calls fd_readdir
// asking for 200 bytes, prints '0' + (bufused > 0 ? 1 : 0) + '\n'.
// Pass: stdout includes "1".
//
// Note: an empty directory still yields synthetic "." / ".." entries from
// most WASI impls, so bufused > 0 is expected.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi-w2/mkdir-readdir] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/w2 && cd /home/user/w2', 10_000);
await t.run(writeFixtureCmd('mkdir-readdir', 'mkr.wasm'), 30_000);

const r = await t.run('wasm-runner mkr.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
// '1' on its own line; not the prompt
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi-w2/mkdir-readdir', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_create_directory + fd_readdir → bufused > 0', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi-w2/mkdir-readdir] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
