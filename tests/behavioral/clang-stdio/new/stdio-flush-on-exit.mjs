#!/usr/bin/env bun
// clang-stdio/new/stdio-flush-on-exit — multiple unbuffered + buffered
// writes through stdout MUST appear after main returns, even WITHOUT
// explicit fflush. Tests the FILE* cleanup chain in __stdio_exit.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/new/stdio-flush-on-exit');

// 5 distinct prints, no fflush, return 0.
const CSRC = `#include <stdio.h>
int main(void){
  for (int i = 1; i <= 5; i++) {
    printf("PRINT_%d\\n", i);
  }
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('s.c', CSRC), 10_000);
await t.run('clang s.c -o s', 240_000);

const rr = await t.run('./s ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
for (let i = 1; i <= 5; i++) {
  a.check(`PRINT_${i} appears in stdout`, new RegExp(`PRINT_${i}`).test(out),
    JSON.stringify(out.slice(-400)));
}
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
