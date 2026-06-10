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

// The shared prompt matcher accepts `>` so it also fires on the Python
// `>>> ` REPL prompt. After sending an exit statement we must wait for
// the SHELL prompt specifically (ends in `$`/`#`, not `>`); otherwise
// the still-present `>>> ` satisfies waitForPrompt and the follow-up
// `echo` is delivered into the live REPL as a second statement.
const shellPromptReturned = (b) => /[$#]\s*$/.test(b.trimEnd().slice(-3));

async function replExitCode(statement) {
  t.reset();
  t.cmd('python');
  await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');
  t.reset();
  t.cmd(statement);
  await t.waitFor(shellPromptReturned, 15_000, 'shell prompt after REPL exit');
  t.reset();
  t.cmd('echo "EX=$?"');
  await t.waitFor((b) => /EX=\d+/.test(b), 10_000, 'EX echo');
  const m = stripAnsi(t.buf).match(/EX=(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

// Subcase 1: exit() → $? === 0.
{
  const got = await replExitCode('exit()');
  a.check('exit() → shell $? === 0', got === 0, `got=${got}`);
}

// Subcase 2: sys.exit(7) → $? === 7.
{
  const got = await replExitCode('import sys; sys.exit(7)');
  a.check('sys.exit(7) → shell $? === 7', got === 7, `got=${got}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
