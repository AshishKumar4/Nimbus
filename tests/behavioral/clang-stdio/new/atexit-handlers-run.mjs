#!/usr/bin/env bun
// clang-stdio/new/atexit-handlers-run — atexit() handlers must fire
// when main returns. PRE-v13 they were dropped because v12 crt1
// bypassed exit()→__cxa_finalize.
//
// POST-v13: __wasm_call_dtors invokes __funcs_on_exit which walks
// the atexit registration list in LIFO order.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/new/atexit-handlers-run');

const CSRC = `#include <stdio.h>
#include <stdlib.h>
static void bye_first(void){ printf("ATEXIT_FIRST\\n"); }
static void bye_second(void){ printf("ATEXIT_SECOND\\n"); }
int main(void){
  atexit(bye_first);
  atexit(bye_second);
  printf("MAIN_START\\n");
  printf("MAIN_END\\n");
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('a.c', CSRC), 10_000);
await t.run('clang a.c -o a', 240_000);

const rr = await t.run('./a ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);

a.check('MAIN_START printed', /MAIN_START/.test(out), JSON.stringify(out.slice(-400)));
a.check('MAIN_END printed', /MAIN_END/.test(out), JSON.stringify(out.slice(-400)));
a.check('ATEXIT_FIRST fired (registered atexit handler called)',
  /ATEXIT_FIRST/.test(out), JSON.stringify(out.slice(-400)));
a.check('ATEXIT_SECOND fired (registered atexit handler called)',
  /ATEXIT_SECOND/.test(out), JSON.stringify(out.slice(-400)));
// LIFO order: SECOND was registered after FIRST, so SECOND fires before FIRST.
const idxFirst = out.indexOf('ATEXIT_FIRST');
const idxSecond = out.indexOf('ATEXIT_SECOND');
a.check('atexit LIFO order (SECOND fires before FIRST)',
  idxSecond > -1 && idxFirst > -1 && idxSecond < idxFirst,
  `idxFirst=${idxFirst} idxSecond=${idxSecond}`);
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
