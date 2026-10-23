#!/usr/bin/env bun
// facet-greedy-literal-closure — the greedy oversample runs only for a
// closure that can load by a name it computes.
//
// The pass stages the main of each package the project can reach, for loads
// the walk cannot follow (`require(name)`, `import(path)`, bindings(), a
// plugin loader). Measured 2026-10-23 on a throwaway: `node -e 1` in an
// express project (406 packages) spent 1.41 s of a 1.76 s build in it, and the
// module map grew from 2.4 MB to 4.2 MB; in a Next app a builtins-only
// `node -e` spent 13 s (verify/handoffs/ticket-launch-greedy-oversample-cost.md).
// A closure whose every load is a literal was walked whole: the pass has
// nothing to catch there. A computed load still gets it.

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { hasOpaqueLoads } from '../../packages/core/src/runtime/opaque-loads.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const pkg = (name, deps = {}) => ({
  [`${NM}/${name}/package.json`]: JSON.stringify({ name, main: 'index.js', dependencies: deps }),
  [`${NM}/${name}/index.js`]: `module.exports = ${JSON.stringify(name)};\n`,
});
const files = {
  // Data, not code: a manifest's scripts may say "--require" (express's do).
  // A file the program requires runs whatever its extension, so it is read too (section 5).
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', scripts: { test: 'mocha --require test/support/env' }, dependencies: { express: '*', lodash: '*' } }),
  ...pkg('express', { 'body-parser': '*' }),
  ...pkg('body-parser'),
  ...pkg('lodash'),
};
const mains = (state) => Object.keys(state.bundle).filter((path) => path.startsWith(`${NM}/`) && path.endsWith('/index.js')).sort();
const build = (entryCode) => buildPrefetchBundle(launchFs(files).fs, { cwd: `/${APP}`, entryCode });

// ── 1. A builtins-only program: no package main is staged ─────────────────
{
  const state = await build(`const fs = require('node:fs'); console.log(fs.readdirSync('.').length);`);
  assert.deepEqual(mains(state), [], 'a closure of literal loads of builtins stages no package main');
  console.log('  builtins-only -e → no greedy mains');
}

// ── 2. A literal load of one package: its closure, and nothing guessed ────
{
  const state = await build(`console.log(require('lodash'));`);
  assert.deepEqual(mains(state), [`${NM}/lodash/index.js`], 'the package the program names, walked; no other package main');
  console.log('  literal require → only its own closure');
}

// ── 3. A computed load: the guess is made, as before ──────────────────────
{
  const state = await build(`const name = process.argv[2] || 'express'; console.log(require(name));`);
  assert.deepEqual(mains(state), [`${NM}/body-parser/index.js`, `${NM}/express/index.js`, `${NM}/lodash/index.js`],
    'a computed require stages the project\'s dependencies and one hop, as the greedy pass always did');
  console.log('  computed require → greedy mains staged');
}

// ── 4. What counts as opaque ──────────────────────────────────────────────
{
  const literal = [
    `require('x'); require("y"); require(\`z\`); require.resolve('w');`,
    `import('./a.js').then(() => {});`,
    `import a from 'a'; export { b } from "b"; export * from './c.js';`,
    `module.exports = require('./a.js'); module.exports.b = 1;`,
    `// require(name) in a comment\nconst n = 1; /* import(x) */`,
    `const s = 'no loads here, not even require(name)'; console.log(\`\${s} \${1 + 1}\`);`,
  ];
  for (const code of literal) assert.equal(hasOpaqueLoads(code), false, `literal only: ${code}`);
  const opaque = [
    `require(name)`, `require(\`./\${x}\`)`, `const r = require; r('x')`, `require.cache`, `require.main`,
    `import(path)`, `createRequire(import.meta.url)`, `process.getBuiltinModule('module')`, `eval('1')`,
    `new Function('return 1')`, `Module._load('x')`, `const bindings = require('bindings'); bindings('addon')`,
    `const vm = require('vm'); vm.runInThisContext(code)`, `requ\\u0069re(x)`, `globalThis.__nimbusDynamicImport('/', 'x')`,
    // The walk reads a specifier as it is written: an escape, a quote in it, or a second argument is not followed.
    `require("\\x66oo")`, `require("it's")`, `require("foo", {})`, `import("b", { with: { type: 'json' } })`,
    // A template's substitution holds a computed load.
    `const name = 'foo'; const s = \`\${\`http://a\`}\${require(name)}\`;`,
    // require on another module resolves from that module; a module's own object reaches Module and the others.
    `module.require('v')`, `process.mainModule.require('foo')`, `module['req' + 'uire']('x')`, `module.constructor._load('x')`,
    `module.parent.require('x')`, `arguments[1]('x')`,
    // What does not parse as JavaScript.
    `const x: number = require('x');`, `<div>{require('x')}</div>`,
  ];
  for (const code of opaque) assert.equal(hasOpaqueLoads(code), true, `opaque: ${code}`);
  console.log('  opaque forms recognised, literal forms not');
}

// ── 5. A required file of any extension is code ───────────────────────────
{
  const withLoader = { ...files, [`${APP}/loader.txt`]: 'module.exports = require(process.env.PKG || "express");\n' };
  const state = await buildPrefetchBundle(launchFs(withLoader).fs, { cwd: `/${APP}`, entryCode: `require('./loader.txt');` });
  assert.ok(mains(state).length > 0, 'a computed load in a required .txt file still gets the guess');
  console.log('  a required file of any extension is checked');
}

console.log('facet-greedy-literal-closure: ok');
