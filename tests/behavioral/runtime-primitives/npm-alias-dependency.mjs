#!/usr/bin/env bun
// runtime-primitives/npm-alias-dependency — npm alias dependencies.
//
// Agentic CLIs such as Codex publish platform shards through standard
// npm alias optional dependencies (`alias: "npm:<pkg>@<version>"`).
// Nimbus must resolve the target packument/version while installing the
// package at the alias key in node_modules.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/npm-alias-dependency');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('mkdir -p alias-probe && cd alias-probe', 10_000);
await t.run(heredocCommand('package.json', JSON.stringify({
  name: 'alias-probe',
  version: '1.0.0',
  dependencies: {
    'is-number-alias': 'npm:is-number@7.0.0',
  },
}, null, 2)), 10_000);

const install = await t.run('npm install', 180_000);
const installOut = stripAnsi(install.output);
a.check('npm install resolves alias without 404', !/HTTP 404|Not found|could not install/i.test(installOut),
  JSON.stringify(installOut.slice(-600)));

const run = await t.run(
  'node -e "const isNumber=require(\'is-number-alias\'); const pkg=require(\'./node_modules/is-number-alias/package.json\'); console.log(\'ALIAS_RESULT=\'+isNumber(42)); console.log(\'PACKAGE_NAME=\'+pkg.name)"',
  30_000,
);
const out = stripAnsi(run.output);
a.check('alias package is require-able by alias name', /ALIAS_RESULT=true/.test(out),
  JSON.stringify(out.slice(-400)));
a.check('installed package keeps target package metadata', /PACKAGE_NAME=is-number/.test(out),
  JSON.stringify(out.slice(-400)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
