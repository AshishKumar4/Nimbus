#!/usr/bin/env bun
// clang-includes/new/multi-tu-link — `clang main.c greet.c -o out` with
// greet.h shared between both TUs. PRE-fix: greet.h not found AND only
// the first .c was compiled (no greet symbol defined for link).
// POST-fix: both TUs compile, link succeeds, output prints greet output.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/new/multi-tu-link');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);

// fflush(stdout) is explicit at each print site because the v12 crt1
// calls __wasi_proc_exit directly (bypassing libc's atexit/stdio
// flush chain). This is a known Stream-C v12 follow-up — not a
// clang-include-fix regression. Probes match the proven pattern.
const greetH = '#ifndef GREET_H\n#define GREET_H\nvoid greet_a(void);\nvoid greet_b(void);\n#endif\n';
const greetAC = '#include <stdio.h>\n#include "greet.h"\nvoid greet_a(void){printf("greet_a\\n");fflush(stdout);}\n';
const greetBC = '#include <stdio.h>\n#include "greet.h"\nvoid greet_b(void){printf("greet_b\\n");fflush(stdout);}\n';
const mainC = '#include "greet.h"\nint main(void){greet_a();greet_b();return 0;}\n';

await t.run(heredocCommand('greet.h', greetH), 10_000);
await t.run(heredocCommand('greet_a.c', greetAC), 10_000);
await t.run(heredocCommand('greet_b.c', greetBC), 10_000);
await t.run(heredocCommand('main.c', mainC), 10_000);

const rc = await t.run('clang main.c greet_a.c greet_b.c -o multi', 240_000);
const out1 = stripAnsi(rc.output);
a.check('greet.h resolves (no "file not found")', !/file not found/i.test(out1),
  JSON.stringify(out1.slice(-400)));
a.check('compile/link succeeds (no error: line)', !/error:/i.test(out1),
  JSON.stringify(out1.slice(-400)));
a.check('no "undefined symbol" link errors', !/undefined symbol/i.test(out1),
  JSON.stringify(out1.slice(-400)));

// Verify output is a wasm binary via shell + node existsSync.
const rExists = await t.run(
  `node -e "console.log('exists=', require('fs').existsSync('multi'))"`, 15_000);
a.check('multi binary exists in cwd', /exists= true/.test(stripAnsi(rExists.output)),
  JSON.stringify(stripAnsi(rExists.output).slice(-200)));

const rr = await t.run('./multi ; echo RUN_EXIT=$?', 30_000);
const out2 = stripAnsi(rr.output);
a.check('./multi prints "greet_a"', /greet_a/.test(out2), JSON.stringify(out2.slice(-300)));
a.check('./multi prints "greet_b"', /greet_b/.test(out2), JSON.stringify(out2.slice(-300)));
a.check('./multi exits 0', /RUN_EXIT=0/.test(out2), JSON.stringify(out2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
