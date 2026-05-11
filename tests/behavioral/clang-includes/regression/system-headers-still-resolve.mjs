#!/usr/bin/env bun
// clang-includes/regression/system-headers-still-resolve — stdio.h,
// stdlib.h, string.h must continue to resolve from the bundled sysroot.
// Reaffirms that the include-bundle rework did NOT break the
// -internal-isystem search paths.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/regression/system-headers-still-resolve');

const CSRC = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void){
  char *buf = malloc(32);
  strcpy(buf, "stdio+stdlib+string");
  printf("OK %s len=%zu\\n", buf, strlen(buf));
  free(buf);
  return 0;
}`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('s.c', CSRC), 10_000);

const rc = await t.run('clang s.c -o s', 240_000);
const out1 = stripAnsi(rc.output);
a.check('compile + link with stdio/stdlib/string succeeds', !/error:/i.test(out1),
  JSON.stringify(out1.slice(-400)));
a.check('no "not found" for system headers', !/file not found/i.test(out1),
  JSON.stringify(out1.slice(-400)));

const rr = await t.run('./s ; echo RUN_EXIT=$?', 30_000);
const out2 = stripAnsi(rr.output);
a.check('./s prints expected concat', /OK stdio\+stdlib\+string len=19/.test(out2),
  JSON.stringify(out2.slice(-300)));
a.check('./s exits 0', /RUN_EXIT=0/.test(out2), JSON.stringify(out2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
