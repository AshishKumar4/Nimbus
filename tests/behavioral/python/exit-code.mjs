#!/usr/bin/env bun
// python/exit-code — sys.exit(N) surfaces as the shell's $? variable.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/exit-code');
console.log(`python/exit-code — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

// sys.exit(7) → $? should be 7.
{
  const { output: out1 } = await t.run(`python -c 'import sys; sys.exit(7)'`, 120_000);
  // Then echo $? to read the exit code from the shell.
  const { output: out2 } = await t.run('echo "EXIT=$?"', 10_000);
  const stripped = stripAnsi(out2);
  const has7 = /EXIT=7/.test(stripped);
  a.check('sys.exit(7) → shell $? === 7', has7,
    has7 ? '' : `out1=${JSON.stringify(stripAnsi(out1).slice(-200))} out2=${JSON.stringify(stripped.slice(-200))}`);
}

// sys.exit(0) → $? should be 0.
{
  await t.run(`python -c 'import sys; sys.exit(0)'`, 60_000);
  const { output } = await t.run('echo "EXIT=$?"', 10_000);
  const stripped = stripAnsi(output);
  const has0 = /EXIT=0/.test(stripped);
  a.check('sys.exit(0) → shell $? === 0', has0,
    has0 ? '' : JSON.stringify(stripped.slice(-200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
