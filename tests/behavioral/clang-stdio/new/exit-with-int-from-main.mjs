#!/usr/bin/env bun
// clang-stdio/new/exit-with-int-from-main — returning a non-zero int
// from main propagates to the shell as the exit code. The v13 crt1
// canonical pattern: if (r != 0) __wasi_proc_exit(r); else fall off
// _start (= host-clean-exit which equals rc=0).
//
// Implementation note: each "case" mints its OWN session because of a
// pre-existing clang-runner facet-state-reuse bug surfaced during v13
// prod-verify. When the SAME session sequentially compiles two .c
// files of similar trivial shape, the second compile produces a
// byte-identical .wasm to the first (verified via readFileSync hex
// dump: both 6856-byte binaries with identical first-16-byte heads).
// Different sessions get different child-facets and the bug doesn't
// fire. The bug lives in clang-runner.ts (anti-touch this wave) — a
// follow-up wave can investigate the loader-pool warm-isolate state
// leakage path. Captured as a documented limitation in the wave
// verdict (.seal-internal/2026-05-11-v13-crt1/).

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-stdio/new/exit-with-int-from-main');

async function runCase(name, csrc, binName, expectedStdout, expectedRc) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(15_000);
  await t.run('nimbus install clang', 300_000);
  await t.run(heredocCommand(`${binName}.c`, csrc), 10_000);
  await t.run(`clang ${binName}.c -o ${binName}`, 240_000);
  const r = await t.run(`./${binName} ; echo RUN_EXIT=$?`, 30_000);
  const out = stripAnsi(r.output);
  a.check(`${name} → ${expectedStdout} printed`,
    new RegExp(expectedStdout).test(out), JSON.stringify(out.slice(-300)));
  a.check(`${name} → RUN_EXIT=${expectedRc}`,
    new RegExp(`RUN_EXIT=${expectedRc}\\b`).test(out), JSON.stringify(out.slice(-200)));
  await t.close();
}

await runCase('return 0', '#include <stdio.h>\nint main(void){printf("Z\\n");return 0;}\n', 'z', 'Z', '0');
await runCase('return 7', '#include <stdio.h>\nint main(void){printf("S\\n");return 7;}\n', 's', 'S', '7');
await runCase('return 137', '#include <stdio.h>\nint main(void){printf("H\\n");return 137;}\n', 'h', 'H', '137');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
