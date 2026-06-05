#!/usr/bin/env bun
// clang-stdio/regression/v13-stdio-flush-active — verifies that the
// catalog default for `clang` resolves to the v13 sysroot whose crt1.o
// calls __wasm_call_dtors before __wasi_proc_exit (so stdio flushes).
//
// This probe is a small canary that defends against regressions of
// the v13 sysroot pointer in R2 (catalog/manifest swap) AND of the
// clang-runner ↔ wasm-runner pipeline that surfaces the linked
// binary's behavior.
//
// PRE-v13 (v12 crt1): `printf("A\n"); printf("B\n"); return 0;` from
// the default-installed clang emits ONLY "A" on stdout — the second
// printf's output is buffered in libc's FILE table and lost because
// v12 crt1 called __wasi_proc_exit directly, bypassing the stdio
// cleanup chain.
//
// POST-v13: BOTH lines visible because v13 crt1 calls __wasm_call_dtors
// (which fans out to __funcs_on_exit + __stdio_exit) before terminating.
//
// Probe contract:
//   - drive a fresh Nimbus session
//   - `nimbus install clang` (default — wasi-libc-modern variant)
//   - compile a minimal multi-printf-without-fflush C program
//   - run it, assert BOTH "A" and "B" lines appear on stdout

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/regression/v13-stdio-flush-active');

const CSRC = `#include <stdio.h>
int main(void){
  printf("LINE_A\\n");
  printf("LINE_B\\n");
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

// Default-install clang. The catalog default MUST resolve to the
// wasi-libc-modern variant whose sysroot manifest points at the v13
// crt1 sysroot blob. If a future wave (or accidental R2 manifest
// rollback) reverts to v12, this probe fails loudly.
const rInst = await t.run('nimbus install clang ; nimbus install --list', 300_000);
const outInst = stripAnsi(rInst.output);
a.check('default install resolves to clang@wasi-libc-modern',
  /clang@wasi-libc-modern/.test(outInst), JSON.stringify(outInst.slice(-300)));

await t.run(heredocCommand('m.c', CSRC), 10_000);
const rc = await t.run('clang m.c -o m', 240_000);
a.check('clang compiles successfully', !/error:/i.test(stripAnsi(rc.output)),
  JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('./m ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('LINE_A printed (line-buffered first \\n flush)',
  /LINE_A/.test(out), JSON.stringify(out.slice(-400)));
a.check('LINE_B printed (v13 stdio flush — PRE-v13 was MISSING)',
  /LINE_B/.test(out), JSON.stringify(out.slice(-400)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
