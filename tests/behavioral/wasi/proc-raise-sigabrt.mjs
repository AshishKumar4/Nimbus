#!/usr/bin/env bun
// wasi/proc-raise-sigabrt — Stream-B B5 — proc_raise encodes 128+sig.
//
// Spec: POSIX shell convention encodes a signal-terminated process as
// exit-status (128 + signo). SIGABRT = 6 → 134. WASI preview1 doesn't
// formalize this but our shim follows the bash/sh convention so users
// can distinguish signal-driven exit from regular non-zero exit.
//
// Fixture: calls proc_raise(6). Shim throws __WasiExit(134). The shell
// reports the exit code on the prompt line as a number, OR via the
// wasm-runner's stderr framing — we check both via the terminal's
// next prompt line / stderr.
//
// Runtime-behavioral: pre-B5 proc_raise(any sig) → exit 128 (no
// signal info). Modern wasi-libc's abort()→raise(SIGABRT) chain now
// surfaces the right status to the shell.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/proc-raise-sigabrt] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('proc-raise-sigabrt', 'pra.wasm'), 30_000);

// Run wasm-runner; then `echo $?` to capture exit code on the shell.
await t.run('wasm-runner pra.wasm', 60_000);
const r = await t.run('echo $?', 10_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '134');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/proc-raise-sigabrt', sid, base: BASE, tail, ok }, null, 2));

const checks = [['proc_raise(SIGABRT=6) → exit code 134', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/proc-raise-sigabrt] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
