#!/usr/bin/env bun
// clang-state/regression/fopen-write-still-works — Stream-C v12 fopen
// behavior preserved, AND v13 crt1 stdio flush preserved.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-state/regression/fopen-write-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  printf("hello state-fix\\n");
  FILE *f = fopen("/tmp/greet.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); return 1; }
  fputs("written by state-fix\\n", f);
  fclose(f);
  printf("done\\n");
  return 0;
}`;

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
await t.run('nimbus install clang', 300_000);
await t.run('mkdir -p /home/user/tmp', 10_000);
await t.run(heredocCommand('w.c', CSRC), 10_000);
await t.run('clang w.c -o w', 240_000);

const rr = await t.run('./w ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('"hello state-fix" printed', /hello state-fix/.test(out), JSON.stringify(out.slice(-300)));
a.check('"done" printed (v13 crt1 stdio flush preserved)',
  /done/.test(out), JSON.stringify(out.slice(-300)));
a.check('no FOPEN_FAIL', !/FOPEN_FAIL/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

const rC = await t.run('cat /home/user/tmp/greet.txt', 10_000);
a.check('greet.txt contains "written by state-fix"',
  /written by state-fix/.test(stripAnsi(rC.output)),
  JSON.stringify(stripAnsi(rC.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
