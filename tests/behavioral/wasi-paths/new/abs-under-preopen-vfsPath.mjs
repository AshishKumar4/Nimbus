#!/usr/bin/env bun
// wasi-paths/new/abs-under-preopen-vfsPath — THE BUG FIX.
//
// A C program calling fopen("/home/user/abs.txt", "w") must create the
// file at /home/user/abs.txt — not at /home/user/home/user/abs.txt.
//
// PRE-fix prod (5531163d): file landed at /home/user/home/user/abs.txt.
// POST-fix: synthetic preopen at wasiPath '/home/user' makes wasi-libc
// strip '/home/user' from the path; the relative 'abs.txt' resolves
// against vfsPath 'home/user' → 'home/user/abs.txt' ✓.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/new/abs-under-preopen-vfsPath');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("/home/user/abs-fix.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); fflush(stdout); return 1; }
  fputs("abs-fix-payload\\n", f);
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
await t.run(heredocCommand('/home/user/abs.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/abs /home/user/abs.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles', compileOK, compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/abs ; echo RUN_EXIT=$?', 60_000);
const runOK = /PROGRAM_OK/.test(stripAnsi(rr.output)) && /RUN_EXIT=0/.test(stripAnsi(rr.output));
a.check('program exits 0 with PROGRAM_OK on stdout', runOK,
  JSON.stringify(stripAnsi(rr.output).slice(-200)));

// THE bug check: file at /home/user/abs-fix.txt MUST exist; file at
// /home/user/home/user/abs-fix.txt MUST NOT exist.
const rCorrect = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/abs-fix.txt') ? 'EXISTS' : 'ABSENT')"`, 15_000);
const correctExists = /EXISTS/.test(stripAnsi(rCorrect.output));
a.check('file at /home/user/abs-fix.txt EXISTS (correct location)', correctExists,
  correctExists ? '' : JSON.stringify(stripAnsi(rCorrect.output).slice(-200)));

const rBuggy = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/home/user/abs-fix.txt') ? 'EXISTS' : 'ABSENT')"`, 15_000);
const buggyAbsent = /ABSENT/.test(stripAnsi(rBuggy.output));
a.check('file at /home/user/home/user/abs-fix.txt ABSENT (no double-prefix)', buggyAbsent,
  buggyAbsent ? '' : JSON.stringify(stripAnsi(rBuggy.output).slice(-200)));

const rContent = await t.run('cat /home/user/abs-fix.txt', 10_000);
const contentOK = /abs-fix-payload/.test(stripAnsi(rContent.output));
a.check('file contents match payload at correct location', contentOK,
  contentOK ? '' : JSON.stringify(stripAnsi(rContent.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
