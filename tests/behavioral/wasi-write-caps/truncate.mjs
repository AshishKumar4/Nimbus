#!/usr/bin/env bun
// wasi-write-caps/truncate — exercise WASI fd_filestat_set_size
// (via ftruncate) through the binji libc rights gate.

import {
  Terminal, mintSession, makeAsserter, stripAnsi, heredocCommand, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-write-caps/truncate');
console.log(`wasi-write-caps/truncate — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 240_000);

const demoC = `#include <stdio.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
int main(void) {
  FILE *f = fopen("x.dat", "w+");
  if (!f) { fprintf(stderr, "fopen failed: errno=%d\\n", errno); return 1; }
  // Write 100 bytes
  char buf[100];
  for (int i = 0; i < 100; i++) buf[i] = 'A' + (i % 26);
  fwrite(buf, 1, 100, f);
  fflush(f);

  int fd = fileno(f);
  if (ftruncate(fd, 50) != 0) {
    fprintf(stderr, "ftruncate failed: errno=%d\\n", errno);
    return 2;
  }
  fclose(f);

  struct stat st;
  if (stat("x.dat", &st) != 0) {
    fprintf(stderr, "stat failed: errno=%d\\n", errno);
    return 3;
  }
  printf("size=%ld\\n", (long)st.st_size);
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
  a.check('stdout has "size=50" (ftruncate succeeded)',
    /size=50\b/.test(stripped),
    /size=50\b/.test(stripped) ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('NO errno error on stderr', !/errno=\d+/.test(stripped),
    /errno=\d+/.test(stripped) ? JSON.stringify(stripped.slice(-300)) : '');
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
