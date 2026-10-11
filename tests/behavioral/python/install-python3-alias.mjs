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
// Each one-shot opens its own PID-bound facet; installation does not promise
// interpreter reuse or a sub-second wall-clock latency for another process.

import { mintSession, Terminal, makeAsserter, stripAnsi, hasOutputLine } from '../_driver.mjs';

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
  console.log(`python3 REPL prompt: ${elapsed}ms`);
  t.reset();
  t.cmd('alias_state = 41; print(alias_state + 1)');
  await t.waitFor((b) => hasOutputLine(b, '42'), 30_000, 'python3 REPL expression');
  a.check('python3 REPL evaluates an expression after alias install',
    hasOutputLine(t.buf, '42'), JSON.stringify(stripAnsi(t.buf).slice(-200)));
  t.reset();
  t.cmd('exit()');
  await t.waitForPrompt(15_000);
}

{
  const { elapsed, output, exitCode } = await t.run(`python3 -c 'alias_state = 99; print("alias-ok")'`, 120_000);
  const stripped = stripAnsi(output);
  console.log(`python3 alias one-shot: ${elapsed}ms`);
  a.check('python3 works after alias install',
    exitCode === 0 && hasOutputLine(stripped, 'alias-ok'),
    `exit=${exitCode} tail=${JSON.stringify(stripped.slice(-300))}`);
}

{
  const { elapsed, output, exitCode } = await t.run(`python3 -c 'print(globals().get("alias_state", "independent-ok"))'`, 120_000);
  console.log(`python3 independent one-shot: ${elapsed}ms`);
  a.check('python3 one-shots have independent interpreter state',
    exitCode === 0 && hasOutputLine(output, 'independent-ok'),
    `exit=${exitCode} tail=${JSON.stringify(output.slice(-300))}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
