#!/usr/bin/env bun
// clang-state/new/sequential-compile-distinct-binaries — THE bug fix.
//
// PRE-fix (prod 46a95b36): compile a.c (printf XAPPLE; return 7) then
// b.c (printf YBANAN; return 11) in the SAME session, run each:
//   ./a → XAPPLE (rc=7)         ✓
//   ./b → XAPPLE (rc=7)         ✗ — should be YBANAN (rc=11)
// Verified via readFileSync: ./b BINARY contains "YBANAN" (correct
// content), but executing it serves the FIRST binary's WebAssembly
// .Module because the loader-pool warm-isolate cache key collided.
//
// Root cause: src/loaders/loader-pool.ts:#fingerprintWasm used
// `name + len + first + last` to fingerprint per-call wasm modules.
// Two distinct-but-similar binaries (same length, same magic-byte
// start, same trailer end) collided. Cache returned the FIRST
// isolate's WebAssembly.Module.
//
// Fix: djb2-hash the full bytes. Per-call wasm is typically <few MiB
// (user-compiled binaries), hashing is microseconds.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-state/new/sequential-compile-distinct-binaries');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
await t.run('nimbus install clang', 300_000);

// Compile two distinct programs in the SAME session.
await t.run(heredocCommand('a.c',
  '#include <stdio.h>\nint main(void){printf("XAPPLE\\n");return 7;}\n'), 10_000);
await t.run('clang a.c -o a', 240_000);

await t.run(heredocCommand('b.c',
  '#include <stdio.h>\nint main(void){printf("YBANAN\\n");return 11;}\n'), 10_000);
await t.run('clang b.c -o b', 240_000);

// Run each and assert distinct, correct behavior.
const rA = await t.run('./a ; echo A_RC=$?', 30_000);
const outA = stripAnsi(rA.output);
a.check('./a prints XAPPLE', /XAPPLE/.test(outA), JSON.stringify(outA.slice(-300)));
a.check('./a → A_RC=7', /A_RC=7\b/.test(outA), JSON.stringify(outA.slice(-200)));

const rB = await t.run('./b ; echo B_RC=$?', 30_000);
const outB = stripAnsi(rB.output);
a.check('./b prints YBANAN (NOT XAPPLE — bug fix)', /YBANAN/.test(outB),
  JSON.stringify(outB.slice(-300)));
a.check('./b does NOT print XAPPLE (state leakage check)', !/XAPPLE/.test(outB),
  JSON.stringify(outB.slice(-300)));
a.check('./b → B_RC=11 (distinct from A)', /B_RC=11\b/.test(outB),
  JSON.stringify(outB.slice(-200)));

// Run in reverse order too — ./a should still print XAPPLE after ./b.
const rA2 = await t.run('./a ; echo A2_RC=$?', 30_000);
const outA2 = stripAnsi(rA2.output);
a.check('./a after ./b still prints XAPPLE (state didn\'t flip)', /XAPPLE/.test(outA2),
  JSON.stringify(outA2.slice(-300)));
a.check('./a after ./b → A2_RC=7', /A2_RC=7\b/.test(outA2), JSON.stringify(outA2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
