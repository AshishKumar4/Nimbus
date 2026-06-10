#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { prefetchForRequire } from '../../packages/worker/src/runtime/require-resolver.ts';

class FakeVfs {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  exists(path) {
    return this.files.has(path) || this.dirs.has(path);
  }

  isDirectory(path) {
    return this.dirs.has(path);
  }

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
    return Array.from(entries, ([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

const nm = 'home/user/node_modules';
const vfs = new FakeVfs({
  'home/user/app.js': "require('@scope/pkg/oauth');",
  [`${nm}/@scope/pkg/package.json`]: JSON.stringify({
    name: '@scope/pkg',
    type: 'module',
    exports: {
      './oauth': {
        types: './dist/oauth.d.ts',
        import: './dist/oauth.js',
      },
    },
  }),
  [`${nm}/@scope/pkg/dist/oauth.js`]: 'export const ok = true;',
});

const result = prefetchForRequire(vfs, "require('@scope/pkg/oauth');", '/home/user', '/home/user/app.js');
assert.equal(result.bundle[`${nm}/@scope/pkg/dist/oauth.js`], 'export const ok = true;');

// A CLI entry that defers via a static-string dynamic import must have the
// imported subtree's content prefetched (regression: create-astro.mjs does
// `import('./dist/index.js').then(({main}) => main())`; without following it
// the runtime resolves the path but can't read the content → silent exit).
const dynVfs = new FakeVfs({
  'home/user/cli/create-astro.mjs': "import('./dist/index.js').then(({main}) => main());",
  'home/user/cli/dist/index.js': "import './sibling.js'; export function main() {}",
  'home/user/cli/dist/sibling.js': 'export const x = 1;',
});
const dynResult = prefetchForRequire(
  dynVfs,
  "import('./dist/index.js').then(({main}) => main());",
  '/home/user/cli',
  '/home/user/cli/create-astro.mjs',
);
assert.equal(
  dynResult.bundle['home/user/cli/dist/index.js'],
  "import './sibling.js'; export function main() {}",
  'dynamic-import target not prefetched',
);
assert.equal(
  dynResult.bundle['home/user/cli/dist/sibling.js'],
  'export const x = 1;',
  'dynamic-import target subtree not recursively prefetched',
);

// Parent-relative package main: a subdir package.json whose main points at
// "../dist/x" must resolve through the normalized path (regression:
// web-streams-polyfill's ponyfill/package.json -> "../dist/ponyfill").
const relVfs = new FakeVfs({
  'home/user/app2.js': "require('wsp/ponyfill');",
  [`${nm}/wsp/package.json`]: JSON.stringify({ name: 'wsp', main: 'dist/polyfill' }),
  [`${nm}/wsp/dist/polyfill.js`]: 'module.exports = {};',
  [`${nm}/wsp/dist/ponyfill.js`]: 'module.exports = { ponyfill: true };',
  [`${nm}/wsp/ponyfill/package.json`]: JSON.stringify({ name: 'wsp-ponyfill', main: '../dist/ponyfill' }),
});
const relResult = prefetchForRequire(relVfs, "require('wsp/ponyfill');", '/home/user', '/home/user/app2.js');
assert.equal(
  relResult.bundle[`${nm}/wsp/dist/ponyfill.js`],
  'module.exports = { ponyfill: true };',
  'parent-relative package main not resolved/prefetched',
);

console.log('require-resolver: ok');
