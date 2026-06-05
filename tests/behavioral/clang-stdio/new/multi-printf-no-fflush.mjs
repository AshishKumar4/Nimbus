#!/usr/bin/env bun
// clang-stdio/new/multi-printf-no-fflush — THE v13 bug fix.
//
// PRE-v13 (v12 crt1, prod 2d1f48bc):
//   printf("line one\n"); printf("line two\n"); return 0;
// emitted ONLY "line one" — the second printf's output was buffered in
// libc's stdout FILE buffer and lost because v12 crt1 called
// __wasi_proc_exit directly, bypassing the libc exit() chain that
// flushes stdio.
//
// POST-v13: crt1 calls __wasm_call_dtors() (musl's stdio_exit +
// atexit-handlers fan-out) before __wasi_proc_exit. All buffered
// stdout is written before the process terminates.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/new/multi-printf-no-fflush');

const CSRC = `#include <stdio.h>
int main(void){
  printf("line one\\n");
  printf("line two\\n");
  printf("no-newline-tail");
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('m.c', CSRC), 10_000);

const rc = await t.run('clang m.c -o m', 240_000);
a.check('compile succeeds', !/error:/i.test(stripAnsi(rc.output)),
  JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('./m ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('line one printed (line-buffered first flush, pre-v13 ok)', /line one/.test(out),
  JSON.stringify(out.slice(-300)));
a.check('line two printed (v13 stdio-flush works)', /line two/.test(out),
  JSON.stringify(out.slice(-300)));
a.check('no-newline-tail printed (v13 flush works for buffered tail)',
  /no-newline-tail/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
