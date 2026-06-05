#!/usr/bin/env bun
// wasi-paths/new/abs-read-existing-file — read an existing file via
// absolute path. The shell writes a file at /home/user/seed.txt, then
// a C program does fopen("/home/user/seed.txt", "r") and prints contents.
//
// PRE-fix: this would have read /home/user/home/user/seed.txt (ENOENT).
// POST-fix: synthetic preopen strips '/home/user' → relative 'seed.txt'
// → vfsPath 'home/user/seed.txt' ✓.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/new/abs-read-existing-file');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("/home/user/seed.txt", "r");
  if (!f) { printf("FOPEN_FAIL\\n"); fflush(stdout); return 1; }
  char buf[256];
  size_t n = fread(buf, 1, sizeof(buf)-1, f);
  buf[n] = '\\0';
  printf("READ: %s", buf);
  fclose(f);
  fflush(stdout);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
// Seed via shell (writes to /home/user/seed.txt in the user VFS directly).
await t.run(heredocCommand('/home/user/seed.txt', 'hello-from-shell\n'), 10_000);

await t.run(heredocCommand('/home/user/rd.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/rd /home/user/rd.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles', compileOK, compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/rd ; echo RUN_EXIT=$?', 60_000);
const out = stripAnsi(rr.output);
a.check('no FOPEN_FAIL (file was opened)', !/FOPEN_FAIL/.test(out), JSON.stringify(out.slice(-300)));
a.check('READ: hello-from-shell printed', /READ: hello-from-shell/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
