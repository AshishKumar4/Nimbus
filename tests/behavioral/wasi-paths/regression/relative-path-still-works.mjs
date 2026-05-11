#!/usr/bin/env bun
// wasi-paths/regression/relative-path-still-works — A C program doing
// fopen("relfile.txt", "w") (relative path) writes to cwd. With cwd '/'
// (wasm-side) which maps to vfsPath 'home/user', the file lands at
// /home/user/relfile.txt.
//
// Regression check: synthetic preopen MUST NOT disrupt relative-path
// resolution.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/regression/relative-path-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("regression-rel.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); fflush(stdout); return 1; }
  fputs("relative-payload\\n", f);
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
await t.run(heredocCommand('/home/user/r.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/r /home/user/r.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles probe.c without errors', compileOK,
  compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/r ; echo RUN_EXIT=$?', 60_000);
const runOK = /PROGRAM_OK/.test(stripAnsi(rr.output)) && /RUN_EXIT=0/.test(stripAnsi(rr.output));
a.check('program exits 0 with PROGRAM_OK on stdout', runOK,
  JSON.stringify(stripAnsi(rr.output).slice(-200)));

const rExists = await t.run(`node -e "console.log(require('fs').existsSync('/home/user/regression-rel.txt') ? 'EXISTS' : 'ABSENT')"`, 15_000);
const exists = /EXISTS/.test(stripAnsi(rExists.output));
a.check('file at /home/user/regression-rel.txt EXISTS (relative-to-cwd preserved)', exists,
  exists ? '' : JSON.stringify(stripAnsi(rExists.output).slice(-200)));

const rContent = await t.run('cat /home/user/regression-rel.txt', 10_000);
const contentOK = /relative-payload/.test(stripAnsi(rContent.output));
a.check('file contents match payload', contentOK,
  contentOK ? '' : JSON.stringify(stripAnsi(rContent.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
