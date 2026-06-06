#!/usr/bin/env bun
// python/pip-requirements-and-local-wheel — pip supports requirements files
// and local VFS wheels, and rejects native Linux wheels before install.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/pip-requirements-and-local-wheel';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);
await t.run('mkdir -p /home/user/py-pip && cd /home/user/py-pip', 10_000);

await t.run(heredocCommand('requirements.txt', 'packaging\n'), 10_000);
{
  const { output } = await t.run('pip install -r requirements.txt', 180_000);
  const stripped = stripAnsi(output);
  a.check('pip install -r installs requirements from VFS',
    /Successfully installed packaging/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.run(heredocCommand('make_wheel.py', [
  'import zipfile',
  'wheel = "nimbus_local_pkg-0.1.0-py3-none-any.whl"',
  'with zipfile.ZipFile(wheel, "w") as z:',
  '    z.writestr("nimbus_local_pkg/__init__.py", "VALUE = \\"LOCAL_WHEEL_OK\\"\\n")',
  '    z.writestr("nimbus_local_pkg-0.1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: nimbus-local-pkg\\nVersion: 0.1.0\\n")',
  '    z.writestr("nimbus_local_pkg-0.1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: Nimbus test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
  '    z.writestr("nimbus_local_pkg-0.1.0.dist-info/RECORD", "")',
  'print(wheel)',
].join('\n')), 10_000);
await t.run('python make_wheel.py', 60_000);

{
  const { output } = await t.run('pip install ./nimbus_local_pkg-0.1.0-py3-none-any.whl', 180_000);
  const stripped = stripAnsi(output);
  a.check('pip installs a local pure wheel from VFS',
    /Successfully installed/.test(stripped) && /nimbus_local_pkg/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

{
  const { output } = await t.run('python -c "import nimbus_local_pkg; print(nimbus_local_pkg.VALUE)"', 120_000);
  const stripped = stripAnsi(output);
  a.check('local wheel import works in a later Python command',
    /LOCAL_WHEEL_OK/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

await t.run('cp nimbus_local_pkg-0.1.0-py3-none-any.whl native_pkg-0.1.0-cp313-cp313-manylinux_2_28_x86_64.whl', 10_000);
{
  const { output } = await t.run('pip install ./native_pkg-0.1.0-cp313-cp313-manylinux_2_28_x86_64.whl', 60_000);
  const stripped = stripAnsi(output);
  a.check('native Linux wheel is rejected with an ABI diagnostic',
    /native Linux wheel/.test(stripped) && /pure wheel/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
