#!/usr/bin/env bun
// clang-includes/new/multi-printf-needs-fflush — documents a v12-crt1
// limitation orthogonal to the include-fix wave but exposed by multi-TU
// probes: programs that call multiple printf()s and return from main
// WITHOUT an explicit fflush(stdout) may lose buffered output after the
// first \n flush, because the v12 crt1 calls __wasi_proc_exit directly
// instead of going through libc's exit()→__cxa_finalize→stdio cleanup
// chain.
//
// This probe asserts both halves:
//   1. fflush(stdout) at the end makes ALL stdout output appear (the
//      contract real C code can use today).
//   2. without fflush, only the first \n line appears (current
//      observable behavior — documented as known-limitation; will be
//      fixed in a follow-up Stream-C v13 crt1 that calls exit()).

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/new/multi-printf-needs-fflush');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);

// Case A: with fflush — both lines must appear.
await t.run(heredocCommand('a.c',
  '#include <stdio.h>\nint main(void){printf("LINE1\\n");printf("LINE2\\n");fflush(stdout);return 0;}\n'),
  10_000);
await t.run('clang a.c -o a', 240_000);
const ra = await t.run('./a ; echo RUN_EXIT=$?', 30_000);
const outA = stripAnsi(ra.output);
a.check('with fflush: LINE1 printed', /LINE1/.test(outA), JSON.stringify(outA.slice(-300)));
a.check('with fflush: LINE2 printed', /LINE2/.test(outA), JSON.stringify(outA.slice(-300)));
a.check('with fflush: exits 0', /RUN_EXIT=0/.test(outA), JSON.stringify(outA.slice(-200)));

// Case B: known-limitation — without fflush only first line appears.
await t.run(heredocCommand('b.c',
  '#include <stdio.h>\nint main(void){printf("L1_NO_FLUSH\\n");printf("L2_NO_FLUSH\\n");return 0;}\n'),
  10_000);
await t.run('clang b.c -o b', 240_000);
const rb = await t.run('./b ; echo RUN_EXIT=$?', 30_000);
const outB = stripAnsi(rb.output);
a.check('no fflush: first line printed (line-buffered first \\n flush)', /L1_NO_FLUSH/.test(outB),
  JSON.stringify(outB.slice(-300)));
a.check('no fflush: exits 0 (graceful, just buffered tail lost)', /RUN_EXIT=0/.test(outB),
  JSON.stringify(outB.slice(-200)));
// Document the known-limitation: second line is lost. NOT asserted as
// pass-or-fail because the desired long-term behaviour is for L2 to
// also print (after crt1 v13 lands). Today the probe records the
// behaviour but doesn't fail on it.
const l2Missing = !/L2_NO_FLUSH/.test(outB);
console.log(`  (known-limit) no-fflush: L2 ${l2Missing ? 'MISSING (v12 crt1 limitation)' : 'PRESENT (good — crt1 fixed)'}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
