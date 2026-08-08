#!/usr/bin/env bun
// python/pip-command — Python runtime exposes pip/pip3 and python -m pip
// through the Nimbus package bridge instead of command-not-found stubs.
//
// The version banner these assert on changed with the interpreter: `python` is
// CPython 3.13 on wasm32-wasi now, not Pyodide, so a bridge that announced
// "Pyodide 0.29.4" was naming an implementation that is no longer there. The
// behaviour under test is unchanged — pip and pip3 are real commands, and
// `python -m pip` is not swallowed by `python --version` — so only the string
// moved.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/pip-command';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

{
  const { output } = await t.run('which pip && which pip3', 20_000);
  const stripped = stripAnsi(output);
  a.check('pip and pip3 are registered runtime commands',
    /\/usr\/bin\/pip/.test(stripped) && /\/usr\/bin\/pip3/.test(stripped),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('pip --version', 120_000);
  const stripped = stripAnsi(output);
  a.check('pip --version reports the Nimbus package bridge',
    /Nimbus package bridge for CPython 3\.13/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('python -m pip --version', 120_000);
  const stripped = stripAnsi(output);
  a.check('python -m pip --version is not intercepted by python --version',
    /Nimbus package bridge for CPython 3\.13/.test(stripped) && !/^Python 3\.13/m.test(stripped.trim()),
    JSON.stringify(stripped.slice(-800)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
