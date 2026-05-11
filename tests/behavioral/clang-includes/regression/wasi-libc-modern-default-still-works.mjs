#!/usr/bin/env bun
// clang-includes/regression/wasi-libc-modern-default-still-works — the
// catalog default (wasi-libc-modern from Stream C v12) must still be
// what `nimbus install clang` brings down, and a simple file+printf
// program must still compile + run + write to disk correctly.
//
// Cross-wave guard: Stream C's wasi-libc-modern flip + wasi-path-fix's
// chroot-collision strip are both expected to keep working alongside
// the include-bundle rework.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/regression/wasi-libc-modern-default-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("/home/user/regression-cross-wave.txt", "w");
  if (!f) { printf("OPEN_FAIL\\n"); fflush(stdout); return 1; }
  fputs("cross-wave-ok\\n", f);
  fclose(f);
  printf("DONE\\n"); fflush(stdout);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

// Default install picks wasi-libc-modern per current catalog.
const ri = await t.run('nimbus install clang ; nimbus install --list', 300_000);
const outI = stripAnsi(ri.output);
a.check('default install pulls clang@wasi-libc-modern', /clang@wasi-libc-modern/.test(outI),
  JSON.stringify(outI.slice(-300)));

await t.run(heredocCommand('cw.c', CSRC), 10_000);
const rc = await t.run('clang cw.c -o cw', 240_000);
a.check('compile/link succeeds', !/error:/i.test(stripAnsi(rc.output)),
  JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('./cw ; echo RUN_EXIT=$?', 30_000);
const outR = stripAnsi(rr.output);
a.check('./cw prints DONE', /DONE/.test(outR), JSON.stringify(outR.slice(-300)));
a.check('./cw exits 0', /RUN_EXIT=0/.test(outR), JSON.stringify(outR.slice(-200)));

// wasi-path-fix preservation: file at the correct location, no double-prefix.
const rExist = await t.run(
  `node -e "console.log('correct=', require('fs').existsSync('/home/user/regression-cross-wave.txt'), 'doubled=', require('fs').existsSync('/home/user/home/user/regression-cross-wave.txt'))"`,
  15_000);
const outE = stripAnsi(rExist.output);
a.check('file at /home/user/regression-cross-wave.txt EXISTS (wasi-path-fix preserved)',
  /correct= true/.test(outE), JSON.stringify(outE.slice(-200)));
a.check('no /home/user/home/user/...  (no double-prefix regression)',
  /doubled= false/.test(outE), JSON.stringify(outE.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
