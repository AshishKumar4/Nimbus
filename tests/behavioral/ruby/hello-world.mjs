#!/usr/bin/env bun
// ruby/hello-world — the defining "third-runtime" demo:
//   nimbus install ruby && ruby -e 'puts "hi"'
// must print exactly "hi\n" on PROD.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('ruby/hello-world');
console.log(`ruby/hello-world — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Install (idempotent).
await t.run('nimbus install ruby', 180_000);

// 1. ruby is registered (not 'command not found').
{
  const { output, elapsed } = await t.run(`ruby --version`, 60_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/ruby: command not found/.test(stripped);
  a.check('ruby is a registered shell command', notCmdNotFound,
    notCmdNotFound ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-300)));
  const isVersion = /ruby 3\.3/.test(stripped);
  a.check('ruby --version reports Ruby 3.3', isVersion,
    isVersion ? '' : JSON.stringify(stripped.slice(-200)));
}

// 2. ruby -e 'puts "hi"' prints exactly "hi".
{
  const { output, elapsed } = await t.run(`ruby -e 'puts "hi"'`, 120_000);
  const stripped = stripAnsi(output);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  const hasHi = lines.some((l) => l === 'hi');
  a.check('ruby -e \'puts "hi"\' prints "hi"', hasHi,
    hasHi ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
