#!/usr/bin/env bun
// wasi-w2/filestat — path_filestat_get.
//
// Fixture creates data.bin with 13 bytes ("hello, world!"), then calls
// path_filestat_get and prints ('0' + (size%10)) + '\n'. With size=13,
// expected stdout = "3\n".

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi-w2/filestat] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/w2 && cd /home/user/w2', 10_000);
await t.run(writeFixtureCmd('filestat', 'fs.wasm'), 30_000);

const r = await t.run('wasm-runner fs.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '3');

await t.close();

console.log(JSON.stringify({ probe: 'wasi-w2/filestat', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_filestat_get returns size=13 (mod 10 = 3)', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi-w2/filestat] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
