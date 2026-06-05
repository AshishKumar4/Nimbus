#!/usr/bin/env bun
// wasi-paths/new/abs-outside-preopen-fails — paths NOT under any preopen
// (e.g. /etc/passwd) MUST be inaccessible. Under the synthetic-preopen
// fix the only preopens are '/' (= vfsPath 'home/user') and '/home/user'
// (= same vfsPath). A program trying /etc/x will see wasi-libc strip '/'
// → relative 'etc/x' → vfsPath 'home/user/etc/x' which doesn't exist
// in the snapshot. The user fopen returns NULL (ENOENT) — NOT a leak
// of the host /etc/passwd.
//
// This probe asserts the absence-of-leak property.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-paths/new/abs-outside-preopen-fails');

const CSRC = `#include <stdio.h>
int main(void){
  FILE *f = fopen("/etc/passwd", "r");
  if (f) { printf("LEAK\\n"); fclose(f); fflush(stdout); return 1; }
  printf("EXPECTED_ABSENT\\n"); fflush(stdout);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('/home/user/o.c', CSRC), 30_000);
const rc = await t.run('clang -O0 -o /home/user/o /home/user/o.c', 240_000);
const compileOK = !/error:|Assertion failed/.test(stripAnsi(rc.output));
a.check('clang compiles', compileOK, compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('/home/user/o ; echo RUN_EXIT=$?', 60_000);
const out = stripAnsi(rr.output);
a.check('no host /etc/passwd LEAK', !/LEAK/.test(out), JSON.stringify(out.slice(-300)));
a.check('EXPECTED_ABSENT printed', /EXPECTED_ABSENT/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
