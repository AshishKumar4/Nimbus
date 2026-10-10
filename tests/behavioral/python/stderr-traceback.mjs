#!/usr/bin/env bun
// python/stderr-traceback — uncaught exception prints a traceback to
// stderr and exits 1.

import { mintSession, deleteSession, heredocCommand, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/stderr-traceback');
console.log(`python/stderr-traceback — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

// `python -c '1/0'` raises ZeroDivisionError.
{
  const { output, elapsed } = await t.run(`python -c '1/0'`, 120_000);
  const stripped = stripAnsi(output);
  const hasZDE = /ZeroDivisionError/.test(stripped);
  a.check('python -c \'1/0\' surfaces ZeroDivisionError on stderr',
    hasZDE, hasZDE ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

// $? should be 1 after the exception.
{
  const { output } = await t.run('echo "EXIT=$?"', 10_000);
  const stripped = stripAnsi(output);
  const has1 = /EXIT=1/.test(stripped);
  a.check('uncaught exception → shell $? === 1', has1,
    has1 ? '' : JSON.stringify(stripped.slice(-200)));
}

// Runtime setup must not shift the user's traceback line numbers.
await t.run(heredocCommand('/home/user/traceback-lines.py', 'value = 1\nraise RuntimeError("user line two")\n'), 30_000);
const failed = stripAnsi((await t.run('python /home/user/traceback-lines.py', 120_000)).output);
a.check('traceback reports line 2 of the actual user program, not setup code',
  /File "<string>", line 2, in <module>/.test(failed) && /RuntimeError: user line two/.test(failed), failed);

await t.close();
a.check('probe session deleted', (await deleteSession(sid)).ok);
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
