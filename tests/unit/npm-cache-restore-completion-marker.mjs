#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { buildCacheRestorePayload } from '../../packages/worker/src/npm/tarball.ts';

const pkg = {
  name: 'ordered-package',
  version: '1.2.3',
  tarballUrl: 'https://registry.invalid/ordered-package.tgz',
  integrity: '',
  dependencies: {},
  exports: null,
  main: '',
  module: '',
  bin: {},
};
const hoistPlan = { root: new Map([[pkg.name, pkg]]), nested: new Map() };
const files = [
  { relPath: 'package.json', data: new TextEncoder().encode('{"name":"ordered-package"}'), size: 26 },
  { relPath: 'index.js', data: new TextEncoder().encode('export default 1'), size: 16 },
  { relPath: 'lib/value.js', data: new TextEncoder().encode('export const value = 1'), size: 22 },
];
const cache = { getTarballFiles: () => files };

const payload = buildCacheRestorePayload([pkg], hoistPlan, 'node_modules', cache);
const filePaths = payload.inodes.filter((inode) => !inode.isDir).map((inode) => inode.path);
assert.deepEqual(filePaths, [
  'node_modules/ordered-package/index.js',
  'node_modules/ordered-package/lib/value.js',
  'node_modules/ordered-package/package.json',
]);
assert.equal(
  payload.chunks.at(-1)?.path,
  'node_modules/ordered-package/package.json',
  'completion marker chunks must be emitted after every other package file',
);

assert.throws(
  () => buildCacheRestorePayload(
    [pkg],
    hoistPlan,
    'node_modules',
    { getTarballFiles: () => files.filter((file) => file.relPath !== 'package.json') },
  ),
  /has 0 root package\.json entries/,
);

console.log('npm-cache-restore-completion-marker: all assertions passed');
