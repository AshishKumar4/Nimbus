#!/usr/bin/env bun
// wasi/symlink-loop — Stream-B B3 — ELOOP loop-detection.
//
// Spec: POSIX SYMLOOP_MAX. WASI preview1 defines ELOOP=32. When a path
// resolution chain exceeds SYMLOOP_MAX (our shim: 40 hops), path_open
// returns ELOOP.
//
// Fixture: creates self-symlink "a" → "a", then path_open("a", follow=on).
// The shim walks the symlink, sees the same path, walks again, ... after
// 40 iterations bails with ELOOP=32. The fixture prints '0' + (errno%10)
// + '\\n' = '2\\n'.
//
// Runtime-behavioral: pre-B3 path_open would either ENOSYS the symlink
// or (worse) infinite-loop. ELOOP is the spec-mandated response.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/symlink-loop] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('symlink-loop', 'loop.wasm'), 30_000);

const r = await t.run('wasm-runner loop.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
// ELOOP = 32 → last digit '2'.
const ok = lines.some(s => s === '2');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/symlink-loop', sid, base: BASE, tail, ok }, null, 2));

const checks = [['path_open self-symlink → ELOOP (errno 32)', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/symlink-loop] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
