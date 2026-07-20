#!/usr/bin/env bun
// clang-includes/new/function-prototype-in-header — header declares a
// function prototype; one .c provides the definition, another calls it.
// Validates the full multi-TU + shared-header workflow (the canonical
// real-C user experience).

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-includes/new/function-prototype-in-header');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('nimbus install clang', 300_000);

const mathH = '#ifndef MATH_H_USER\n#define MATH_H_USER\nint sum3(int a, int b, int c);\n#endif\n';
const mathC = '#include "math.h.user.h"\nint sum3(int a, int b, int c){return a+b+c;}\n';
const mainC = '#include <stdio.h>\n#include "math.h.user.h"\nint main(void){printf("S=%d\\n",sum3(10,20,30));fflush(stdout);return 0;}\n';

await t.run(heredocCommand('math.h.user.h', mathH), 10_000);
await t.run(heredocCommand('math.c', mathC), 10_000);
await t.run(heredocCommand('app.c', mainC), 10_000);

// The output must not be named `app`: every session pre-seeds a starter
// project DIRECTORY at /home/user/app, and POSIX open(2) of an existing
// directory for writing is EISDIR — real clang refuses to link onto it.
// (The legacy VFS silently converted the seeded directory into the
// output file; the permissions work restored real Unix semantics. The
// collision case is pinned as a regression check below.)
const rc = await t.run('clang app.c math.c -o sum3demo', 240_000);
const out1 = stripAnsi(rc.output);
a.check('compile + link succeed', !/error:/i.test(out1), JSON.stringify(out1.slice(-400)));
a.check('no "undefined symbol: sum3"', !/undefined symbol.*sum3/i.test(out1), JSON.stringify(out1.slice(-400)));

const rr = await t.run('./sum3demo ; echo RUN_EXIT=$?', 30_000);
const out2 = stripAnsi(rr.output);
a.check('./sum3demo prints "S=60" (10+20+30)', /S=60/.test(out2), JSON.stringify(out2.slice(-300)));
a.check('./sum3demo exits 0', /RUN_EXIT=0/.test(out2), JSON.stringify(out2.slice(-200)));

// Regression: linking onto an existing directory fails honestly and does
// NOT destroy it (pre-permissions VFS clobbered the seeded project dir).
const rd = await t.run('clang app.c math.c -o app ; echo CC_EXIT=$?', 240_000);
const out3 = stripAnsi(rd.output);
a.check('link onto existing dir exits nonzero', /CC_EXIT=[1-9]/.test(out3), JSON.stringify(out3.slice(-300)));
a.check('link onto existing dir reports EISDIR', /EISDIR|is a directory|unable to open/i.test(out3), JSON.stringify(out3.slice(-300)));
const rl = await t.run('test -d /home/user/app && test -f /home/user/app/package.json && echo DIR=intact || echo DIR=lost', 15_000);
a.check('seeded /home/user/app survives the refused link', /DIR=intact/.test(stripAnsi(rl.output)), JSON.stringify(stripAnsi(rl.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
