#!/usr/bin/env bun
// clang-includes/new/compile-only-c-flag — `clang -c foo.c -o foo.o`
// produces an object file (no link). Validates the -c short-circuit
// added by the multi-TU rework.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/new/compile-only-c-flag');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);
await t.run(heredocCommand('foo.c',
  '#include <stdio.h>\nint adder(int x){return x+1;}\n'), 10_000);

const rc = await t.run('clang -c foo.c -o foo.o', 240_000);
const out1 = stripAnsi(rc.output);
a.check('-c compile produces no errors', !/error:/i.test(out1), JSON.stringify(out1.slice(-400)));
a.check('no link step performed (no missing main)', !/undefined.*main/i.test(out1),
  JSON.stringify(out1.slice(-400)));

// Verify foo.o exists with reasonable size (>100 B for a real wasm
// object). Use `wc -c` which is robust against shell-quote hazards.
const r = await t.run('wc -c foo.o', 15_000);
const out2 = stripAnsi(r.output);
const m = out2.match(/(\d+)\s+foo\.o/);
const sizeNum = m ? parseInt(m[1], 10) : 0;
a.check('foo.o exists with reasonable size (>100B)', sizeNum > 100,
  sizeNum > 100 ? `size=${sizeNum}` : JSON.stringify(out2.slice(-200)));

// Now link the .o into a real program using a separate main.c.
// fflush per Stream-C v12 follow-up note.
await t.run(heredocCommand('drv.c',
  '#include <stdio.h>\nint adder(int);\nint main(void){printf("R=%d\\n",adder(41));fflush(stdout);return 0;}\n'),
  10_000);
const rl = await t.run('clang drv.c foo.o -o drv', 240_000);
const out3 = stripAnsi(rl.output);
a.check('link drv.c + foo.o succeeds', !/error:/i.test(out3) && !/undefined symbol/i.test(out3),
  JSON.stringify(out3.slice(-400)));

const rr = await t.run('./drv ; echo RUN_EXIT=$?', 30_000);
const out4 = stripAnsi(rr.output);
a.check('./drv prints R=42', /R=42/.test(out4), JSON.stringify(out4.slice(-300)));
a.check('./drv exits 0', /RUN_EXIT=0/.test(out4), JSON.stringify(out4.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
