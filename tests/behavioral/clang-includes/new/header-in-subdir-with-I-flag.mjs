#!/usr/bin/env bun
// clang-includes/new/header-in-subdir-with-I-flag — header lives in
// include/, source uses `-Iinclude` to find it. Validates the parser
// extracts -I paths and the bundle includes subdir headers.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/new/header-in-subdir-with-I-flag');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run('mkdir -p include', 10_000);
await t.run(heredocCommand('include/lib.h',
  '#ifndef LIB_H\n#define LIB_H\n#define LIB_VALUE 42\n#endif\n'), 10_000);
await t.run(heredocCommand('m.c',
  '#include <stdio.h>\n#include "lib.h"\nint main(void){printf("VAL=%d\\n",LIB_VALUE);return 0;}\n'),
  10_000);

const rc = await t.run('clang -Iinclude m.c -o m', 240_000);
const out1 = stripAnsi(rc.output);
a.check('lib.h resolves via -Iinclude', !/lib\.h.*not found/i.test(out1), JSON.stringify(out1.slice(-400)));
a.check('no error markers', !/error:/i.test(out1), JSON.stringify(out1.slice(-400)));

const rr = await t.run('./m ; echo RUN_EXIT=$?', 30_000);
const out2 = stripAnsi(rr.output);
a.check('./m prints VAL=42', /VAL=42/.test(out2), JSON.stringify(out2.slice(-300)));
a.check('./m exits 0', /RUN_EXIT=0/.test(out2), JSON.stringify(out2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
