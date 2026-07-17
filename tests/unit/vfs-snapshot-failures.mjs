#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { snapshotVfs } from '../../packages/worker/src/runtime/vfs-snapshot.ts';

function fakeVfs({ readdir, readFile }) {
  return {
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    exists: () => true,
    isDirectory: () => true,
    access() {},
    stat: () => ({ type: 'file', size: 3, atime: 0, ctime: 0, mtime: 0, mode: 0o644, uid: 1000, gid: 1000 }),
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
