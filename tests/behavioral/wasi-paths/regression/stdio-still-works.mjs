#!/usr/bin/env bun
// wasi-paths/regression/stdio-still-works — stdin/stdout/stderr (fd 0/1/2)
// must remain unaffected by the synthetic-preopen change.
//
// Regression check: stdout printf and stderr fprintf both flow through to
// the shell terminal correctly.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/regression/stdio-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  printf("ON_STDOUT\\n");
  fflush(stdout);
  fprintf(stderr, "ON_STDERR\\n");
  fflush(stderr);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('/home/user/s.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/s /home/user/s.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles', compileOK, compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/s ; echo RUN_EXIT=$?', 60_000);
const out = stripAnsi(rr.output);
a.check('ON_STDOUT printed', /ON_STDOUT/.test(out), JSON.stringify(out.slice(-300)));
a.check('ON_STDERR printed', /ON_STDERR/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
