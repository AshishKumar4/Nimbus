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

console.log('data-plan: ok');
