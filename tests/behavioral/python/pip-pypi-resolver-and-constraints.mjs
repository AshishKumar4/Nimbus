#!/usr/bin/env bun
// python/pip-pypi-resolver-and-constraints — pip resolves PyPI pure wheels
// with dependency metadata, constraints, markers, and persistent imports.

import { heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/pip-pypi-resolver-and-constraints';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);
await t.run('mkdir -p /home/user/py-resolver && cd /home/user/py-resolver', 10_000);

await t.run(heredocCommand('requirements.txt', 'packaging\n'), 10_000);
await t.run(heredocCommand('constraints.txt', 'packaging==24.2\n'), 10_000);

{
  const { output } = await t.run('pip install -r requirements.txt -c constraints.txt', 240_000);
  const clean = stripAnsi(output);
  a.check('constraints install the requested package set',
    /Successfully installed packaging/.test(clean),
    JSON.stringify(clean.slice(-1200)));
}

{
  const { output } = await t.run('python -c "from importlib.metadata import version; print(\'PACKAGING_VERSION=\' + version(\'packaging\'))"', 120_000);
  const clean = stripAnsi(output);
  a.check('constrained package import persists in later Python command',
    /PACKAGING_VERSION=24\.2/.test(clean),
    JSON.stringify(clean.slice(-1200)));
}

{
  const { output } = await t.run('pip install requests', 360_000);
  const clean = stripAnsi(output);
  a.check('pip resolves transitive pure-wheel dependencies from PyPI',
    /Successfully installed/.test(clean)
      && /requests/.test(clean)
      && /certifi/.test(clean)
      && /idna/.test(clean)
      && /urllib3/.test(clean),
    JSON.stringify(clean.slice(-1600)));
}

{
  const { output } = await t.run('python -c "import certifi, charset_normalizer, idna, requests, urllib3; print(\'REQUESTS_OK=\' + requests.__version__)"', 120_000);
  const clean = stripAnsi(output);
  a.check('requests and transitive dependencies import later',
    /REQUESTS_OK=/.test(clean),
    JSON.stringify(clean.slice(-1200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
