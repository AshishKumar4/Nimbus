#!/usr/bin/env bun
// The process's `import()` resolves as Node's ESM loader does
// (packages/core/src/_shared/esm-resolver.ts). Real node is the oracle: one
// fixture tree on disk, one importing module, and for every specifier what
// `import.meta.resolve` answers (a URL, or the error: code, message, class)
// and what `import()` rejects with, including where resolution succeeds but
// loading cannot (a missing file, a directory, a file extension node does not
// load, an import attribute it refuses). The resolver runs over the same tree through a host
// on node's fs, so the comparison is of the algorithm alone.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEsmResolver } from '../../packages/core/src/_shared/esm-resolver.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'esm-resolver-')));
try {
  const files = {
    'app/package.json': JSON.stringify({
      name: 'app',
      imports: {
        '#int': { import: './esm.mjs', default: './c.cjs' },
        '#pat/*': './lib/*.js',
        '#dep': 'dual',
        '#bad': '../outside.js',
        '#null': null,
      },
      exports: { '.': './esm.mjs', './self-sub': './rel.js' },
    }),
    'app/esm.mjs': 'export const kind = "esm";\n',
    'app/c.cjs': 'exports.a = 1;\n',
    'app/rel.js': 'module.exports = "rel";\n',
    'app/data.json': '{"k":1}\n',
    'app/notes.txt': 'hi\n',
    'app/dir/index.js': 'module.exports = "idx";\n',
    'app/empty/.keep': '',
    'app/lib/one.js': 'module.exports = 1;\n',
    'app/r e l.js': 'module.exports = "space";\n',
    'app/t.ts': 'export const t: number = 1;\n',
    'app/noext': 'export const e = 1;\n',
    'app/typed/package.json': JSON.stringify({ type: 'module' }),
    'app/typed/m.js': 'export default 1;\n',
    'app/typed/noext': 'export default 1;\n',
    'app/typed/cjs/package.json': JSON.stringify({ type: 'commonjs' }),
    'app/typed/cjs/c.js': 'module.exports = 1;\n',
    'node_modules/dual/package.json': JSON.stringify({
      name: 'dual',
      exports: {
        '.': { require: './c.cjs', import: './e.mjs' },
        './pub': './pub.mjs',
        './feat/*': './features/*.mjs',
        './feat/*.css': null,
        './deep/*': { node: './deep/*/index.mjs' },
        './arr': [{ worker: './w.mjs' }, './e.mjs'],
        './nomatch': { browser: './b.mjs' },
        './bad': 'e.mjs',
        './escape': './../x.mjs',
        './dir/': './features/',
      },
    }),
    'node_modules/dual/e.mjs': 'export const via = "import";\n',
    'node_modules/dual/c.cjs': 'exports.via = "require";\n',
    'node_modules/dual/pub.mjs': 'export const p = 1;\n',
    'node_modules/dual/features/a.mjs': 'export const a = 1;\n',
    'node_modules/dual/deep/x/index.mjs': 'export const x = 1;\n',
    'node_modules/order/package.json': JSON.stringify({
      name: 'order',
      exports: { browser: './b.mjs', module: './m.mjs', 'module-sync': './ms.mjs', node: './n.mjs', default: './d.mjs' },
    }),
    'node_modules/order/ms.mjs': 'export const f = "ms";\n',
    'node_modules/sugar/package.json': JSON.stringify({ name: 'sugar', exports: './main.mjs' }),
    'node_modules/sugar/main.mjs': 'export default 1;\n',
    'node_modules/mixed/package.json': JSON.stringify({ name: 'mixed', exports: { '.': './a.mjs', import: './b.mjs' } }),
    'node_modules/legacy/package.json': JSON.stringify({ name: 'legacy', main: 'lib/main' }),
    'node_modules/legacy/lib/main.js': 'exports.m = "main";\n',
    'node_modules/legacy/sub.js': 'exports.s = 1;\n',
    'node_modules/nomain/package.json': JSON.stringify({ name: 'nomain' }),
    'node_modules/nomain/index.js': 'exports.i = 1;\n',
    'node_modules/broken/package.json': '{ not json',
    'node_modules/missingmain/package.json': JSON.stringify({ name: 'missingmain', main: 'gone.js' }),
    'node_modules/@scope/pkg/package.json': JSON.stringify({ name: '@scope/pkg', exports: { '.': './i.mjs' } }),
    'node_modules/@scope/pkg/i.mjs': 'export default 1;\n',
    'node_modules/nopkgjson/index.js': 'exports.x = 1;\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const app = join(root, 'app');
  const cases = [
    ['/esm.mjs abs', join(app, 'esm.mjs')],
    ['rel', './rel.js'],
    ['rel noext', './rel'],
    ['rel dir', './dir'],
    ['rel dir slash', './dir/'],
    ['rel empty dir', './empty'],
    ['missing', './nope.js'],
    ['missing slash', './nope/'],
    ['dot', '.'],
    ['dotdot', '..'],
    ['parent rel', '../node_modules/dual/e.mjs'],
    ['encoded', './r%65l.js'],
    ['space', './r%20e%20l.js'],
    ['encoded slash', './a%2Fb.js'],
    ['file url', pathToFileURL(join(app, 'esm.mjs')).href + '?t=1#h'],
    ['file url dir', pathToFileURL(join(app, 'dir')).href],
    ['file url missing', pathToFileURL(join(app, 'gone.mjs')).href],
    ['builtin', 'fs'],
    ['builtin sub', 'fs/promises'],
    ['node:', 'node:path'],
    ['node: unknown', 'node:nope'],
    ['node: only', 'node:test'],
    ['bare test', 'test'],
    ['http', 'http://example.com/x.js'],
    ['data', 'data:text/javascript,export default 1'],
    ['dual', 'dual'],
    ['dual pub', 'dual/pub'],
    ['dual not exported', 'dual/priv'],
    ['dual pattern', 'dual/feat/a'],
    ['dual pattern null', 'dual/feat/a.css'],
    ['dual pattern missing', 'dual/feat/zz'],
    ['dual deep condition', 'dual/deep/x'],
    ['dual array', 'dual/arr'],
    ['dual no condition', 'dual/nomatch'],
    ['dual bad target', 'dual/bad'],
    ['dual escape', 'dual/escape'],
    ['dual dir map', 'dual/dir/a.mjs'],
    ['dual subpath in file', 'dual/e.mjs'],
    ['order', 'order'],
    ['sugar', 'sugar'],
    ['sugar sub', 'sugar/x'],
    ['mixed', 'mixed'],
    ['legacy', 'legacy'],
    ['legacy sub', 'legacy/sub.js'],
    ['legacy sub noext', 'legacy/sub'],
    ['nomain', 'nomain'],
    ['broken', 'broken'],
    ['missingmain', 'missingmain'],
    ['nopkgjson', 'nopkgjson'],
    ['scoped', '@scope/pkg'],
    ['scoped bad', '@scope'],
    ['bad name', '.hidden'],
    ['percent name', 'a%20b'],
    ['no package', 'nopkg'],
    ['no package sub', 'nopkg/sub'],
    ['self', 'app'],
    ['self sub', 'app/self-sub'],
    ['self not exported', 'app/other'],
    ['imports', '#int'],
    ['imports pattern', '#pat/one'],
    ['imports pattern missing', '#pat/two'],
    ['imports bare', '#dep'],
    ['imports bad target', '#bad'],
    ['imports null', '#null'],
    ['imports undefined', '#nothing'],
    ['imports hash', '#'],
    ['imports hash slash', '#/x'],
    ['empty', ''],
    ['ts', './t.ts'],
    ['noext file', './noext'],
    ['typed js', './typed/m.js'],
    ['typed noext', './typed/noext'],
    ['typed cjs', './typed/cjs/c.js'],
    ['txt', './notes.txt'],
    ['json no attribute', './data.json'],
    ['json', './data.json', { type: 'json' }],
    // A fresh URL each: node checks attributes when it first loads a URL.
    ['json extra attribute', './data.json?extra', { type: 'json', mode: 'x' }],
    ['esm as json', './esm.mjs', { type: 'json' }],
    ['esm as css', './esm.mjs', { type: 'css' }],
    ['builtin as json', 'fs', { type: 'json' }],
  ];

  // The oracle: an ES module in the fixture that resolves and imports each case.
  const parent = join(app, 'importer.mjs');
  writeFileSync(parent, `
const cases = ${JSON.stringify(cases)};
const errorOf = (e) => ({ code: e.code, name: e.name, message: e.message });
const out = [];
for (const [label, specifier, attributes] of cases) {
  let resolved;
  try { resolved = { url: import.meta.resolve(specifier) }; } catch (e) { resolved = { error: errorOf(e) }; }
  let imported;
  try {
    await (attributes ? import(specifier, { with: attributes }) : import(specifier));
    imported = { ok: true };
  } catch (e) { imported = { error: errorOf(e) }; }
  out.push({ label, resolved, imported });
}
process.stdout.write(JSON.stringify(out));
`);
  const node = spawnSync('node', ['--no-warnings', parent], { cwd: app, encoding: 'utf8' });
  assert.equal(node.status, 0, node.stderr);
  const oracle = JSON.parse(node.stdout);

  // node's own answer for each name the cases can ask about.
  const names = [...new Set(cases.flatMap(([, specifier]) => [specifier, 'node:' + specifier.replace(/^node:/, '')]))];
  const builtins = new Set(JSON.parse(spawnSync('node', ['-p', `JSON.stringify(${JSON.stringify(names)}.filter((n) => require('module').isBuiltin(n)))`], { encoding: 'utf8' }).stdout));
  const resolver = createEsmResolver({
    kind(path) {
      try {
        const st = statSync(path);
        return st.isDirectory() ? 'directory' : st.isFile() ? 'file' : null;
      } catch { return null; }
    },
    realpath: (path) => realpathSync(path),
    readText(path) {
      try { return readFileSync(path, 'utf8'); } catch { return null; }
    },
    // Some builtins exist only with the scheme (node:test).
    isBuiltin: (specifier) => builtins.has(specifier),
    cjsResolve(specifier, parentPath) {
      try { return createRequire(parentPath).resolve(specifier); } catch { return null; }
    },
  });
  const parentUrl = pathToFileURL(parent).href;
  const errorOf = (e) => ({ code: e.code, name: e.name, message: e.message });

  let compared = 0;
  for (const [index, [label, specifier, attributes]] of cases.entries()) {
    const expected = oracle[index];
    let resolved;
    try { resolved = { url: resolver.metaResolveSync(specifier, parentUrl) }; } catch (e) { resolved = { error: errorOf(e) }; }
    assert.deepEqual(resolved, expected.resolved, `${label}: import.meta.resolve`);
    let resolution = null;
    let failed;
    try {
      // Both drivers of the one algorithm, on alternate cases.
      resolution = index % 2 ? resolver.resolveSync(specifier, parentUrl) : await resolver.resolve(specifier, parentUrl);
    } catch (e) { failed = { error: errorOf(e) }; }
    let imported;
    if (resolution === null) imported = failed;
    else {
      try {
        if (resolution.format === 'data') throw new Error('data: is loaded by the caller');
        resolver.validateAttributes(resolution.url, resolution.format, attributes ?? {});
        imported = { ok: true };
      } catch (e) { imported = { error: errorOf(e) }; }
    }
    if (resolution?.format === 'data') continue;
    assert.deepEqual(imported, expected.imported, `${label}: import`);
    compared++;
  }
  console.log(`esm-resolver-matches-node: ${compared} specifiers resolve and fail as node does`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
