#!/usr/bin/env bun
// ruby/stderr-traceback — uncaught exceptions surface via stderr with
// a traceback; shell $? is non-zero.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('ruby/stderr-traceback');
console.log(`ruby/stderr-traceback — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install ruby', 180_000);

{
  const { output } = await t.run(`ruby -e 'raise "boom"'`, 60_000);
  const stripped = stripAnsi(output);
  const hasErrorMarker = /RuntimeError|boom/.test(stripped);
  a.check('ruby -e \'raise "boom"\' surfaces RuntimeError on stderr',
    hasErrorMarker, JSON.stringify(stripped.slice(-400)));
}

{
  const { output } = await t.run(`echo "EXIT=$?"`, 10_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/EXIT=(\d+)/);
  const got = m ? parseInt(m[1], 10) : -1;
  a.check('uncaught exception → shell $? === 1', got === 1, `got=${got}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
