#!/usr/bin/env bun
// require-resolver-nested-placement — a package nested under its dependent
// is what that dependent's `require` finds; everyone else finds root.
//
// The installer resolves version conflicts by placing the losing
// dependent's copy at `<dependent>/node_modules/<name>` and nowhere higher
// (see tests/unit/npm-install-nested-conflict.mjs for the nuxt/confbox case
// that needed it). That is only correct because the runtime resolver walks
// `node_modules` directories upward from the importing FILE: from a file in
// b, `b/node_modules/c` is found before `node_modules/c`; from a file in a,
// there is no `a/node_modules/c`, so the walk reaches root. Pinned here
// through the prefetch walker, which resolves with the same function the
// runtime `require` uses, over a VFS laid out exactly as the installer
// leaves it.

import assert from 'node:assert/strict';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';

class FakeVfs {
  get authority() { return { acquire: async () => ({ epoch: this.epoch, rev: this.revision() }), stat: async (path) => this.lstat(path) }; }

  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  exists(path) { return this.files.has(path) || this.dirs.has(path); }
  isDirectory(path) { return this.dirs.has(path); }
  readFileString(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    return this.files.get(path);
  }
  readdir(path) {
    const prefix = path ? `${path}/` : '';
    const entries = new Map();
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'directory');
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'file');
    }
    return Array.from(entries, ([name, type]) => ({ name, type })).sort((x, y) => x.name.localeCompare(y.name));
  }
}

const nm = 'home/user/app/node_modules';
const ROOT_C = 'module.exports = { c: "1.0.0" };';
const NESTED_C = 'module.exports = { c: "2.0.0" };';
const vfs = new FakeVfs({
  'home/user/app/main.js': "require('a'); require('b');",
  [`${nm}/a/package.json`]: JSON.stringify({ name: 'a', version: '1.0.0', main: 'index.js' }),
  [`${nm}/a/index.js`]: "module.exports = require('c');",
  [`${nm}/b/package.json`]: JSON.stringify({ name: 'b', version: '1.0.0', main: 'index.js' }),
  [`${nm}/b/index.js`]: "module.exports = require('c');",
  [`${nm}/c/package.json`]: JSON.stringify({ name: 'c', version: '1.0.0', main: 'index.js' }),
  [`${nm}/c/index.js`]: ROOT_C,
  [`${nm}/b/node_modules/c/package.json`]: JSON.stringify({ name: 'c', version: '2.0.0', main: 'index.js' }),
  [`${nm}/b/node_modules/c/index.js`]: NESTED_C,
});

// From b's file, the walk finds b's own node_modules first.
{
  const r = await prefetchForRequire(vfs, "require('c');", '/home/user/app', `/${nm}/b/index.js`);
  assert.equal(r.bundle[`${nm}/b/node_modules/c/index.js`], NESTED_C, "require('c') from b resolves to the nested copy");
  assert.equal(r.bundle[`${nm}/c/index.js`], undefined, 'and never reaches the root copy');
  console.log('  from b: b/node_modules/c');
}

// From a's file, there is no a/node_modules/c, so the walk reaches root.
{
  const r = await prefetchForRequire(vfs, "require('c');", '/home/user/app', `/${nm}/a/index.js`);
  assert.equal(r.bundle[`${nm}/c/index.js`], ROOT_C, "require('c') from a resolves to the root copy");
  assert.equal(r.bundle[`${nm}/b/node_modules/c/index.js`], undefined, "b's copy is invisible to a");
  console.log('  from a: node_modules/c');
}

// The whole closure from the app entry carries both copies, each reached
// through the dependent that needs it.
{
  const r = await prefetchForRequire(vfs, "require('a'); require('b');", '/home/user/app', '/home/user/app/main.js');
  assert.equal(r.bundle[`${nm}/c/index.js`], ROOT_C);
  assert.equal(r.bundle[`${nm}/b/node_modules/c/index.js`], NESTED_C);
  assert.equal(r.bundle[`${nm}/b/node_modules/c/package.json`], JSON.stringify({ name: 'c', version: '2.0.0', main: 'index.js' }), 'the nested manifest ships too');
  console.log('  from main: both copies, each under its dependent');
}

console.log('require-resolver-nested-placement: ok');
