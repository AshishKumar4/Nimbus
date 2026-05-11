#!/usr/bin/env bun
// wasi-write-caps/unlink — exercise WASI path_unlink_file through the
// binji libc rights gate.

import {
  Terminal, mintSession, makeAsserter, stripAnsi, heredocCommand, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-write-caps/unlink');
console.log(`wasi-write-caps/unlink — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 240_000);

const demoC = `#include <stdio.h>
#include <unistd.h>
#include <errno.h>
int main(void) {
  FILE *f = fopen("doomed", "w");
  if (!f) { fprintf(stderr, "fopen failed: errno=%d\\n", errno); return 1; }
  fputs("bye\\n", f);
  fclose(f);

  if (unlink("doomed") != 0) {
    fprintf(stderr, "unlink failed: errno=%d\\n", errno);
    return 2;
  }
  printf("unlink ok\\n");

  // Try to reopen — should fail.
  FILE *r = fopen("doomed", "r");
  if (r) {
    fprintf(stderr, "fopen-after-unlink unexpectedly succeeded\\n");
    fclose(r);
    return 3;
  }
  printf("readback rejected as expected\\n");
  return 0;
}`;
await t.run(heredocCommand('demo.c', demoC), 15_000);

{
  const { output } = await t.run('clang demo.c -o demo', 300_000);
  const stripped = stripAnsi(output);
  a.check('clang demo.c -o demo (no errors)',
    !/error:|fatal:/i.test(stripped),
    /error:|fatal:/i.test(stripped) ? JSON.stringify(stripped.slice(-400)) : '');
}

{
  const { output } = await t.run('./demo', 60_000);
  const stripped = stripAnsi(output);
  a.check('stdout has "unlink ok"', /unlink ok/.test(stripped),
    /unlink ok/.test(stripped) ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('stdout has "readback rejected as expected"',
    /readback rejected as expected/.test(stripped),
    /readback rejected as expected/.test(stripped) ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('NO errno error on stderr', !/errno=\d+/.test(stripped),
    /errno=\d+/.test(stripped) ? JSON.stringify(stripped.slice(-300)) : '');
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
