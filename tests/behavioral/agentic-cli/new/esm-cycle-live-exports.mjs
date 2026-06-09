#!/usr/bin/env bun

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/esm-cycle-live-exports');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run('rm -rf /home/user/esm-cycle && mkdir -p /home/user/esm-cycle', 5_000);

await t.run(heredocCommand('/home/user/esm-cycle/a.mjs', `
import { b } from './b.mjs';

export function a() {
  return 'a';
}

export function callB() {
  return b();
}
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/b.mjs', `
import { a } from './a.mjs';

export function b() {
  return typeof a + ':' + a();
}
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/main.js', `
const cycle = require('./a.mjs');
console.log('CYCLE=' + cycle.callB());
`), 10_000);

const run = await t.run('cd /home/user/esm-cycle && node main.js', 60_000);
const out = stripAnsi(run.output);

a.check('transformed ESM cycle exposes live named exports', /CYCLE=function:a/.test(out), JSON.stringify(out.slice(-800)));
a.check('cycle does not throw missing export call error', !/is not a function/.test(out), JSON.stringify(out.slice(-800)));

await t.run(heredocCommand('/home/user/esm-cycle/barrel-index.mjs', `
export { DefaultResourceLoader } from './resource-loader.mjs';
export { createAgentSessionFromServices } from './sdk.mjs';
export { virtualModules } from './extension-loader.mjs';
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/resource-loader.mjs', `
import { virtualModules } from './extension-loader.mjs';

export class DefaultResourceLoader {
  name() {
    return 'loader:' + Object.keys(virtualModules).length;
  }
}
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/extension-loader.mjs', `
import * as bundledPackage from './barrel-index.mjs';

export const virtualModules = {
  package: bundledPackage,
};
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/sdk.mjs', `
import { DefaultResourceLoader } from './resource-loader.mjs';

export function createAgentSessionFromServices() {
  return DefaultResourceLoader;
}
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/barrel-main.js', `
const pkg = require('./barrel-index.mjs');
const instance = new pkg.DefaultResourceLoader();
console.log('BARREL=' + instance.name() + ':' + typeof pkg.createAgentSessionFromServices);
`), 10_000);

const barrelRun = await t.run('cd /home/user/esm-cycle && node barrel-main.js', 60_000);
const barrelOut = stripAnsi(barrelRun.output);
a.check('barrel re-export cycle does not read class export before initialization',
  /BARREL=loader:1:function/.test(barrelOut),
  JSON.stringify(barrelOut.slice(-1000)));
a.check('barrel cycle does not throw TDZ export error',
  !/before initialization|Cannot access/.test(barrelOut),
  JSON.stringify(barrelOut.slice(-1000)));

await t.run(heredocCommand('/home/user/esm-cycle/import-meta-resolve.mjs', `
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export function resolvedDir() {
  return dirname(fileURLToPath(import.meta.resolve('./resource-loader.mjs')));
}
`), 10_000);

await t.run(heredocCommand('/home/user/esm-cycle/import-meta-main.js', `
const mod = require('./import-meta-resolve.mjs');
console.log('RESOLVED_DIR=' + mod.resolvedDir());
`), 10_000);

const importMetaRun = await t.run('cd /home/user/esm-cycle && node import-meta-main.js', 60_000);
const importMetaOut = stripAnsi(importMetaRun.output);
a.check('import.meta.resolve resolves relative to the current VFS module',
  /RESOLVED_DIR=\/home\/user\/esm-cycle/.test(importMetaOut),
  JSON.stringify(importMetaOut.slice(-1000)));

await t.run('mkdir -p /home/user/esm-cycle/node_modules/pkg-a /home/user/esm-cycle/nested/node_modules/pkg-a /home/user/esm-cycle/nested', 10_000);
await t.run(heredocCommand('/home/user/esm-cycle/node_modules/pkg-a/package.json', `
{"name":"pkg-a","main":"index.js"}
`), 10_000);
await t.run(heredocCommand('/home/user/esm-cycle/node_modules/pkg-a/index.js', `
module.exports = 'root-pkg';
`), 10_000);
await t.run(heredocCommand('/home/user/esm-cycle/nested/node_modules/pkg-a/package.json', `
{"name":"pkg-a","main":"index.js"}
`), 10_000);
await t.run(heredocCommand('/home/user/esm-cycle/nested/node_modules/pkg-a/index.js', `
module.exports = 'nested-pkg';
`), 10_000);
await t.run(heredocCommand('/home/user/esm-cycle/nested/create-require.mjs', `
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function resolvedPackage() {
  return require('pkg-a') + ':' + require.resolve('pkg-a');
}
`), 10_000);
await t.run(heredocCommand('/home/user/esm-cycle/create-require-main.js', `
const mod = require('./nested/create-require.mjs');
console.log('CREATE_REQUIRE=' + mod.resolvedPackage());
`), 10_000);

const createRequireRun = await t.run('cd /home/user/esm-cycle && node create-require-main.js', 60_000);
const createRequireOut = stripAnsi(createRequireRun.output);
a.check('createRequire(import.meta.url) resolves packages from the current VFS module',
  /CREATE_REQUIRE=nested-pkg:\/home\/user\/esm-cycle\/nested\/node_modules\/pkg-a\/index\.js/.test(createRequireOut),
  JSON.stringify(createRequireOut.slice(-1000)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
