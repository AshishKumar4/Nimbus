#!/usr/bin/env bun
// python/pip-install-pure-wheel — pip installs a Pyodide-compatible pure
// Python wheel and the installed package imports in a later Python command.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/pip-install-pure-wheel';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

{
  const { output } = await t.run('pip install packaging', 180_000);
  const stripped = stripAnsi(output);
  a.check('pip install resolves and installs a pure Python wheel',
    /Successfully installed packaging/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

{
  const { output } = await t.run('test -f /home/user/.nimbus-python/site-packages/packaging/__init__.py && echo PERSISTED', 20_000);
  const stripped = stripAnsi(output);
  a.check('installed wheel files persist in the Nimbus VFS',
    /PERSISTED/.test(stripped),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('python -c "from packaging.version import Version; print(\'PKG_VERSION=\' + str(Version(\'7.8.9\')))"', 120_000);
  const stripped = stripAnsi(output);
  a.check('installed wheel imports in a later Python command',
    /PKG_VERSION=7\.8\.9/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
