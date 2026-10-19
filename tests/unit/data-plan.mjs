#!/usr/bin/env bun
// data-plan: which contents a resident node process holds from launch, by
// rule, over a namespace — and what it leaves out.

import assert from 'node:assert/strict';
import { linkTargetOf, planFacetData, planStylesheetSources, PACKAGE_DATA_MAX_BYTES, STYLESHEET_SOURCE_MAX_FILES } from '../../packages/worker/src/facets/data-plan.ts';
import { findStaticFsReferences } from '../../packages/core/src/runtime/static-fs-refs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

/** An in-memory namespace: path → { kind, size, text?, target? }. */
function namespace(files) {
  const all = new Map();
  for (const [path, spec] of Object.entries(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!all.has(dir)) all.set(dir, { kind: 'directory', size: 0 });
    }
    all.set(path, typeof spec === 'string'
      ? { kind: 'file', size: spec.length, text: spec }
      : spec);
  }
  const entries = [...all].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, e]) => ({ path, kind: e.kind, size: e.size, ...(e.target ? { linkTarget: e.target } : {}) }));
  return {
    // Two pages, so paging is on the path.
    list: async (after) => after === null
      ? { entries: entries.slice(0, 40), next: entries.length > 40 ? entries[39].path : null }
      : { entries: entries.slice(40), next: null },
    readText: async (p) => all.get(p.replace(/^\/+/, ''))?.text ?? null,
    // As a lookup resolves a path: through every link on it.
    stat: async (p) => {
      let segs = p.replace(/^\/+/, '').split('/');
      for (let i = 1, hops = 0; i <= segs.length; i++) {
        const e = all.get(segs.slice(0, i).join('/'));
        if (e?.kind !== 'symlink') continue;
        if (++hops > 40) return null;
        const base = e.target.startsWith('/') ? [] : segs.slice(0, i - 1);
        const resolved = [];
        for (const seg of [...base, ...e.target.split('/'), ...segs.slice(i)]) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') resolved.pop(); else resolved.push(seg);
        }
        segs = resolved;
        i = 0;
      }
      const e = all.get(segs.join('/'));
      return e ? { kind: e.kind, size: e.size } : null;
    },
    readdir: async (p) => {
      const dir = p.replace(/^\/+/, '');
      if (dir !== '' && all.get(dir)?.kind !== 'directory') return null;
      const prefix = dir === '' ? '' : dir + '/';
      return entries.filter((e) => e.path.startsWith(prefix) && e.path !== dir && !e.path.slice(prefix.length).includes('/'));
    },
    linkLookups: 0,
    async linkTarget(p) {
      this.linkLookups++;
      const e = all.get(p.replace(/^\/+/, ''));
      return e?.kind === 'symlink' ? e.target : null;
    },
  };
}

const big = (n) => ({ kind: 'file', size: n });
const source = namespace({
  // The project: held, except dependency and cache directories.
  'home/user/app/package.json': '{"name":"app"}',
  'home/user/app/src/data.csv': 'a,b',
  'home/user/app/.env': 'X=1',
  'home/user/app/.next/cache/blob': 'cache',
  'home/user/app/.git/HEAD': 'ref',
  // A package the closure uses: its small data, not its code or its large files.
  'home/user/app/node_modules/used/package.json': '{"name":"used","exports":{"./runtime/*":"./dist/runtime/*"}}',
  'home/user/app/node_modules/used/index.js': 'module.exports = 1',
  'home/user/app/node_modules/used/schema.json': '{}',
  'home/user/app/node_modules/used/huge.dat': big(PACKAGE_DATA_MAX_BYTES),
  'home/user/app/node_modules/used/dist/runtime/client/entry.js': 'export {}',
  'home/user/app/node_modules/used/node_modules/nested/data.json': '{}',
  // A package it does not use: only its package.json.
  'home/user/app/node_modules/unused/package.json': '{"name":"unused"}',
  'home/user/app/node_modules/unused/data.json': '{}',
  // TypeScript's role: its lib, @types, and what @types depends on.
  'home/user/app/node_modules/typescript/package.json': '{"name":"typescript"}',
  'home/user/app/node_modules/typescript/lib/typescript.js': 'x',
  'home/user/app/node_modules/typescript/lib/lib.es2022.d.ts': 'decl',
  'home/user/app/node_modules/@types/node/package.json': '{"name":"@types/node","dependencies":{"undici-types":"1"}}',
  'home/user/app/node_modules/@types/node/index.d.ts': 'decl',
  'home/user/app/node_modules/undici-types/package.json': '{"name":"undici-types"}',
  'home/user/app/node_modules/undici-types/index.d.ts': 'decl',
  'home/user/app/node_modules/unrelated/index.d.ts': 'decl',
  // $HOME's dot entries, a symlinked skills dir among them; caches excluded.
  'home/user/.pi/settings.json': '{}',
  'home/user/.agents': { kind: 'symlink', size: 0, target: '/srv/skills' },
  'srv/skills/review/SKILL.md': '# review',
  'home/user/.cache/huge/blob': 'cache',
  'home/user/notes.txt': 'not a dot entry',
  // Outside every rule.
  'opt/other/data.json': '{}',
});

const closure = [
  'home/user/app/node_modules/used/index.js',
  'home/user/app/node_modules/typescript/lib/typescript.js',
];
// What the closure's code names: a package subpath spelled as data.
const refs = [findStaticFsReferences(`x = ["used/runtime/client/entry.js"]`, '/home/user/app/node_modules/used/index.js')];

const plan = await planFacetData(source, { cwd: '/home/user/app', home: '/home/user', closure, refs });
const held = new Set(plan.paths);

const expectHeld = [
  'home/user/app/package.json', 'home/user/app/src/data.csv', 'home/user/app/.env',
  'home/user/app/node_modules/used/package.json', 'home/user/app/node_modules/used/schema.json',
  'home/user/app/node_modules/unused/package.json',
  'home/user/app/node_modules/typescript/lib/lib.es2022.d.ts',
  'home/user/app/node_modules/@types/node/index.d.ts', 'home/user/app/node_modules/undici-types/index.d.ts',
  'home/user/.pi/settings.json', 'srv/skills/review/SKILL.md',
  'home/user/app/node_modules/used/dist/runtime/client/entry.js',
];
for (const path of expectHeld) assert.ok(held.has(path), `held: ${path}`);

const expectLeft = [
  'home/user/app/.next/cache/blob', 'home/user/app/.git/HEAD',
  'home/user/app/node_modules/used/index.js', // code: the module map carries it
  'home/user/app/node_modules/used/huge.dat', // not data-sized
  'home/user/app/node_modules/used/node_modules/nested/data.json', // another package
  'home/user/app/node_modules/unused/data.json',
  'home/user/app/node_modules/unrelated/index.d.ts',
  'home/user/.cache/huge/blob', 'home/user/notes.txt', 'opt/other/data.json',
];
for (const path of expectLeft) assert.ok(!held.has(path), `left out: ${path}`);

assert.equal(plan.rules.static.files, 1, 'the subpath literal resolved through exports');
assert.equal(plan.rules.home.files, 2);
assert.equal(plan.paths.length, new Set(plan.paths).size, 'no path twice');
assert.equal(source.linkLookups, 'home/user/app/node_modules/used/dist/runtime/client/entry.js'.split('/').length,
  'a plan resolves links only along what its code resolves, as Node resolves it: each component of that path, once');

// Without typescript in the closure, its role adds nothing.
const noTs = await planFacetData(source, { cwd: '/home/user/app', home: '/home/user', closure: closure.slice(0, 1), refs: [] });
assert.equal(noTs.rules.typescript.files, 0);

// A file the code reads synchronously by an exact path is held at any size:
// that read cannot wait for its bytes. A large file the code only names (a
// binary it stats or spawns) is still left out.
{
  const huge = 25 * 1024 * 1024;
  const ns = namespace({
    'home/user/app/reader.js': 'x',
    'opt/appdata/locale/deep/never-required.dat': big(huge),
    'home/user/shared/table.bin': big(PACKAGE_DATA_MAX_BYTES),
    'opt/appdata/locale/deep/async-only.dat': big(huge),
    'home/user/app/node_modules/tool/package.json': '{"name":"tool"}',
    'home/user/app/node_modules/tool/index.js': 'x',
    'home/user/app/node_modules/tool/bin/tool': big(huge),
  });
  const syncRefs = [
    findStaticFsReferences(`const fs = require('fs');
      fs.readFileSync('/opt/appdata/locale/deep/never-required.dat', 'utf8');
      fs.openSync('../shared/table.bin', 'r');
      fs.promises.readFile('/opt/appdata/locale/deep/async-only.dat');`, '/home/user/app/reader.js'),
    findStaticFsReferences(`const fs = require('fs'); const path = require('path');
      const bin = path.join(__dirname, 'bin', 'tool'); if (!fs.existsSync(bin)) throw new Error('missing');`,
    '/home/user/app/node_modules/tool/index.js'),
  ];
  const syncPlan = await planFacetData(ns, {
    cwd: '/home/user/app', home: '/home/user',
    closure: ['home/user/app/reader.js', 'home/user/app/node_modules/tool/index.js'], refs: syncRefs,
  });
  const syncHeld = new Set(syncPlan.paths);
  assert.ok(syncHeld.has('opt/appdata/locale/deep/never-required.dat'), 'an exact synchronous read is held past the data size');
  assert.ok(syncHeld.has('home/user/shared/table.bin'), 'so is a cwd-relative one');
  assert.ok(!syncHeld.has('opt/appdata/locale/deep/async-only.dat'), 'an async read can fetch its bytes: not held');
  assert.ok(!syncHeld.has('home/user/app/node_modules/tool/bin/tool'), 'a large file only stat-ed or joined: not held');
  assert.equal(syncPlan.rules.static.files, 2);
  assert.equal(syncPlan.rules.static.bytes, huge + PACKAGE_DATA_MAX_BYTES, 'the held bytes are counted toward the plan');
}

// An openSync that appends, writes or truncates reads nothing it needs held,
// however large the file.
{
  const GiB3 = 3 * 1024 * 1024 * 1024;
  const ns = namespace({ 'var/log/app.log': big(GiB3), 'var/db/store.bin': big(GiB3), 'var/db/ro.bin': big(GiB3) });
  const plan = await planFacetData(ns, {
    cwd: '/home/user/app', home: '/home/user', closure: [],
    refs: [findStaticFsReferences(`const fs = require('fs');
      fs.openSync('/var/log/app.log', 'a'); fs.openSync('/var/db/store.bin', 'w'); fs.openSync('/var/db/ro.bin', 'r');`,
    '/home/user/app/reader.js')],
  });
  assert.deepEqual(plan.paths, ['var/db/ro.bin'], `only the read-only open is held: ${JSON.stringify(plan.paths)}`);
}

// A synchronous read through a symlink holds the file the link leads to:
// a linked file, a file under a linked directory, a chain of links. A loop
// holds nothing.
{
  const huge = 25 * 1024 * 1024;
  const ns = namespace({
    'opt/releases/v2/data.bin': big(huge),
    'opt/releases/v2/data2.bin': big(huge),
    'opt/releases/v2/conf.bin': big(PACKAGE_DATA_MAX_BYTES),
    'opt/releases/v2/unread.bin': big(huge),
    'opt/current': { kind: 'symlink', size: 0, target: '/opt/releases/v2' },
    'opt/latest': { kind: 'symlink', size: 0, target: 'current' },
    'opt/loop': { kind: 'symlink', size: 0, target: 'loop' },
    'etc/app.conf': { kind: 'symlink', size: 0, target: '../opt/releases/v2/conf.bin' },
  });
  const plan = await planFacetData(ns, {
    cwd: '/home/user/app', home: '/home/user', closure: [],
    refs: [findStaticFsReferences(`const fs = require('fs');
      fs.readFileSync('/opt/current/data.bin'); fs.readFileSync('/etc/app.conf');
      fs.readFileSync('/opt/latest/data2.bin'); fs.readFileSync('/opt/loop/x');
      fs.existsSync('/opt/current/unread.bin');`, '/home/user/app/reader.js')],
  });
  assert.deepEqual(plan.paths.sort(), ['opt/releases/v2/conf.bin', 'opt/releases/v2/data.bin', 'opt/releases/v2/data2.bin'],
    `the link targets are held: ${JSON.stringify(plan.paths)}`);
  assert.equal(plan.bytes, 2 * huge + PACKAGE_DATA_MAX_BYTES);
  assert.ok(ns.linkLookups > 0 && ns.linkLookups < 40 * 5, `only the sync reads' own components are asked: ${ns.linkLookups}`);
}

// A path folded to `'/' + <unknown>` names anything in the filesystem: it
// stages nothing (the read is a run-time one). A hole under a named
// directory still stages what it can match there.
{
  const ns = namespace({
    'opt/data/a.json': '{}',
    'opt/data/nested/b.json': '{}',
    'opt/other/c.json': '{}',
    'srv/x.txt': 'x',
    'etc/y.conf': 'y',
  });
  const plan = async (source) => planFacetData(ns, {
    cwd: '/home/user/app', home: '/home/user', closure: [],
    refs: [findStaticFsReferences(source, '/home/user/app/reader.js')],
  });
  const unbounded = await plan(`const fs = require('fs'); fs.readFileSync('/' + process.argv[2].split(',').join('/'));`);
  assert.deepEqual(unbounded.paths, [], `an unbounded root pattern stages nothing: ${JSON.stringify(unbounded.paths)}`);
  const bounded = await plan(`const fs = require('fs'); fs.readFileSync('/opt/data/' + process.argv[2]);`);
  assert.deepEqual(bounded.paths.sort(), ['opt/data/a.json', 'opt/data/nested/b.json'], 'a bounded pattern stages its match');
  const suffixed = await plan(`const fs = require('fs'); fs.readFileSync('/' + process.argv[2] + '.txt');`);
  assert.deepEqual(suffixed.paths, [], 'a root pattern with a known suffix stages only top-level names ending in it (none here)');
}

// A hole with a known prefix or suffix names siblings in its directory, not
// their subtrees; a bare hole under a named directory names its files but not
// what sits in dependency, VCS or cache directories, in any user's home.
{
  const ns = namespace({
    'hfile': 'h',
    'other': 'o',
    'home/user/notes.txt': 'n',
    'home/user/.git/objects/ab/cdef': 'blob',
    'home/user/.cache/tool/blob': 'cache',
    'home/bob/.config/app.json': '{}',
    'home/bob/.npm/_cacache/index': 'cache',
    'home/bob/proj/node_modules/p/data.json': '{}',
    'home/bob/proj/.next/cache/x': 'cache',
    'srv/app/locale-en/a.json': '{}',
    'srv/app/locale-en/deep/b.json': '{}',
    'srv/app/locale-en/huge.bin': big(PACKAGE_DATA_MAX_BYTES),
    'srv/app/locale-fr/node_modules/c.json': '{}',
    'srv/app/other/d.json': '{}',
  });
  const plan = async (source) => (await planFacetData(ns, {
    cwd: '/work', home: '/home/user', closure: [],
    refs: [findStaticFsReferences(source, '/work/reader.js')],
  })).paths.sort();
  assert.deepEqual(await plan(`require('fs').readFileSync('/h' + process.argv[2]);`), ['hfile'],
    'a root prefix names only matching names in /');
  assert.equal(ns.linkLookups, 0, 'no synchronous exact read: no link is resolved');
  assert.deepEqual(await plan(`require('fs').readFileSync('/home/' + process.argv[2]);`),
    ['home/bob/.config/app.json', 'home/user/notes.txt'], 'a bare hole under /home skips VCS, caches and dependencies');
  assert.deepEqual(await plan(`require('fs').readdirSync('/srv/app/locale-' + process.argv[2]);`), ['srv/app/locale-en/a.json'],
    'a matched directory adds its own data-sized files, one level');
}

// The working dir's own dependencies: the entries their package.json names,
// under every condition. A dev server reads them synchronously to pre-bundle
// what the app imports. Not code the process loads, not large files, not
// what a subpath pattern could name, not a package the project does not name.
{
  const ns = namespace({
    'home/user/app/package.json': JSON.stringify({ dependencies: { 'react-dom': '1', legacy: '1' }, devDependencies: { tool: '1' } }),
    'home/user/app/node_modules/react-dom/package.json': JSON.stringify({
      name: 'react-dom',
      exports: { '.': { 'react-server': './server.js', default: './index.js' }, './client': { default: './client.js' }, './*': './*.js', './package.json': './package.json' },
    }),
    'home/user/app/node_modules/react-dom/index.js': 'x',
    'home/user/app/node_modules/react-dom/server.js': 'x',
    'home/user/app/node_modules/react-dom/client.js': 'x',
    'home/user/app/node_modules/react-dom/cjs/react-dom.js': 'x',
    'home/user/app/node_modules/legacy/package.json': JSON.stringify({ name: 'legacy', main: 'lib/main', module: 'esm/index.mjs' }),
    'home/user/app/node_modules/legacy/lib/main.js': 'x',
    'home/user/app/node_modules/legacy/esm/index.mjs': 'x',
    'home/user/app/node_modules/tool/package.json': JSON.stringify({ name: 'tool', main: 'dist/tool.js' }),
    'home/user/app/node_modules/tool/dist/tool.js': big(PACKAGE_DATA_MAX_BYTES),
    'home/user/app/node_modules/transitive/package.json': JSON.stringify({ name: 'transitive' }),
    'home/user/app/node_modules/transitive/index.js': 'x',
  });
  const entries = await planFacetData(ns, {
    cwd: '/home/user/app', home: '/home/user', closure: ['home/user/app/node_modules/react-dom/server.js'], refs: [],
  });
  const planned = new Set(entries.paths);
  for (const path of ['react-dom/index.js', 'react-dom/client.js', 'legacy/lib/main.js', 'legacy/esm/index.mjs']) {
    assert.ok(planned.has(`home/user/app/node_modules/${path}`), `entry held: ${path}`);
  }
  for (const path of ['react-dom/server.js', 'react-dom/cjs/react-dom.js', 'tool/dist/tool.js', 'transitive/index.js']) {
    assert.ok(!planned.has(`home/user/app/node_modules/${path}`), `left out: ${path}`);
  }
  assert.equal(entries.rules.entries.files, 4);
}

// And the entries of their own dependencies: what a framework asks the dev
// server to pre-bundle on its own behalf. Astro's dev toolbar sets Vite's
// optimizeDeps.include to "astro > aria-query", "astro > axobject-query" and
// "astro > html-escaper"; Vite's optimizer reads their entries with
// readFileSync, which failed astro dev's first run whenever no earlier
// session's miss had been learned for them (astro-real, 2 of 15). Each is
// found from where the framework is installed, so its own nested copy
// before the hoisted one; not its dev dependencies, which are not installed,
// and not a level further.
{
  const ns = namespace({
    'home/user/app/package.json': JSON.stringify({ dependencies: { astro: '7' } }),
    'home/user/app/node_modules/astro/package.json': JSON.stringify({
      name: 'astro', main: 'dist/index.js',
      dependencies: { 'aria-query': '5', 'html-escaper': '3', escaper: '1' }, peerDependencies: { peer: '1' }, devDependencies: { devonly: '1' },
    }),
    'home/user/app/node_modules/astro/dist/index.js': 'x',
    'home/user/app/node_modules/aria-query/package.json': JSON.stringify({ name: 'aria-query', main: 'lib/index.js', dependencies: { deeper: '1' } }),
    'home/user/app/node_modules/aria-query/lib/index.js': 'x',
    'home/user/app/node_modules/html-escaper/package.json': JSON.stringify({ name: 'html-escaper', exports: { import: './esm/index.js', default: './cjs/index.js' } }),
    'home/user/app/node_modules/html-escaper/esm/index.js': 'x',
    'home/user/app/node_modules/html-escaper/cjs/index.js': 'x',
    'home/user/app/node_modules/escaper/package.json': JSON.stringify({ name: 'escaper', version: '2.0.0', main: 'hoisted.js' }),
    'home/user/app/node_modules/escaper/hoisted.js': 'x',
    'home/user/app/node_modules/astro/node_modules/escaper/package.json': JSON.stringify({ name: 'escaper', version: '1.0.0', main: 'nested.js' }),
    'home/user/app/node_modules/astro/node_modules/escaper/nested.js': 'x',
    'home/user/app/node_modules/peer/package.json': JSON.stringify({ name: 'peer', main: 'peer.js' }),
    'home/user/app/node_modules/peer/peer.js': 'x',
    'home/user/app/node_modules/devonly/package.json': JSON.stringify({ name: 'devonly', main: 'dev.js' }),
    'home/user/app/node_modules/devonly/dev.js': 'x',
    'home/user/app/node_modules/deeper/package.json': JSON.stringify({ name: 'deeper', main: 'deep.js' }),
    'home/user/app/node_modules/deeper/deep.js': 'x',
  });
  const entries = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: [], refs: [] });
  const planned = new Set(entries.paths);
  for (const path of ['astro/dist/index.js', 'aria-query/lib/index.js', 'html-escaper/esm/index.js', 'html-escaper/cjs/index.js',
    'astro/node_modules/escaper/nested.js', 'peer/peer.js']) {
    assert.ok(planned.has(`home/user/app/node_modules/${path}`), `entry held: ${path}`);
  }
  for (const path of ['escaper/hoisted.js', 'devonly/dev.js', 'deeper/deep.js']) {
    assert.ok(!planned.has(`home/user/app/node_modules/${path}`), `left out: ${path}`);
  }
}

// Speculative planning can oversample a main directory's metadata; it does
// not relax runtime resolution. Node does not implicitly append .cjs.
{
  const ns = namespace({
    'home/user/app/package.json': JSON.stringify({ dependencies: { nested: '1', cjs: '1' } }),
    'home/user/app/node_modules/nested/package.json': JSON.stringify({ name: 'nested', main: 'lib' }),
    'home/user/app/node_modules/nested/lib/package.json': JSON.stringify({ main: 'actual.cjs' }),
    'home/user/app/node_modules/nested/lib/actual.cjs': 'x',
    'home/user/app/node_modules/cjs/package.json': JSON.stringify({ name: 'cjs', main: 'dist/entry.cjs' }),
    'home/user/app/node_modules/cjs/dist/entry.cjs': 'x',
  });
  const plan = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: [], refs: [] });
  const planned = new Set(plan.paths);
  assert.ok(planned.has('home/user/app/node_modules/nested/lib/actual.cjs'), 'speculative directory metadata oversampling is retained');
  assert.ok(planned.has('home/user/app/node_modules/cjs/dist/entry.cjs'), 'an explicit .cjs main is named as Node requires it');
}

// A link on a mount whose backend resolves its own paths leads where that
// backend reads it, re-rooted at the mount point: the plan holds the mount's
// file, not one of SQLite's at the link's text (review of the consumers). The
// source is the manager's: a process's bridge, linkTargetOf.
{
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const device = new MemoryVFS();
  device.mkdir('/releases/v2', { recursive: true });
  device.writeFile('/releases/v2/data.bin', new Uint8Array(3));
  device.symlink('/releases/v2', '/current');
  files.vfs.mount('/pc', device, { resolvesPaths: true });
  // A file of SQLite's at the link's text, which the plan must not take.
  const kernel = files.bind({ pid: 8, cred: CRED_KERNEL });
  await kernel.mkdir('/releases/v2', { recursive: true });
  await kernel.writeFile('/releases/v2/data.bin', new Uint8Array(5));
  const bridge = files.bind({ pid: 7, cred: CRED_KERNEL });
  const view = new ProcessView(bridge);
  assert.equal(await linkTargetOf(bridge, '/pc/current'), '/pc/releases/v2', 'the link leads within the mount');
  assert.equal(await linkTargetOf(bridge, '/pc/releases'), null, 'a directory is no link');
  const plan = await planFacetData({
    list: async () => ({ entries: [], next: null }),
    readText: async (path) => view.readFileString(path).catch(() => null),
    linkTarget: (path) => linkTargetOf(bridge, path),
    stat: async (path) => { const st = await view.stat(path).catch(() => null); return st && { kind: st.type, size: st.size }; },
  }, {
    cwd: '/home/user/app', home: '/home/user', closure: [],
    refs: [findStaticFsReferences(`require('fs').readFileSync('/pc/current/data.bin');`, '/home/user/app/reader.js')],
  });
  assert.deepEqual(plan.paths, ['pc/releases/v2/data.bin'], `the mount's file is held: ${JSON.stringify(plan.paths)}`);
  assert.equal(plan.bytes, 3);
  await files.releaseProcess(7);
  await files.releaseProcess(8);
  harness.db.close();
}

// A process carrying Tailwind's oxide holds the sources its stylesheets name
// outside the working tree, through their relative imports: the scanner's
// reads cannot wait. A glob holds its directory prefix; `not` and inline()
// name nothing to hold. Without oxide, no stylesheet is read.
{
  const tree = {
    'home/user/app/package.json': '{"name":"app"}',
    'home/user/app/src/index.css': '@import "tailwindcss";\n@source "./local";\n@source inline("underline");\n@import "../../theme/theme.css";\n@import url("../../unused/unused.css");',
    'home/user/theme/theme.css': '@source "../shared";\n@source "../{kit,app}/**/*.tsx";\n@source not "../ignored";\n@source "/home/user/app/../linked/**";\n@source "../shared/.next/templates";\n@source "../quoted\'s";\n@source "../range/{1..1001}.tsx";\n@media screen { @import "./deeper.css"; }',
    'home/user/theme/deeper.css': '@source "../deep/*.tsx";',
    'home/user/unused/unused.css': '@source "../never";',
    'home/user/deep/Deep.tsx': 'd',
    'home/user/never/Never.tsx': 'n',
    'home/user/real-linked/L.tsx': 'l',
    'home/user/linked': { kind: 'symlink', size: 0, target: '/home/user/real-linked' },
    'home/user/shared/.next/cache.js': 'c',
    'home/user/shared/.next/templates/Card.tsx': 't',
    'home/user/shared/.cache': { kind: 'symlink', size: 0, target: '/home/user/srv-cache' },
    'home/user/srv-cache/c.js': 'c',
    'home/user/shared/widgets': { kind: 'symlink', size: 0, target: '/home/user/srv-widgets' },
    'home/user/srv-widgets/Old.tsx': 'w',
    "home/user/quoted's/Q.tsx": 'q',
    'home/user/range/1001.tsx': 'r',
    'home/user/range/1002.tsx': 'r',
    'home/user/app/src/local/a.tsx': 'x',
    'home/user/shared/Card.tsx': '<div class="bg-teal-700" />',
    'home/user/shared/node_modules/dep/index.js': 'x',
    'home/user/kit/ui/Button.tsx': 'y',
    'home/user/ignored/Thing.tsx': 'z',
    'home/user/app/node_modules/@tailwindcss/oxide/package.json': '{"name":"@tailwindcss/oxide"}',
    'home/user/app/node_modules/@tailwindcss/oxide/index.js': 'module.exports = {}',
  };
  const ns = namespace(tree);
  let listed = 0;
  for (let after = null; ;) { const page = await ns.list(after); listed += page.entries.length; if (page.next === null) break; after = page.next; }
  const reads = [];
  const readText = ns.readText;
  ns.readText = async (p) => { reads.push(p); return readText(p); };
  const oxide = ['home/user/app/node_modules/@tailwindcss/oxide/index.js'];
  const withOxide = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: oxide, refs: [] });
  const held = new Set(withOxide.paths);
  assert.ok(held.has('home/user/shared/Card.tsx'), 'a source outside the working tree is held, from a sheet outside it that an import after an @source names');
  assert.ok(held.has('home/user/kit/ui/Button.tsx'), 'each brace alternative holds its directory prefix');
  assert.ok(held.has('home/user/deep/Deep.tsx'), 'an import nested in a rule is followed, as Tailwind inlines it');
  assert.ok(held.has('home/user/real-linked/L.tsx'), 'an absolute source with dot segments, through a link, holds its target');
  assert.ok(!held.has('home/user/never/Never.tsx'), 'an @import url() is not followed');
  assert.ok(!held.has('home/user/ignored/Thing.tsx'), '`@source not` holds nothing');
  assert.ok(!held.has('home/user/shared/node_modules/dep/index.js'), 'a source\'s dependencies are not held');
  assert.ok(!held.has('home/user/shared/.next/cache.js'), 'nor its caches: the project rule\'s exclusions');
  assert.ok(held.has('home/user/shared/.next/templates/Card.tsx'), 'a root named below an excluded directory of another root holds its files');
  assert.ok(!held.has('home/user/srv-cache/c.js'), 'an excluded name is excluded through a link, by its name below the root');
  assert.ok(held.has('home/user/srv-widgets/Old.tsx') && withOxide.sourceRoots.includes('/home/user/srv-widgets'), 'a directory a link leads to out of the roots is held, and pushed');
  assert.ok(held.has("home/user/quoted's/Q.tsx"), 'a quote is a filename character');
  assert.ok(held.has('home/user/range/1001.tsx') && !held.has('home/user/range/1002.tsx'), 'a range of any length expands, to the files it names');
  assert.deepEqual(withOxide.sourceRoots.slice(0, 4), ['/home/user/shared', '/home/user/kit', '/home/user/real-linked', '/home/user/shared/.next/templates'], 'the plan names the roots outside the tree, for the barriers to push');
  assert.ok(withOxide.sourceRoots.includes("/home/user/quoted's") && withOxide.sourceRoots.includes('/home/user/range/1001.tsx') && withOxide.sourceRoots.includes('/home/user/deep'));
  assert.equal(withOxide.rules['stylesheet-source'].files, 8);
  assert.equal(withOxide.names, listed, 'the namespace is counted once, however many walks');
  const without = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: [], refs: [] });
  assert.ok(!new Set(without.paths).has('home/user/shared/Card.tsx'), 'without oxide, the source is not held');
  assert.deepEqual(without.sourceRoots, []);
  assert.deepEqual(reads.filter((p) => p.endsWith('.css')).sort(), ['home/user/app/src/index.css', 'home/user/theme/deeper.css', 'home/user/theme/theme.css'], 'only an oxide process reads the stylesheets, each once');
  // A one-shot, which lists no namespace, applies the same rule from the sheets its bundle holds.
  const direct = await planStylesheetSources(ns, { cwd: '/home/user/app', home: '/home/user', sheets: ['home/user/app/src/index.css'] });
  assert.deepEqual(direct.files.map((f) => f.path).sort(), withOxide.paths.filter((p) => !p.startsWith('home/user/app/') && !p.startsWith('home/user/theme/')).sort(), 'a one-shot holds the same files, from its stylesheets alone');
  assert.deepEqual(direct.roots, withOxide.sourceRoots);
}

// A source can name a tree of any size, or as many files: the rule holds at
// most STYLESHEET_SOURCE_MAX_FILES files, each under the package-data bound,
// and returns where it stopped, for the launch to say so. The rest are
// learned from the scanner's misses.
{
  const tree = {
    'home/user/app/src/index.css': '@import "tailwindcss";\n@source "../..";',
    'home/user/aaa/small.tsx': 'held',
    'home/user/aab/huge.tsx': big(PACKAGE_DATA_MAX_BYTES),
  };
  for (let i = 0; i < STYLESHEET_SOURCE_MAX_FILES + 50; i++) tree[`home/user/big/f${String(i).padStart(5, '0')}.tsx`] = 'x';
  const ns = namespace(tree);
  const found = await planStylesheetSources(ns, { cwd: '/home/user/app', home: '/home/user', sheets: ['home/user/app/src/index.css'] });
  const held = new Set(found.files.map((f) => f.path));
  assert.equal(found.files.length, STYLESHEET_SOURCE_MAX_FILES, 'the walk holds no more than the bound');
  assert.ok(held.has('home/user/aaa/small.tsx'), 'a file under the bounds is held');
  assert.ok(!held.has('home/user/aab/huge.tsx'), 'a file over the package-data bound is not');
  assert.equal(found.stopped, '/home/user', 'it names where it stopped');
  const planned = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: ['home/user/app/node_modules/@tailwindcss/oxide/index.js'], refs: [] });
  assert.equal(planned.sourcesStopped, '/home/user', 'a resident\'s plan carries where it stopped');

  // Files a source names one by one count toward the same bound.
  const named = { 'home/user/app/src/index.css': `@import "tailwindcss";\n@source "../../each/{0..${STYLESHEET_SOURCE_MAX_FILES + 49}}.tsx";` };
  for (let i = 0; i < STYLESHEET_SOURCE_MAX_FILES + 50; i++) named[`home/user/each/${i}.tsx`] = 'x';
  const byName = await planStylesheetSources(namespace(named), { cwd: '/home/user/app', home: '/home/user', sheets: ['home/user/app/src/index.css'] });
  assert.equal(byName.files.length, STYLESHEET_SOURCE_MAX_FILES, 'files named one by one are bounded too');
  assert.ok(byName.stopped !== null, 'and say where they stopped');
}

// The project's stylesheets behind its links are its stylesheets: a sheet
// is where its links lead, which what it names is relative to, as Tailwind
// resolves it, and it is read once however many names lead to it.
{
  const tree = {
    'home/user/app/package.json': '{"name":"app"}',
    'home/user/app/src/index.css': { kind: 'symlink', size: 0, target: '/srv/theme/index.css' },
    'srv/theme/index.css': '@source "../components";',
    'srv/components/A.tsx': 'a',
    'home/user/app/styles': { kind: 'symlink', size: 0, target: '/srv/kit' },
    'srv/kit/kit.css': '@source "../kit-src";',
    'srv/kit-src/B.tsx': 'b',
    'home/user/app/src/main.css': '@import "../../theme/alias.css";\n@import "/srv/design/theme.css";',
    'home/user/theme/alias.css': { kind: 'symlink', size: 0, target: '/srv/design/theme.css' },
    'srv/design/theme.css': '@source "./components";',
    'srv/design/components/C.tsx': 'c',
    'home/user/theme/components/Wrong.tsx': 'w',
    'home/user/app/node_modules/@tailwindcss/oxide/package.json': '{"name":"@tailwindcss/oxide"}',
    'home/user/app/node_modules/@tailwindcss/oxide/index.js': 'module.exports = {}',
  };
  const ns = namespace(tree);
  const reads = [];
  const readText = ns.readText;
  ns.readText = async (p) => { reads.push(p); return readText(p); };
  const plan = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: ['home/user/app/node_modules/@tailwindcss/oxide/index.js'], refs: [] });
  const held = new Set(plan.paths);
  assert.ok(held.has('srv/components/A.tsx'), 'a project stylesheet that is a link names its sources from where it leads');
  assert.ok(held.has('srv/kit-src/B.tsx'), 'and one in a linked project directory');
  assert.ok(held.has('srv/design/components/C.tsx'), 'an imported sheet behind a link names its sources from where it is');
  assert.ok(!held.has('home/user/theme/components/Wrong.tsx'), 'not from where the link is');
  assert.equal(reads.filter((p) => p === 'srv/design/theme.css').length, 1, 'a sheet two names lead to is read once');
}

// A directory's exclusions are of the name it is walked under: the order of
// the @source directives does not change what is held.
{
  const tree = {
    'home/user/.cache/widgets/Card.tsx': 'c',
    'home/user/shared/widgets': { kind: 'symlink', size: 0, target: '/home/user/.cache/widgets' },
    'home/user/shared/S.tsx': 's',
    'home/user/app/a.css': '@source "/home/user/.cache/widgets";\n@source "/home/user/shared";',
    'home/user/app/b.css': '@source "/home/user/shared";\n@source "/home/user/.cache/widgets";',
  };
  const ns = namespace(tree);
  for (const sheet of ['home/user/app/a.css', 'home/user/app/b.css']) {
    const found = await planStylesheetSources(ns, { cwd: '/home/user/app', home: '/home/user', sheets: [sheet] });
    assert.deepEqual(found.files.map((f) => f.path).sort(), ['home/user/.cache/widgets/Card.tsx', 'home/user/shared/S.tsx'],
      `${sheet}: a directory a root leaves out is walked under another root's name for it`);
  }
}

// A source on a mount the process's listing walks only where its launch
// names: the plan names where it read there, so the listing the process
// boots from holds what the plan holds, and the plan counts the names that
// adds. The source may be the mount, a directory above it, a file on it, or
// a directory below its root, whose listing brings its parents' entries.
async function mountedSource(label, sheet, mounts, sqlite, held) {
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const text = (value) => new TextEncoder().encode(value);
  const kernel = files.bind({ pid: 8, cred: CRED_KERNEL });
  const write = async (path, value) => {
    await kernel.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await kernel.writeFile(path, text(value));
  };
  await write('/home/user/app/src/index.css', sheet);
  await write('/home/user/app/node_modules/@tailwindcss/oxide/index.js', 'module.exports = {}');
  for (const [path, value] of Object.entries(sqlite)) await write(path, value);
  for (const [point, tree] of Object.entries(mounts)) {
    const device = new MemoryVFS();
    for (const [path, value] of Object.entries(tree)) {
      device.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
      device.writeFile(path, text(value));
    }
    await kernel.mkdir(point, { recursive: true });
    files.vfs.mount(point, device);
  }
  const binding = { pid: 7, cred: CRED_KERNEL };
  const bridge = files.bind(binding);
  const view = new ProcessView(bridge);
  files.nameLaunch(binding, () => ['/home/user/app']);
  const listing = async () => {
    const out = [];
    for (let after = null; ;) {
      const page = await bridge.list(after, 500);
      out.push(...page.entries.map((entry) => entry.path));
      if (page.next === null) return out;
      after = page.next;
    }
  };
  const plan = await planFacetData({
    list: async (after) => bridge.list(after, 500),
    readText: async (path) => view.readFileString(path).catch(() => null),
    linkTarget: (path) => linkTargetOf(bridge, path),
    stat: async (path) => { const st = await view.stat(path).catch(() => null); return st && { kind: st.type, size: st.size }; },
    readdir: async (dir) => {
      const entries = await Promise.resolve(bridge.readdir('/' + dir)).catch(() => null);
      if (entries === null) return null;
      return Promise.all(entries.map(async ({ name, type }) => {
        const path = dir === '' ? name : `${dir}/${name}`;
        const st = type === 'file' ? await view.stat(path).catch(() => null) : null;
        return { path, kind: type, size: st?.size ?? 0 };
      }));
    },
  }, {
    cwd: '/home/user/app', home: '/home/user', refs: [],
    closure: ['home/user/app/node_modules/@tailwindcss/oxide/index.js'],
    nameSources: (read) => files.nameLaunch(binding, () => read),
  });
  const booted = await listing();
  for (const path of held) {
    assert.ok(plan.paths.includes(path), `${label}: the mount's source ${path} is held: ${JSON.stringify(plan.paths)}`);
    assert.ok(booted.includes(path), `${label}: and the listing the process boots from holds it`);
  }
  assert.equal(plan.names, booted.length, `${label}: the plan counts the names that listing holds`);
  await files.releaseProcess(7);
  await files.releaseProcess(8);
  harness.db.close();
}
await mountedSource('the mount', '@source "/shared-ui";', { '/shared-ui': { '/ui/Card.tsx': 'c' } }, {}, ['shared-ui/ui/Card.tsx']);
await mountedSource('a directory above it', '@source "/shared";', { '/shared/ui': { '/Card.tsx': 'c' } },
  { '/shared/S.tsx': 's' }, ['shared/ui/Card.tsx', 'shared/S.tsx']);
await mountedSource('a file on it', '@source "/files/Card.tsx";', { '/files': { '/Card.tsx': 'c', '/Other.tsx': 'o', '/sub/X.tsx': 'x' } }, {}, ['files/Card.tsx']);
await mountedSource('a directory below its root', '@source "/kit/ui/buttons";',
  { '/kit': { '/ui/buttons/B.tsx': 'b', '/ui/cards/C.tsx': 'c', '/top.txt': 't' } }, {}, ['kit/ui/buttons/B.tsx']);

console.log('data-plan: ok');
