#!/usr/bin/env bun
// python/script-file — `python t.py` reads + runs a script from VFS.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/script-file');
console.log(`python/script-file — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

// Write a script via heredoc.
const scriptPy = `print("from-script")
import sys
print("argv0=" + sys.argv[0])
`;
await t.run(heredocCommand('t.py', scriptPy), 15_000);

// Run it. Expect: "from-script" + "argv0=t.py".
{
  const { output, elapsed } = await t.run('python t.py', 120_000);
  const stripped = stripAnsi(output);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  const hasFromScript = lines.includes('from-script');
  a.check('python t.py prints "from-script"', hasFromScript,
    hasFromScript ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
  const hasArgv = lines.some((l) => l === 'argv0=t.py');
  a.check('python t.py: sys.argv[0] === "t.py"', hasArgv,
    hasArgv ? '' : JSON.stringify(stripped.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
