#!/usr/bin/env bun
// wasi-w2/pread-pwrite — offset-based I/O.
//
// Fixture:
//   - Create data.txt with "abcdefgh" (8 bytes).
//   - fd_pwrite "XY" @ offset 3 → file becomes "abcXYfgh".
//   - fd_pread 5 bytes @ offset 1 → should return "bcXYf".
//   - Echo to stdout + '\n'. Expected: "bcXYf\n".

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi-w2/pread-pwrite] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/w2 && cd /home/user/w2', 10_000);
await t.run(writeFixtureCmd('pread-pwrite', 'pp.wasm'), 30_000);

const r = await t.run('wasm-runner pp.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const ok = /\bbcXYf\b/.test(tail);

await t.close();

console.log(JSON.stringify({ probe: 'wasi-w2/pread-pwrite', sid, base: BASE, tail, ok }, null, 2));

const checks = [['fd_pwrite @3 + fd_pread @1 len 5 → "bcXYf"', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi-w2/pread-pwrite] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
