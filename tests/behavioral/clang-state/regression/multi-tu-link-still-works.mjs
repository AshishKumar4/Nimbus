#!/usr/bin/env bun
// clang-state/regression/multi-tu-link-still-works — clang-include-fix
// multi-TU link preserved post-state-fix.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-state/regression/multi-tu-link-still-works');

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
await t.run('nimbus install clang', 300_000);

const greetH = '#ifndef GH\n#define GH\nvoid greet_a(void);\nvoid greet_b(void);\n#endif\n';
const aC = '#include <stdio.h>\n#include "greet.h"\nvoid greet_a(void){printf("greet_a\\n");fflush(stdout);}\n';
const bC = '#include <stdio.h>\n#include "greet.h"\nvoid greet_b(void){printf("greet_b\\n");fflush(stdout);}\n';
const mC = '#include "greet.h"\nint main(void){greet_a();greet_b();return 0;}\n';

await t.run(heredocCommand('greet.h', greetH), 10_000);
await t.run(heredocCommand('greet_a.c', aC), 10_000);
await t.run(heredocCommand('greet_b.c', bC), 10_000);
await t.run(heredocCommand('main.c', mC), 10_000);

const rc = await t.run('clang main.c greet_a.c greet_b.c -o multi', 240_000);
a.check('multi-TU compile+link succeeds', !/error:/i.test(stripAnsi(rc.output)),
  JSON.stringify(stripAnsi(rc.output).slice(-400)));

const rr = await t.run('./multi ; echo RUN_EXIT=$?', 30_000);
const out = stripAnsi(rr.output);
a.check('./multi prints "greet_a"', /greet_a/.test(out), JSON.stringify(out.slice(-300)));
a.check('./multi prints "greet_b"', /greet_b/.test(out), JSON.stringify(out.slice(-300)));
a.check('./multi exits 0', /RUN_EXIT=0/.test(out), JSON.stringify(out.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
