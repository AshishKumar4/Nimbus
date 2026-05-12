#!/usr/bin/env bun
// clang-state/new/sequential-compile-mtu-link — sequential multi-TU
// compiles must each produce a distinct, correct binary. Exercises
// the multi-step compile-then-link pipeline from clang-include-fix
// wave under SEQUENTIAL invocations.
//
// To exercise the loader-pool warm-isolate path AND avoid long-running
// session WS-drop flakiness on Nimbus, this probe compiles each pair
// in its own session, then a THIRD session runs both binaries
// (writes them via shell from base64 staging, asserts distinct
// outputs). The bug — if present — would manifest as both binaries
// producing the SAME output regardless of source (verified pre-fix
// via XAPPLE/YBANAN in sequential-compile-distinct-binaries.mjs).
//
// This probe specifically validates the multi-TU pipeline (compile
// + wasm-ld link, two .c files per invocation) under sequential
// dispatch — separate from the single-TU case.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-state/new/sequential-compile-mtu-link');

async function compileMtu(headerName, headerBody, libBody, mainBody, outName) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(15_000);
  await t.run('nimbus install clang', 300_000);
  await t.run(heredocCommand(headerName, headerBody), 10_000);
  await t.run(heredocCommand('lib.c', libBody), 10_000);
  await t.run(heredocCommand('main.c', mainBody), 10_000);
  const rc = await t.run(`clang main.c lib.c -o ${outName}`, 240_000);
  const compileOK = !/error:/i.test(stripAnsi(rc.output));
  a.check(`${outName} compile+link succeeds`, compileOK,
    compileOK ? '' : JSON.stringify(stripAnsi(rc.output).slice(-400)));
  const rr = await t.run(`./${outName} ; echo ${outName.toUpperCase()}_RC=$?`, 30_000);
  await t.close();
  return stripAnsi(rr.output);
}

// Round 1: greet.h declares g_one; lib.c defines g_one(prints ONE);
// main.c calls g_one and returns 0.
const outOne = await compileMtu(
  'greet.h',
  '#ifndef G\n#define G\nvoid g_one(void);\n#endif\n',
  '#include <stdio.h>\n#include "greet.h"\nvoid g_one(void){printf("ONE\\n");fflush(stdout);}\n',
  '#include "greet.h"\nint main(void){g_one();return 0;}\n',
  'one',
);
a.check('./one prints ONE', /ONE/.test(outOne), JSON.stringify(outOne.slice(-300)));
a.check('./one → ONE_RC=0', /ONE_RC=0\b/.test(outOne), JSON.stringify(outOne.slice(-200)));

// Round 2: different greet2.h + different function name + different rc.
const outTwo = await compileMtu(
  'greet2.h',
  '#ifndef G2\n#define G2\nvoid g_two(void);\n#endif\n',
  '#include <stdio.h>\n#include "greet2.h"\nvoid g_two(void){printf("TWO\\n");fflush(stdout);}\n',
  '#include "greet2.h"\nint main(void){g_two();return 5;}\n',
  'two',
);
a.check('./two prints TWO (NOT ONE — sequential state isolated)',
  /TWO/.test(outTwo), JSON.stringify(outTwo.slice(-300)));
a.check('./two does NOT print ONE (leakage check)',
  !/\bONE\b/.test(outTwo), JSON.stringify(outTwo.slice(-300)));
a.check('./two → TWO_RC=5 (distinct from ./one)',
  /TWO_RC=5\b/.test(outTwo), JSON.stringify(outTwo.slice(-200)));

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
