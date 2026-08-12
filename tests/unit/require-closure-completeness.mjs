#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';

class FakeVfs {
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const file of this.files.keys()) {
      const parts = file.split('/');
      for (let index = 1; index < parts.length; index++) {
        this.dirs.add(parts.slice(0, index).join('/'));
      }
    }
  }

  exists(path) {
    return this.files.has(path) || this.dirs.has(path);
  }

  isDirectory(path) {
    return this.dirs.has(path);
  }

  readFileString(path) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing file: ${path}`);
    return content;
  }
}

const root = 'usr/local/lib/node_modules';
const entryPath = `${root}/large-cli/index.js`;
const readShebangPath = `${root}/cross-spawn/lib/util/readShebang.js`;
const shebangCommandPath = `${root}/shebang-command/index.js`;

function crossSpawnFixture() {
  return {
    [`${root}/cross-spawn/package.json`]: JSON.stringify({
      name: 'cross-spawn',
      main: 'index.js',
    }),
    [`${root}/cross-spawn/index.js`]: "require('./lib/parse');",
    [`${root}/cross-spawn/lib/parse.js`]: "require('./util/readShebang');",
    [readShebangPath]: "module.exports = require('shebang-command');",
    [`${root}/shebang-command/package.json`]: JSON.stringify({
      name: 'shebang-command',
      main: 'index.js',
    }),
    [shebangCommandPath]: 'module.exports = () => "node";',
  };
}

function prefetch(files) {
  const vfs = new FakeVfs(files);
  return prefetchForRequire(vfs, files[entryPath], '/home/user', `/${entryPath}`);
}

const missingRequiredLeaves = [];

{
  const bulkRoot = `${root}/bulk-files`;
  const bulkRequires = [];
  const files = {
    ...crossSpawnFixture(),
    [`${bulkRoot}/package.json`]: JSON.stringify({ name: 'bulk-files', main: 'index.js' }),
  };
  for (let index = 0; index < 3994; index++) {
    const name = `part-${String(index).padStart(4, '0')}`;
    bulkRequires.push(`require('./${name}');`);
    files[`${bulkRoot}/${name}.js`] = 'module.exports = true;';
  }
  files[`${bulkRoot}/index.js`] = bulkRequires.join('\n');
  files[entryPath] = "require('bulk-files');\nrequire('cross-spawn');";

  const result = prefetch(files);
  assert.equal(
    result.bundle[readShebangPath],
    files[readShebangPath],
    'the large file-count fixture must reach cross-spawn before its transitive leaf',
  );
  if (result.bundle[shebangCommandPath] !== files[shebangCommandPath]) {
    missingRequiredLeaves.push('4,000-file closure');
  }
}

{
  const maxRawBytes = 24 * 1024 * 1024;
  const bulkRoot = `${root}/bulk-bytes`;
  const bulkRequires = [];
  const files = {
    ...crossSpawnFixture(),
    [`${bulkRoot}/package.json`]: JSON.stringify({ name: 'bulk-bytes', main: 'index.js' }),
  };
  const oneMiB = ' '.repeat(1024 * 1024);
  for (let index = 0; index < 22; index++) {
    const name = `part-${String(index).padStart(2, '0')}`;
    bulkRequires.push(`require('./${name}');`);
    files[`${bulkRoot}/${name}.js`] = oneMiB;
  }
  bulkRequires.push("require('./tail');");
  files[`${bulkRoot}/index.js`] = bulkRequires.join('\n');
  files[entryPath] = "require('bulk-bytes');\nrequire('cross-spawn');";

  const bytesBeforeTail =
    files[`${bulkRoot}/package.json`].length
    + files[`${bulkRoot}/index.js`].length
    + oneMiB.length * 22;
  const crossSpawnBytesBeforeLeaf =
    files[`${root}/cross-spawn/package.json`].length
    + files[`${root}/cross-spawn/index.js`].length
    + files[`${root}/cross-spawn/lib/parse.js`].length
    + files[readShebangPath].length;
  files[`${bulkRoot}/tail.js`] = ' '.repeat(
    maxRawBytes - bytesBeforeTail - crossSpawnBytesBeforeLeaf,
  );

  const result = prefetch(files);
  assert.equal(
    result.bundle[readShebangPath],
    files[readShebangPath],
    'the large byte-count fixture must reach cross-spawn before its transitive leaf',
  );
  if (result.bundle[shebangCommandPath] !== files[shebangCommandPath]) {
    missingRequiredLeaves.push('24-MiB closure');
  }
}

assert.deepEqual(
  missingRequiredLeaves,
  [],
  'required transitive modules must never be dropped from a large closure',
);

console.log('require closure completeness: ok');
