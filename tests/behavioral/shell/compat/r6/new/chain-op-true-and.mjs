#!/usr/bin/env bun
// shell/compat/r6/new/chain-op-true-and — SHELL-R6-B1 regression-sibling.
//
// The basic `true && X` and `cmd1 && cmd2` chains MUST keep working
// post-fix (they were the only chain forms that worked pre-fix). Probes
// any-regression of the simple cases.

import { mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r6/new/chain-op-true-and');
console.log(`shell/compat/r6/new/chain-op-true-and — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const r1 = await t.run('true && echo X', 5_000);
a.check('true && X → "X"', termBody(r1.output) === 'X', `body=${JSON.stringify(termBody(r1.output))}`);

const r2 = await t.run('false && echo X', 5_000);
a.check('false && X → empty', termBody(r2.output) === '', `body=${JSON.stringify(termBody(r2.output))}`);

const r3 = await t.run('true && echo A && echo B', 5_000);
a.check('true && A && B → "A\\nB"',
  termBody(r3.output).split(/\r?\n/).filter(Boolean).join(',') === 'A,B',
  `body=${JSON.stringify(termBody(r3.output))}`);

const r4 = await t.run('true && true && echo OK', 5_000);
a.check('true && true && OK → "OK"',
  termBody(r4.output) === 'OK',
  `body=${JSON.stringify(termBody(r4.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
