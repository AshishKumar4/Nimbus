#!/usr/bin/env bun
// shell-r6/new/chain-op-true-and — SHELL-R6-B1 regression-sibling.
//
// The basic `true && X` and `cmd1 && cmd2` chains MUST keep working
// post-fix (they were the only chain forms that worked pre-fix). Probes
// any-regression of the simple cases.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r6/new/chain-op-true-and');
console.log(`shell-r6/new/chain-op-true-and — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

const r1 = await t.run('true && echo X', 5_000);
a.check('true && X → "X"', body(r1.output) === 'X', `body=${JSON.stringify(body(r1.output))}`);

const r2 = await t.run('false && echo X', 5_000);
a.check('false && X → empty', body(r2.output) === '', `body=${JSON.stringify(body(r2.output))}`);

const r3 = await t.run('true && echo A && echo B', 5_000);
a.check('true && A && B → "A\\nB"',
  body(r3.output).split(/\r?\n/).filter(Boolean).join(',') === 'A,B',
  `body=${JSON.stringify(body(r3.output))}`);

const r4 = await t.run('true && true && echo OK', 5_000);
a.check('true && true && OK → "OK"',
  body(r4.output) === 'OK',
  `body=${JSON.stringify(body(r4.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
