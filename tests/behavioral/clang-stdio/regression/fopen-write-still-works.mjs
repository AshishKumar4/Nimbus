#!/usr/bin/env bun
// clang-stdio/regression/fopen-write-still-works — Stream-C v12's
// fopen("w") fix must still work after v13. v12 verified
// fopen(/home/user/tmp/greet.txt) writes correctly; v13 keeps the
// same vfsPath chroot model so the file should land at the same
// location and contents should match.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/regression/fopen-write-still-works');

const CSRC = `#include <stdio.h>
int main(void){
  printf("hello from v13\\n");
  FILE *f = fopen("/tmp/greet.txt", "w");
  if (!f) { printf("FOPEN_FAIL\\n"); return 1; }
  fputs("written by v13\\n", f);
  fclose(f);
  printf("done\\n");
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
await t.run('nimbus install clang', 300_000);
await t.run('mkdir -p /home/user/tmp', 10_000);
await t.run(heredocCommand('w.c', CSRC), 10_000);
await t.run('clang w.c -o w', 240_000);

const rr = await t.run('./w ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('"hello from v13" printed', /hello from v13/.test(out), JSON.stringify(out.slice(-300)));
a.check('"done" printed (v13 stdio flush works)', /done/.test(out), JSON.stringify(out.slice(-300)));
a.check('no FOPEN_FAIL', !/FOPEN_FAIL/.test(out), JSON.stringify(out.slice(-300)));
a.check('exit code 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

const r2 = await t.run('cat /home/user/tmp/greet.txt', 10_000);
a.check('greet.txt contains "written by v13"', /written by v13/.test(stripAnsi(r2.output)),
  JSON.stringify(stripAnsi(r2.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
