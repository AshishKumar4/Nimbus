#!/usr/bin/env bun
// wasi-write-caps/rename — exercise WASI path_rename through the
// binji libc rights gate (which historically blocks at fopen-write
// even before reaching rename).

import {
  Terminal, mintSession, makeAsserter, stripAnsi, heredocCommand, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-write-caps/rename');
console.log(`wasi-write-caps/rename — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 240_000);

const demoC = `#include <stdio.h>
#include <errno.h>
int main(void) {
  FILE *f = fopen("old", "w");
  if (!f) { fprintf(stderr, "fopen old failed: errno=%d\\n", errno); return 1; }
  fputs("hello\\n", f);
  fclose(f);

  if (rename("old", "new") != 0) {
    fprintf(stderr, "rename failed: errno=%d\\n", errno);
    return 2;
  }
  printf("rename ok\\n");
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
  a.check('stdout has "rename ok"', /rename ok/.test(stripped),
    /rename ok/.test(stripped) ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('NO errno error on stderr', !/errno=\d+/.test(stripped),
    /errno=\d+/.test(stripped) ? JSON.stringify(stripped.slice(-300)) : '');
}

// Sanity: verify "new" exists, "old" doesn't.
{
  const { output } = await t.run('ls -la old new 2>&1', 15_000);
  const stripped = stripAnsi(output);
  const newExists = /\bnew\b/.test(stripped) && !/No such file.*new/.test(stripped);
  const oldGone = /No such file.*old|cannot access.*old/.test(stripped);
  a.check('new exists', newExists, newExists ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('old gone', oldGone, oldGone ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
