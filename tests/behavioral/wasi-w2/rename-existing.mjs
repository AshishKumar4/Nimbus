#!/usr/bin/env bun
// wasi-w2/rename-existing — path_rename overwriting an existing destination.
//
// Exercises the W-3 sqlite-vfs.ts:1171 fix (pre-unlink-existing-target).
// Fixture creates "a" with "A\n", "b" with "B\n", then path_rename("a", "b"),
// reads "b" back and echoes it. With the W-3 fix the readback shows "A\n";
// without the fix, path_rename either errors or "b" still reads "B\n".

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi-w2/rename-existing] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/w2 && cd /home/user/w2', 10_000);
await t.run(writeFixtureCmd('rename-existing', 're.wasm'), 30_000);

const r = await t.run('wasm-runner re.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-8).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
// Look for a line that's exactly "A" (the readback after rename).
const ok = lines.includes('A');

await t.close();

console.log(JSON.stringify({ probe: 'wasi-w2/rename-existing', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_rename("a", "b") overwrites existing b; readback is "A"', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi-w2/rename-existing] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
