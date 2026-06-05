#!/usr/bin/env bun
// wasi-paths/new/abs-parent-traversal — '..' segments in absolute paths
// resolve correctly. fopen("/home/user/sub/../top.txt", "w") must create
// /home/user/top.txt (NOT /home/user/sub/top.txt or anything weird).
//
// Synthetic preopen at '/home/user' strips → relative 'sub/../top.txt'.
// Resolver canonicalize() handles '..' segments.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/new/abs-parent-traversal');

const CSRC = `#include <stdio.h>
#include <sys/stat.h>
int main(void){
  mkdir("/home/user/sub", 0755);
  FILE *f = fopen("/home/user/sub/../traversal-top.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); fflush(stdout); return 1; }
  fputs("traversal-payload\\n", f);
  fclose(f);
  printf("PROGRAM_OK\\n"); fflush(stdout);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('/home/user/tr.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/tr /home/user/tr.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles', compileOK, compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/tr ; echo RUN_EXIT=$?', 60_000);
a.check('PROGRAM_OK printed', /PROGRAM_OK/.test(stripAnsi(rr.output)), JSON.stringify(stripAnsi(rr.output).slice(-200)));
a.check('exit code 0', /RUN_EXIT=0/.test(stripAnsi(rr.output)), JSON.stringify(stripAnsi(rr.output).slice(-200)));

const rExists = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/traversal-top.txt') ? 'EXISTS' : 'ABSENT')"`, 15_000);
a.check('/home/user/traversal-top.txt EXISTS (../ resolved)', /EXISTS/.test(stripAnsi(rExists.output)),
  JSON.stringify(stripAnsi(rExists.output).slice(-200)));

const rSub = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/sub/traversal-top.txt') ? 'EXISTS' : 'ABSENT')"`, 15_000);
a.check('/home/user/sub/traversal-top.txt ABSENT (../ properly consumed)', /ABSENT/.test(stripAnsi(rSub.output)),
  JSON.stringify(stripAnsi(rSub.output).slice(-200)));

const rContent = await t.run('cat /home/user/traversal-top.txt', 10_000);
a.check('contents match payload', /traversal-payload/.test(stripAnsi(rContent.output)),
  JSON.stringify(stripAnsi(rContent.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
