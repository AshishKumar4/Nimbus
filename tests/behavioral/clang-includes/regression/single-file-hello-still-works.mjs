#!/usr/bin/env bun
// clang-includes/regression/single-file-hello-still-works — the canonical
// hello-world pipeline must keep working post-refactor. Single .c file,
// no headers, default cwd compile.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/regression/single-file-hello-still-works');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('hello.c',
  '#include <stdio.h>\nint main(void){printf("hello-from-clang-regression\\n");return 0;}\n'),
  10_000);

const rc = await t.run('clang hello.c -o hello', 240_000);
const out1 = stripAnsi(rc.output);
a.check('clang hello.c -o hello has no errors', !/error:/i.test(out1),
  JSON.stringify(out1.slice(-400)));

const rr = await t.run('./hello ; echo RUN_EXIT=$?', 30_000);
const out2 = stripAnsi(rr.output);
a.check('./hello prints expected message', /hello-from-clang-regression/.test(out2),
  JSON.stringify(out2.slice(-300)));
a.check('./hello exits 0', /RUN_EXIT=0/.test(out2), JSON.stringify(out2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
