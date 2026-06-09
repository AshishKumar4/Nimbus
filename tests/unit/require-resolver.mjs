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

console.log('require-resolver: ok');
