#!/usr/bin/env bun
// wasi-write-caps/mkdir-rmdir — exercise WASI path_create_directory +
// path_remove_directory through the binji libc rights gate.

import {
  Terminal, mintSession, makeAsserter, stripAnsi, heredocCommand, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-write-caps/mkdir-rmdir');
console.log(`wasi-write-caps/mkdir-rmdir — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 240_000);

const demoC = `#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
int main(void) {
  if (mkdir("foo", 0755) != 0) {
    fprintf(stderr, "mkdir failed: errno=%d\\n", errno);
    return 1;
  }
  printf("mkdir ok\\n");
  if (rmdir("foo") != 0) {
    fprintf(stderr, "rmdir failed: errno=%d\\n", errno);
    return 2;
  }
  printf("rmdir ok\\n");
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
  a.check('stdout has "mkdir ok"', /mkdir ok/.test(stripped),
    /mkdir ok/.test(stripped) ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('stdout has "rmdir ok"', /rmdir ok/.test(stripped),
    /rmdir ok/.test(stripped) ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('NO errno error on stderr', !/errno=\d+/.test(stripped),
    /errno=\d+/.test(stripped) ? JSON.stringify(stripped.slice(-300)) : '');
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
