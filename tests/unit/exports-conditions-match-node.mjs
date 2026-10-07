#!/usr/bin/env bun
// `exports` and `imports` resolve under the program's conditions as Node's
// do, host Node the oracle, with and without `--conditions=development`:
//
//   (1) require: the shared resolver (core _shared/exports-resolver.ts),
//       under require's conditions and the program's own, takes a condition
//       map in its own key order, as Node does (a `default` first wins; a
//       `node` map before `require` is entered first);
//   (2) import: Node's ESM resolver (core _shared/esm-resolver.ts) created
//       with the program's conditions.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CJS_CONDITIONS, resolveExports, resolvePackageEntry } from '../../packages/core/src/_shared/exports-resolver.ts';
import { createEsmResolver } from '../../packages/core/src/_shared/esm-resolver.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'exports-conditions-')));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const files = {
  'app/package.json': JSON.stringify({
    name: 'app',
    imports: {
      '#cond': { development: './t.js', default: './f.js' },
      '#order': { default: './d.js', node: './n.js' },
      '#nested': { node: { development: './t.js', default: './n.js' }, default: './f.js' },
    },
  }),
  'node_modules/p/package.json': JSON.stringify({
    name: 'p',
    exports: {
      '.': { default: './d.js', node: './n.js' },
      './x': { node: { import: './ni.mjs', require: './nr.js' }, require: './r.js', import: './i.mjs' },
      './dev': { development: './dev.js', default: './prod.js' },
      './late': { require: './r.js', development: './dev.js', default: './prod.js' },
    },
  }),
};
for (const name of ['t.js', 'f.js', 'd.js', 'n.js']) files[`app/${name}`] = 'module.exports = 1;';
for (const name of ['d.js', 'n.js', 'nr.js', 'r.js', 'dev.js', 'prod.js']) files[`node_modules/p/${name}`] = 'module.exports = 1;';
for (const name of ['ni.mjs', 'i.mjs']) files[`node_modules/p/${name}`] = 'export default 1;';
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
const app = join(root, 'app');
const specifiers = ['p', 'p/x', 'p/dev', 'p/late', '#cond', '#order', '#nested'];
const appPkg = JSON.parse(files['app/package.json']);
const pPkg = JSON.parse(files['node_modules/p/package.json']);

for (const conditions of [[], ['development']]) {
  const flags = conditions.map((c) => `--conditions=${c}`);
  const host = spawnSync('node', [...flags, '-e', `
    const out = {};
    for (const spec of ${JSON.stringify(specifiers)}) out[spec] = require('path').relative(${JSON.stringify(root)}, require.resolve(spec));
    console.log(JSON.stringify(out));
  `], { cwd: app, encoding: 'utf8' });
  assert.equal(host.status, 0, host.stderr);
  const expected = JSON.parse(host.stdout);

  // (1) require, through the shared resolver.
  const cjs = [...DEFAULT_CJS_CONDITIONS, ...conditions];
  const ours = {};
  for (const spec of specifiers) {
    const target = spec.startsWith('#')
      ? `app/${resolveExports(appPkg.imports, spec, cjs).replace(/^\.\//, '')}`
      : `node_modules/p/${resolvePackageEntry(pPkg, spec === 'p' ? '.' : `./${spec.slice(2)}`, cjs).replace(/^\.\//, '')}`;
    ours[spec] = target;
  }
  assert.deepEqual(ours, expected, `(1) require under ${JSON.stringify(conditions)}`);

  // (2) import, through Node's ESM resolver with the program's conditions.
  const hostEsm = spawnSync('node', [...flags, '--input-type=module', '-e', `
    const out = {};
    for (const spec of ${JSON.stringify(specifiers)}) out[spec] = import.meta.resolve(spec);
    console.log(JSON.stringify(out));
  `], { cwd: app, encoding: 'utf8' });
  assert.equal(hostEsm.status, 0, hostEsm.stderr);
  const expectedEsm = JSON.parse(hostEsm.stdout);
  const resolver = createEsmResolver({
    kind(path) { try { return statSync(path).isDirectory() ? 'directory' : 'file'; } catch { return null; } },
    realpath: (path) => realpathSync(path),
    readText(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    isBuiltin: () => false,
    cjsResolve: () => null,
  }, { conditions });
  const parent = pathToFileURL(join(app, '[eval1]')).href;
  const oursEsm = Object.fromEntries(specifiers.map((spec) => [spec, resolver.resolveSync(spec, parent).url]));
  assert.deepEqual(oursEsm, expectedEsm, `(2) import under ${JSON.stringify(conditions)}`);
  console.log(`  ok  ${JSON.stringify(conditions)}: require ${Object.values(ours).join(' ')}; import as Node`);
}

console.log('exports-conditions-match-node: exports and imports resolve under the program\'s conditions, in key order, as Node');
