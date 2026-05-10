#!/usr/bin/env bun
// wasi/hello-world — fd_write the bytes "hello, WASI!\n" to stdout via WASI.
//
// Fixture: 143 B hand-rolled wasm; one import (fd_write); _start calls
// fd_write(fd=1, iov_ptr=8, iov_len=1, nwritten=16) with an iovec pointing
// at the message bytes at offset 24. Verified locally under node:wasi:
// prints "hello, WASI!\n".
//
// Wave-1 WASI fn under test: fd_write (fd 1 → stdout via ProcessLogStore).

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi/hello-world] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wasi && cd /home/user/wasi', 10_000);
await t.run(writeFixtureCmd('hello', 'hello.wasm'), 30_000);

const result = await t.run('wasm-runner hello.wasm _start', 30_000);
const out = stripAnsi(result.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const wroteOk = /hello, WASI!/.test(tail);
const noErr  = !/error|err:/i.test(tail);

await t.close();

const findings = { probe: 'wasi/hello-world', sid, base: BASE, tail, wroteOk, noErr };
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['hello-world fd_write produced "hello, WASI!"', wroteOk],
  ['no error string in output',                    noErr],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/hello-world] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
