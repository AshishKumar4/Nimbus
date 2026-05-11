#!/usr/bin/env bun
// python/hello-world — the defining "second-runtime" demo:
//   nimbus install python && python -c 'print("hi")'
// must print exactly "hi\n" on PROD.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/hello-world');
console.log(`python/hello-world — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Install (idempotent).
await t.run('nimbus install python', 180_000);

// 1. python is registered (not 'command not found').
{
  const { output, elapsed } = await t.run(`python --version`, 60_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/python: command not found/.test(stripped);
  a.check('python is a registered shell command', notCmdNotFound,
    notCmdNotFound ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-300)));
  const isVersion = /Python 3\.13/.test(stripped);
  a.check('python --version reports Python 3.13', isVersion,
    isVersion ? '' : JSON.stringify(stripped.slice(-200)));
}

// 2. python -c 'print("hi")' prints exactly "hi".
{
  const { output, elapsed } = await t.run(`python -c 'print("hi")'`, 120_000);
  const stripped = stripAnsi(output);
  // The output between the command echo and the next prompt should
  // contain "hi" on its own line.
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  // Find the "hi" line that isn't part of the command echo or prompt.
  const hasHi = lines.some((l) => l === 'hi');
  a.check('python -c \'print("hi")\' prints "hi"', hasHi,
    hasHi ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
