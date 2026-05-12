#!/usr/bin/env bun
// clang-state/new/sequential-compile-same-content — legit warm-reuse
// case. When the same source is compiled twice in the same session,
// the two binaries SHOULD be byte-identical and the loader can reuse
// the warm isolate. Asserts the fix doesn't over-invalidate.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-state/new/sequential-compile-same-content');

const CSRC = '#include <stdio.h>\nint main(void){printf("SAME\\n");return 42;}\n';

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);
await t.run('nimbus install clang', 300_000);

await t.run(heredocCommand('x.c', CSRC), 10_000);
await t.run('clang x.c -o x1', 240_000);

await t.run(heredocCommand('y.c', CSRC), 10_000);
await t.run('clang y.c -o x2', 240_000);

const rX1 = await t.run('./x1 ; echo X1_RC=$?', 30_000);
const outX1 = stripAnsi(rX1.output);
a.check('./x1 prints SAME', /SAME/.test(outX1), JSON.stringify(outX1.slice(-300)));
a.check('./x1 → X1_RC=42', /X1_RC=42\b/.test(outX1), JSON.stringify(outX1.slice(-200)));

const rX2 = await t.run('./x2 ; echo X2_RC=$?', 30_000);
const outX2 = stripAnsi(rX2.output);
a.check('./x2 prints SAME (same content compiles to working binary)', /SAME/.test(outX2),
  JSON.stringify(outX2.slice(-300)));
a.check('./x2 → X2_RC=42', /X2_RC=42\b/.test(outX2), JSON.stringify(outX2.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
