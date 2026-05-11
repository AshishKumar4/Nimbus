#!/usr/bin/env bun
// clang-includes/new/header-in-cwd — main.c does #include "greet.h" with
// greet.h sitting next to it in the user's cwd. PRE-fix this produced
// `fatal error: 'greet.h' file not found`. POST-fix clang finds it via
// the quote-form lookup against the source file's directory.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/new/header-in-cwd');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);

await t.run(heredocCommand('greet.h', '#ifndef GREET_H\n#define GREET_H\n#define GREETING "from-header"\n#endif\n'), 10_000);
await t.run(heredocCommand('m.c',
  '#include <stdio.h>\n#include "greet.h"\nint main(void){printf("%s\\n",GREETING);return 0;}\n'), 10_000);

const rc = await t.run('clang m.c -o m', 240_000);
const out1 = stripAnsi(rc.output);
const hasNotFound = /greet\.h.*not found|file not found/i.test(out1);
a.check('clang finds greet.h in cwd (no "file not found" error)', !hasNotFound,
  hasNotFound ? JSON.stringify(out1.slice(-400)) : '');
const compileOK = !/error:|Assertion failed/.test(out1);
a.check('compile completes without error markers', compileOK,
  compileOK ? '' : JSON.stringify(out1.slice(-400)));

const rr = await t.run('./m ; echo RUN_EXIT=$?', 30_000);
const out2 = stripAnsi(rr.output);
a.check('./m prints "from-header" (macro from greet.h)', /from-header/.test(out2),
  JSON.stringify(out2.slice(-300)));
a.check('./m exits 0', /RUN_EXIT=0/.test(out2), JSON.stringify(out2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
