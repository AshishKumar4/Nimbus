#!/usr/bin/env bun
// ruby/exit-code — exit(N) sets the shell $? to N. Required for
// shell-pipeline integration.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('ruby/exit-code');
console.log(`ruby/exit-code — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install ruby', 180_000);

// 1. exit(7) → $? === 7
{
  await t.run(`ruby -e 'exit 7'`, 60_000);
  const { output } = await t.run(`echo "EXIT=$?"`, 10_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/EXIT=(\d+)/);
  const got = m ? parseInt(m[1], 10) : -1;
  a.check('exit 7 → shell $? === 7', got === 7, `got=${got}`);
}

// 2. exit(0) → $? === 0
{
  await t.run(`ruby -e 'exit 0'`, 60_000);
  const { output } = await t.run(`echo "EXIT=$?"`, 10_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/EXIT=(\d+)/);
  const got = m ? parseInt(m[1], 10) : -1;
  a.check('exit 0 → shell $? === 0', got === 0, `got=${got}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
