#!/usr/bin/env bun
// clang-stdio/regression/hello-world-still-works — the canonical
// single-printf hello-world. PRE-v13 single-printf already worked
// (the first \n triggered line-buffered flush). POST-v13 must keep
// working — the new dtor chain mustn't introduce regressions on the
// trivial path.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/regression/hello-world-still-works');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
await t.run('nimbus install clang', 300_000);

await t.run(heredocCommand('h.c',
  '#include <stdio.h>\nint main(void){printf("hello, world\\n");return 0;}\n'),
  10_000);
const rc = await t.run('clang h.c -o h', 240_000);
a.check('clang compiles', !/error:/i.test(stripAnsi(rc.output)),
  JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('./h ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('./h prints "hello, world"', /hello, world/.test(out), JSON.stringify(out.slice(-300)));
a.check('./h exits 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
