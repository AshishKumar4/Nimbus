#!/usr/bin/env bun
// fs.glob, fs.globSync and fs.promises.glob answer as Node's do.
//
// The shim had one minimal fs.promises.glob: a regex built from `*`, `**` and
// `?`, no braces, no classes, no exclude, absolute paths out, and no fs.glob
// or fs.globSync at all. vinext finds an App Router's pages with
// `glob("{**,**/.*/**}/page.{tsx,ts,jsx,js}", { cwd: appDir, exclude })`:
// the braces matched nothing, so `vinext dev` answered every page 404
// (vinext-real on a throwaway, sid elegant-sapphire-6975: "GET / 404").
//
// Node's own glob is its Glob (lib/internal/fs/glob.js) over the minimatch it
// vendors; the shim now runs a port of the first over the second, byte for
// byte. This compares both against the node on PATH (the oracle) on one tree,
// with every API and option.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { NODE_MINIMATCH_SHA256, NODE_MINIMATCH_SOURCE } from '../../packages/worker/src/runtime/node-minimatch-source.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

// ── the vendored matcher is upstream's, unedited ──
// Node v22.22.3's deps/minimatch/index.js.
const UPSTREAM_SHA256 = 'bbb2e2de15fd760c8ae208fff3160681820f175a3fc02df66464ca0c04852884';
assert.equal(NODE_MINIMATCH_SHA256, UPSTREAM_SHA256);
assert.equal(createHash('sha256').update(NODE_MINIMATCH_SOURCE).digest('hex'), UPSTREAM_SHA256);

const FILES = [
  'app/page.tsx', 'app/layout.tsx', 'app/blog/page.tsx', 'app/blog/[slug]/page.ts', 'app/api/route.ts',
  'app/(group)/about/page.jsx', 'app/.hidden/page.tsx', 'app/_private/page.tsx', 'app/blog/.cache/x.js',
  'src/index.js', 'src/a.test.js', 'src/lib/util.mjs', 'src/lib/deep/x.cjs', 'src/lib/deep/y.js',
  'README.md', '.env', '.config/x.json', 'docs/a.md', 'docs/b.MD',
];
const DIRS = ['app/empty', 'src/lib/none'];
// Node's order is its traversal over each directory's listing, so it is
// defined where the listing's order is. The shim lists a directory in name
// order; the oracle's filesystem lists in the order it keeps, which on a
// tmpfs follows creation. So the tree is built where the oracle lists it in
// name order (each directory's entries created in name order, or in reverse
// where that is what the filesystem returns), and then the order is compared
// too; elsewhere only the set is.
function build(base, reverse) {
  const root = mkdtempSync(join(base, 'nimbus-glob-'));
  const entries = [...FILES.map((path) => ({ path, file: true })), ...DIRS.map((path) => ({ path, file: false }))]
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (reverse) entries.reverse();
  for (const { path, file } of entries) {
    mkdirSync(file ? join(root, path, '..') : join(root, path), { recursive: true });
    if (file) writeFileSync(join(root, path), path + '\n');
  }
  return root;
}
function listedInNameOrder(dir) {
  const names = readdirSync(dir);
  if (names.join('/') !== [...names].sort().join('/')) return false;
  return names.every((name) => !statSync(join(dir, name)).isDirectory() || listedInNameOrder(join(dir, name)));
}
let root = null;
let ORDERED = false;
for (const base of existsSync('/dev/shm') ? ['/dev/shm', tmpdir()] : [tmpdir()]) {
  for (const reverse of [false, true]) {
    let candidate;
    try { candidate = build(base, reverse); } catch { continue; }
    if (listedInNameOrder(candidate)) { root = candidate; ORDERED = true; break; }
    rmSync(candidate, { recursive: true, force: true });
  }
  if (root !== null) break;
}
if (root === null) root = build(tmpdir(), false);
console.log(`node-glob-matches-node: comparing ${ORDERED ? 'order and members' : 'members only (no filesystem here lists in name order)'}`);
try {

  // Each case: [pattern, options]. `exclude` names one of EXCLUDES; `cwd` is
  // under the root (`url:` makes it a file: URL); `abs:` patterns are under it.
  const CASES = [
    ['**/page.{tsx,ts,jsx,js}', { cwd: 'app' }],
    ['{**,**/.*/**}/page.{tsx,ts,jsx,js}', { cwd: 'app' }],
    ['{**,**/.*/**}/page.{tsx,ts,jsx,js}', { cwd: 'app', exclude: 'names' }],
    ['{**,**/.*/**}/route.{tsx,ts,jsx,js}', { cwd: 'app', exclude: 'names' }],
    ['**/*.js', { cwd: 'src' }],
    ['**', { cwd: 'src' }],
    ['**'],
    ['*'],
    ['.*'],
    ['**/.*'],
    ['src/**'],
    ['src/**/*.?js'],
    ['app/*/page.*'],
    ['[ab]pp/**/page.tsx'],
    ['+(src|docs)/*'],
    ['!(src)/*.md'],
    ['docs/*.md'],
    ['app/blog/[[]slug]/*'],
    ['src/lib/../index.js'],
    ['./src/*.js'],
    ['app/**/..'],
    ['src/{a,b,index}.*'],
    ['src/lib/deep/{x..y}.*'],
    [['src/*.js', 'app/*.tsx']],
    ['**/*.ts', { exclude: 'array' }],
    ['**/*', { cwd: 'app', exclude: 'array-dir' }],
    ['abs:app/*.tsx'],
    ['abs:{src,docs}/*'],
    ['*.tsx', { cwd: 'url:app' }],
    ['**/page.tsx', { cwd: 'app', withFileTypes: true }],
    ['**/page.tsx', { cwd: 'app', withFileTypes: true, exclude: 'dirent' }],
    ['nothing/here/*'],
    ['app/page.tsx'],
    ['app/empty'],
    ['app/empty/'],
  ];
  const ERRORS = [[1], [['a', 2]], ['*', null], ['*', { exclude: 1 }], ['*', 'x']];

  // The runner both sides execute: `fs`, `pathToFileURL` and the root are given.
  const RUNNER = `async (fs, pathToFileURL, root, CASES, ERRORS, ORDERED) => {
    const EXCLUDES = {
      names: (name) => name === 'api' || name === '_private',
      array: ['**/api/**', 'app/blog/**'],
      'array-dir': ['blog'],
      dirent: (entry) => entry.name === 'blog',
    };
    const options = (raw) => {
      if (!raw) return undefined;
      const out = { ...raw };
      if (typeof out.cwd === 'string') out.cwd = out.cwd.startsWith('url:') ? pathToFileURL(root + '/' + out.cwd.slice(4)) : root + '/' + out.cwd;
      else out.cwd = root;
      if (out.exclude) out.exclude = EXCLUDES[out.exclude];
      return out;
    };
    const pattern = (p) => typeof p === 'string' && p.startsWith('abs:') ? root + '/' + p.slice(4) : p;
    const shape = (list) => list.map((e) => typeof e === 'string' ? e
      : { name: e.name, parentPath: e.parentPath, directory: e.isDirectory(), file: e.isFile() })
      .sort(ORDERED ? () => 0 : (a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    const results = [];
    for (const [p, raw] of CASES) {
      const o = options(raw ?? {});
      const sync = shape(fs.globSync(pattern(p), o));
      const iterated = [];
      for await (const entry of fs.promises.glob(pattern(p), o)) iterated.push(entry);
      const called = await new Promise((resolve, reject) => fs.glob(pattern(p), o, (err, list) => err ? reject(err) : resolve(list)));
      results.push({ case: [p, raw ?? null], sync, iterated: shape(iterated), called: shape(called) });
    }
    for (const args of ERRORS) {
      try { fs.globSync(...args); results.push({ error: args, threw: false }); }
      catch (e) { results.push({ error: args, name: e.name, code: e.code, message: e.message }); }
    }
    try { fs.glob('*'); } catch (e) { results.push({ error: 'no callback', name: e.name, code: e.code, message: e.message }); }
    return results;
  }`;

  const oracle = spawnSync('node', ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    process.chdir(${JSON.stringify(root)});
    const run = ${RUNNER};
    console.log(JSON.stringify(await run(fs, pathToFileURL, ${JSON.stringify(root)}, ${JSON.stringify(CASES)}, ${JSON.stringify(ERRORS)}, ${ORDERED})));
  `], { encoding: 'utf8' });
  assert.equal(oracle.status, 0, `node: ${oracle.stderr}`);
  const expected = JSON.parse(oracle.stdout);

  // The shim, over the same tree as the launch's namespace holds it.
  const bundle = {};
  for (const file of [...FILES].sort()) bundle[join(root, file).slice(1)] = file + '\n';
  const dirs = {};
  for (const dir of DIRS) dirs[join(root, dir).slice(1)] = true;
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return { fs: builtins.fs, url: builtins.url };',
  );
  const { fs, url } = factory(bundle, {}, dirs, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, root, [], {}, root + '/app.js', root);
  const run = (0, eval)(`(${RUNNER})`);
  const actual = await run(fs, url.pathToFileURL, root, CASES, ERRORS, ORDERED);

  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(actual[i], expected[i], `case ${JSON.stringify(expected[i].case ?? expected[i].error)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('node-glob-matches-node: ok');
