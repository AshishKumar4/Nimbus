#!/usr/bin/env bun
// data-plan: which contents a resident node process holds from launch, by
// rule, over a namespace — and what it leaves out.

import assert from 'node:assert/strict';
import { planFacetData, PACKAGE_DATA_MAX_BYTES } from '../../packages/worker/src/facets/data-plan.ts';
import { findStaticFsReferences } from '../../packages/core/src/runtime/static-fs-refs.ts';

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
    stat: async (p) => { const e = all.get(p.replace(/^\/+/, '')); return e ? { kind: e.kind, size: e.size } : null; },
    readlinks: 0,
    async readlink(p) {
      this.readlinks++;
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
assert.equal(source.readlinks, 0, 'a plan with no synchronous reads resolves no links');

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
  assert.ok(ns.readlinks > 0 && ns.readlinks < 40 * 5, `only the sync reads' own components are asked: ${ns.readlinks}`);
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
  assert.equal(ns.readlinks, 0, 'no synchronous exact read: no link is resolved');
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

// An entry is the file Node's resolver loads for it, as the module-map walk
// resolves it (require-resolution.ts): a `main` naming a directory goes
// through that directory's own package.json `main`, and an extensionless
// one through every extension Node tries.
{
  const ns = namespace({
    'home/user/app/package.json': JSON.stringify({ dependencies: { nested: '1', cjs: '1' } }),
    'home/user/app/node_modules/nested/package.json': JSON.stringify({ name: 'nested', main: 'lib' }),
    'home/user/app/node_modules/nested/lib/package.json': JSON.stringify({ main: 'actual.cjs' }),
    'home/user/app/node_modules/nested/lib/actual.cjs': 'x',
    'home/user/app/node_modules/cjs/package.json': JSON.stringify({ name: 'cjs', main: 'dist/entry' }),
    'home/user/app/node_modules/cjs/dist/entry.cjs': 'x',
  });
  const plan = await planFacetData(ns, { cwd: '/home/user/app', home: '/home/user', closure: [], refs: [] });
  const planned = new Set(plan.paths);
  assert.ok(planned.has('home/user/app/node_modules/nested/lib/actual.cjs'), "a directory main through its own package.json's main");
  assert.ok(planned.has('home/user/app/node_modules/cjs/dist/entry.cjs'), 'an extensionless main as Node probes it');
}

console.log('data-plan: ok');
