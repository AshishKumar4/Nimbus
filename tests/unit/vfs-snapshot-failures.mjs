#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { snapshotVfs } from '../../packages/worker/src/runtime/vfs-snapshot.ts';

function fakeVfs({ readdir, readFile }) {
  return {
    exists: () => true,
    isDirectory: () => true,
    readdir,
    readFile,
    writeFile() {},
    mkdir() {},
    unlink() {},
    rmdir() {},
  };
}

{
  const result = snapshotVfs(fakeVfs({
    readdir() {
      throw new Error('directory unavailable');
    },
    readFile() {
      throw new Error('unreachable');
    },
  }), 'workspace');
  assert.deepEqual(result, {
    error: 'runtime filesystem snapshot incomplete: readdir workspace: directory unavailable',
  });
}

{
  const result = snapshotVfs(fakeVfs({
    readdir(path) {
      if (path === 'workspace') {
        return [
          { name: 'good.txt', type: 'file' },
          { name: 'bad.txt', type: 'file' },
        ];
      }
      return [];
    },
    readFile(path) {
      if (path.endsWith('bad.txt')) throw new Error('corrupt bytes');
      return new Uint8Array([1, 2, 3]);
    },
  }), 'workspace');
  assert.deepEqual(result, {
    error: 'runtime filesystem snapshot incomplete: readFile workspace/bad.txt: corrupt bytes',
  });
}

console.log('vfs-snapshot-failures: all assertions passed');
