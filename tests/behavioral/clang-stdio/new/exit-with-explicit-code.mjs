#!/usr/bin/env bun
// clang-stdio/new/exit-with-explicit-code — explicit exit(N) flushes
// stdio + propagates exit code. PRE-v13 this already worked because
// exit() directly calls the cleanup chain. POST-v13 must keep working
// AND the chain must compose with crt1's own dtor call without
// double-flushing or hanging.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/new/exit-with-explicit-code');

const CSRC = `#include <stdio.h>
#include <stdlib.h>
int main(void){
  printf("before-exit-A\\n");
  printf("before-exit-B\\n");
  exit(73);
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('e.c', CSRC), 10_000);
await t.run('clang e.c -o e', 240_000);

const rr = await t.run('./e ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('before-exit-A printed', /before-exit-A/.test(out), JSON.stringify(out.slice(-400)));
a.check('before-exit-B printed', /before-exit-B/.test(out), JSON.stringify(out.slice(-400)));
a.check('exit code 73 propagated to shell', /RUN_EXIT=73/.test(out),
  JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
