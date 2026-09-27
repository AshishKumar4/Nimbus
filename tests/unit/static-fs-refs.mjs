#!/usr/bin/env bun
// static-fs-refs: the paths a module names by an expression it can compute
// before it runs, found by parsing it and folding constants — and nothing it
// computes from run-time data.

import assert from 'node:assert/strict';
import { findStaticFsReferences as refs, STATIC_AST_MAX_SOURCE } from '../../packages/core/src/runtime/static-fs-refs.ts';

const FILE = '/p/node_modules/pkg/lib/index.js';
const ESM = '/p/node_modules/pkg/dist/index.mjs';

// CommonJS: path.join / path.resolve over __dirname, through the shapes
// compilers emit for `import path from "path"`.
for (const [label, source] of [
  ['plain require', `const fs = require('fs'); const path = require('path'); fs.readFileSync(path.join(__dirname, '..', 'data', 'x.json'));`],
  ['esbuild interop', `var import_path = __toESM(require("path")); readFileSync(import_path.default.join(__dirname, "../data/x.json"));`],
  ['tsc interop', `const path_1 = __importDefault(require("path")); (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "../data", "x.json"));`],
  ['destructured', `const { join } = require('node:path'); const at = join(__dirname, '../data/x.json'); module.exports = () => at;`],
  ['single-assignment binding', `const path = require('path'); const DATA = path.join(__dirname, '..', 'data'); const X = DATA + '/x.json'; fs.readFileSync(X);`],
]) {
  assert.ok(refs(source, FILE).exact.includes('/p/node_modules/pkg/data/x.json'), label);
}

// ESM: new URL(rel, import.meta.url), fileURLToPath, import.meta.dirname.
assert.deepEqual(
  refs(`import { readFileSync } from 'node:fs'; readFileSync(new URL('../runtime/entry.js', import.meta.url), 'utf8');`, ESM).exact,
  ['/p/node_modules/pkg/runtime/entry.js'],
);
assert.deepEqual(
  refs(`import { fileURLToPath } from 'node:url'; const root = fileURLToPath(new URL('..', import.meta.url)); export default root;`, ESM).exact,
  ['/p/node_modules/pkg/'.replace(/\/$/, '')],
);
assert.deepEqual(
  refs(`import path from 'node:path'; export const t = path.join(import.meta.dirname, 'templates', 'a.hbs');`, ESM).exact,
  ['/p/node_modules/pkg/dist/templates/a.hbs'],
);

// A hole in the last segment keeps the directory and the name's known parts.
assert.deepEqual(
  refs(`const path = require('path'); fs.readFileSync(path.join(__dirname, \`locales/\${lang}.json\`));`, FILE).patterns,
  [{ dir: '/p/node_modules/pkg/lib/locales', prefix: '', suffix: '.json' }],
);
assert.deepEqual(
  refs(`readFileSync(fileURLToPath(new URL(\`./template-\${name}\`, import.meta.url)))`, ESM).patterns,
  [{ dir: '/p/node_modules/pkg/dist', prefix: 'template-', suffix: '' }],
);

// A directory a module lists: its files are what it reads next.
assert.deepEqual(
  refs(`const path = require('path'); for (const f of fs.readdirSync(path.join(__dirname, 'cows'))) load(f);`, FILE).listed,
  ['/p/node_modules/pkg/lib/cows'],
);

// Resolution requests: require.resolve, createRequire(...).resolve, and a
// package subpath spelled as data (a bundler's include list).
assert.deepEqual(
  refs(`const r = createRequire(import.meta.url); r.resolve('other/data.json'); x = ['astro/runtime/client/entry.js'];`, ESM).resolves
    .map((r) => r.spec),
  ['other/data.json', 'astro/runtime/client/entry.js'],
);
assert.deepEqual(refs(`require.resolve('other/lib/x')`, FILE).resolves, [{ from: '/p/node_modules/pkg/lib', spec: 'other/lib/x' }]);

// A relative path at a read site is relative to the working directory.
assert.deepEqual(refs(`fs.readFileSync('config/app.json', 'utf8')`, FILE).cwdRelative, ['config/app.json']);

// A synchronous content read names its path as one; a stat, an async read or
// a bare join does not.
assert.deepEqual(
  refs(`const fs = require('fs'); const path = require('path');
    fs.readFileSync('/opt/data/big.dat', 'utf8');
    fs.openSync(path.join(__dirname, 'blob.bin'), 'r');
    fs.readFileSync('rel/sync.txt');
    fs.existsSync('/opt/data/stat-only.bin');
    fs.readFile('/opt/data/async.dat', () => {});
    const bin = path.join(__dirname, '..', 'bin', 'tool');`, FILE).syncReads,
  ['/opt/data/big.dat', '/p/node_modules/pkg/lib/blob.bin', 'rel/sync.txt'],
);

// What folding cannot reach: parameters, run-time data, reassigned bindings.
for (const [label, source] of [
  ['a parameter', `const path = require('path'); function load(name) { return fs.readFileSync(path.join(name, 'x.json')); }`],
  ['an environment variable', `fs.readFileSync(process.env.CONFIG_FILE)`],
  ['a reassigned binding', `let p = '/etc/a'; p = compute(); fs.readFileSync(p);`],
  ['a computed member', `fs[m](path.join(__dirname, x))`],
]) {
  const r = refs(source, FILE);
  assert.deepEqual([r.exact, r.patterns, r.listed], [[], [], []], label);
}

// Unparseable input names nothing rather than throwing.
assert.deepEqual(refs('this is not javascript {{{', FILE).exact, []);

// A module too large to parse in the session's heap is scanned token by token,
// with the shapes that need no bindings still found.
{
  const pad = '\n// ' + 'x'.repeat(STATIC_AST_MAX_SOURCE);
  const big = refs(`const path = require('path');
    fs.readFileSync(path.join(__dirname, '..', 'data', 'x.json'));
    const u = new URL('../runtime/entry.js', import.meta.url);
    fs.readdirSync('/etc/app/templates');
    fs.readFileSync('/opt/data/big.dat');
    x = ['astro/runtime/client/entry.js'];` + pad, FILE);
  assert.ok(big.exact.includes('/p/node_modules/pkg/data/x.json'), JSON.stringify(big.exact));
  assert.ok(big.exact.includes('/p/node_modules/pkg/runtime/entry.js'), JSON.stringify(big.exact));
  assert.deepEqual(big.listed, ['/etc/app/templates']);
  assert.deepEqual(big.resolves.map((r) => r.spec), ['astro/runtime/client/entry.js']);
  assert.deepEqual(big.syncReads, ['/opt/data/big.dat']);
}

console.log('static-fs-refs: ok');
