#!/usr/bin/env bun
// python/install-python3-alias — `python3` gives an install hint before
// install, and `nimbus install python3` installs the Python runtime.
//
// The install used to be pinned to ~/.nimbus/runtimes/python/0.29.4. That is
// the superseded Pyodide entry: it still declares `python` and `python3`, it
// still comes first in the catalog, and its runner is no longer registered — so
// the assertion held while the install laid down two bins nothing could invoke,
// which is what the rest of this probe then failed on. `nimbus install python3`
// resolves to the same CPython runtime `nimbus install python` does now, and
// the paths below say so.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/install-python3-alias';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

{
  const { output } = await t.run('python3 --version', 30_000);
  const stripped = stripAnsi(output);
  a.check('python3 before install shows nimbus install hint',
    /python3: command not found/.test(stripped)
      && /hint: install it with: nimbus install python3/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

{
  const { output } = await t.run('which python3', 30_000);
  const stripped = stripAnsi(output);
  a.check('which python3 reports the installable runtime hint path',
    /\/usr\/bin\/python3/.test(stripped) && !/which: no python3/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

{
  const { output } = await t.run('nimbus install python3', 180_000);
  const stripped = stripAnsi(output);
  a.check('nimbus install python3 installs canonical python runtime',
    /installed at .*\/\.nimbus\/runtimes\/cpython\/3\.13\.14/.test(stripped)
      && !/runner '[^']*' not registered/.test(stripped),
    JSON.stringify(stripped.slice(-500)));
}

{
  t.reset();
  const started = Date.now();
  t.cmd('python3');
  await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python3 repl prompt');
  const elapsed = Date.now() - started;
  a.check('python3 REPL prompt is warm after install',
    elapsed < 2_000,
    `elapsed=${elapsed}ms tail=${JSON.stringify(stripAnsi(t.buf).slice(-200))}`);
  t.reset();
  t.cmd('exit()');
  await t.waitForPrompt(15_000);
}

{
  const { elapsed, output } = await t.run(`python3 -c 'print("alias-ok")'`, 120_000);
  const stripped = stripAnsi(output);
  a.check('python3 works after alias install',
    /\balias-ok\b/.test(stripped) && !/command not found/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
  a.check('python3 one-shot is warm after install',
    elapsed < 1_500,
    `elapsed=${elapsed}ms`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
