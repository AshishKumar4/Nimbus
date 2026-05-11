#!/usr/bin/env bun
// wasi-paths/regression/abs-tmp-still-works — Pre-fix behavior: a C program
// doing fopen("/tmp/x", "w") under wasi-libc-modern (preopen wasiPath '/',
// vfsPath 'home/user') correctly creates the file at /home/user/tmp/x.
//
// Regression check: this MUST still work post wasi-paths fix (the synthetic
// '/home/user' preopen must NOT affect paths that DON'T start with
// '/home/user').

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/regression/abs-tmp-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("/tmp/regression-tmp.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); fflush(stdout); return 1; }
  fputs("regression-tmp-payload\\n", f);
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
await t.run('mkdir -p /home/user/tmp', 10_000);
await t.run(heredocCommand('/home/user/r.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/r /home/user/r.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles probe.c without errors', compileOK,
  compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/r ; echo RUN_EXIT=$?', 60_000);
const runOK = /PROGRAM_OK/.test(stripAnsi(rr.output)) && /RUN_EXIT=0/.test(stripAnsi(rr.output));
a.check('program exits 0 with PROGRAM_OK on stdout', runOK,
  JSON.stringify(stripAnsi(rr.output).slice(-200)));

// File MUST exist at /home/user/tmp/regression-tmp.txt (the pre-fix
// destination — abs path '/tmp/x' with preopen '/' resolving to vfsPath
// 'home/user', so the file lands at 'home/user/tmp/x').
const rExists = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/tmp/regression-tmp.txt') ? 'EXISTS' : 'ABSENT')"`, 15_000);
const exists = /EXISTS/.test(stripAnsi(rExists.output));
a.check('file at /home/user/tmp/regression-tmp.txt EXISTS (pre-fix destination preserved)', exists,
  exists ? '' : JSON.stringify(stripAnsi(rExists.output).slice(-200)));

const rContent = await t.run('cat /home/user/tmp/regression-tmp.txt', 10_000);
const contentOK = /regression-tmp-payload/.test(stripAnsi(rContent.output));
a.check('file contents match payload', contentOK,
  contentOK ? '' : JSON.stringify(stripAnsi(rContent.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
