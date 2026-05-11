#!/usr/bin/env bun
// clang-stdio/regression/wasi-paths-abs-fopen-still-works — the
// wasi-path-fix wave's chroot-collision strip must continue to work
// alongside v13 crt1. fopen("/home/user/x") lands at /home/user/x in
// the user VFS (NOT at /home/user/home/user/x).

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/regression/wasi-paths-abs-fopen-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("/home/user/v13-abs.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); return 1; }
  fputs("v13-abs-payload\\n", f);
  fclose(f);
  printf("DONE\\n");
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
a.check('DONE printed (stdio flush)', /DONE/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

const rE = await t.run(`node -e "console.log('correct=', require('fs').existsSync('/home/user/v13-abs.txt'), 'doubled=', require('fs').existsSync('/home/user/home/user/v13-abs.txt'))"`, 15_000);
const outE = stripAnsi(rE.output);
a.check('file at /home/user/v13-abs.txt EXISTS (wasi-path-fix preserved)',
  /correct= true/.test(outE), JSON.stringify(outE.slice(-200)));
a.check('NO double-prefix /home/user/home/user/v13-abs.txt',
  /doubled= false/.test(outE), JSON.stringify(outE.slice(-200)));

const rC = await t.run('cat /home/user/v13-abs.txt', 10_000);
a.check('contents match payload', /v13-abs-payload/.test(stripAnsi(rC.output)),
  JSON.stringify(stripAnsi(rC.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
