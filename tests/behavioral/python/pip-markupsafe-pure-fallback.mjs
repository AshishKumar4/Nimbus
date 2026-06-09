#!/usr/bin/env bun
// python/pip-markupsafe-pure-fallback - MarkupSafe installs as a pure
// Python package in Nimbus instead of loading Pyodide extension wasm.

import { makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/pip-markupsafe-pure-fallback';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

const install = await t.run('pip install markupsafe', 180_000);
const cleanInstall = stripAnsi(install.output);
a.check('pip install markupsafe completes',
  /Successfully installed markupsafe/.test(cleanInstall),
  JSON.stringify(cleanInstall.slice(-1000)));
a.check('install output has no dynamic wasm load failure',
  !/Failed to load MarkupSafe|Failed to load dynamic library|Wasm code generation disallowed/i.test(cleanInstall),
  JSON.stringify(cleanInstall.slice(-1000)));

const imported = await t.run('python -c "import markupsafe; print(markupsafe.escape(\'<nimbus>\'))"', 120_000);
const cleanImport = stripAnsi(imported.output);
a.check('MarkupSafe pure import works later',
  /&lt;nimbus&gt;/.test(cleanImport),
  JSON.stringify(cleanImport.slice(-1000)));
a.check('later import has no dynamic wasm load failure',
  !/Failed to load dynamic library|Wasm code generation disallowed/i.test(cleanImport),
  JSON.stringify(cleanImport.slice(-1000)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
