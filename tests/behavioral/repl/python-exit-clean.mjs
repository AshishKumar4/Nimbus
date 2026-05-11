#!/usr/bin/env bun
// repl/python-exit-clean — exit() / sys.exit() returns to the shell
// with $? === 0; sys.exit(7) returns $? === 7.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-exit-clean');
console.log(`repl/python-exit-clean — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

// Subcase 1: exit() → $? === 0.
{
  t.reset();
  t.cmd('python');
  await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');
  t.cmd('exit()');
  await t.waitForPrompt(15_000);
  const { output } = await t.run('echo "EX=$?"', 10_000);
  const m = stripAnsi(output).match(/EX=(\d+)/);
  const got = m ? parseInt(m[1], 10) : -1;
  a.check('exit() → shell $? === 0', got === 0, `got=${got}`);
}

// Subcase 2: sys.exit(7) → $? === 7.
{
  t.reset();
  t.cmd('python');
  await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');
  t.cmd('import sys; sys.exit(7)');
  await t.waitForPrompt(15_000);
  const { output } = await t.run('echo "EX=$?"', 10_000);
  const m = stripAnsi(output).match(/EX=(\d+)/);
  const got = m ? parseInt(m[1], 10) : -1;
  a.check('sys.exit(7) → shell $? === 7', got === 7, `got=${got}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
