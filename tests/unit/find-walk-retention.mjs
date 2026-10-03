#!/usr/bin/env bun
// find's walk holds what fts holds: the directories it is inside, the
// entries of each, and what it has read ahead within its window. What it has
// finished with is let go, so `find /` over a few hundred thousand files does
// not grow to the size of the tree.
//
// The walk runs over a synthetic file system, 1,000 directories of 200 files
// answered from arithmetic, so the only memory that grows with the tree is
// the walk's own. The heap is measured after a full collection at intervals;
// past the first tenth of the walk it must stay level, read ahead or not.

import assert from 'node:assert/strict';
import { Walker } from '../../packages/core/src/substrate/lifo/commands/fs/find/walk.ts';

const DIRECTORIES = 1000;
const FILES = 200;
const ENTRIES = 1 + DIRECTORIES * (FILES + 1);
const SAMPLES = 10;
/** The most the retained heap may grow from the first tenth of the walk to the last. */
const ALLOWED_GROWTH = 4 * 1024 * 1024;
/** The most the read-ahead window (4,096 entries, each with its stats) may hold. */
const WINDOW = 8 * 1024 * 1024;

const directory = /^\/t(?:\/d\d+)?$/;
let inode = 0;
const vfs = {
  async readdir(path) {
    if (path === '/t') return Array.from({ length: DIRECTORIES }, (_, i) => ({ name: `d${i}`, type: 'directory' }));
    return Array.from({ length: FILES }, (_, i) => ({ name: `f${i}`, type: 'file' }));
  },
  async stat(path) {
    const isDirectory = directory.test(path);
    return {
      type: isDirectory ? 'directory' : 'file', size: 1, mode: isDirectory ? 0o40755 : 0o100644,
      uid: 1000, gid: 1000, mtimeMs: 0, atimeMs: 0, ctimeMs: 0, ino: ++inode, nlink: 1, dev: 1,
    };
  },
};

async function retained(readAhead) {
  const heap = [];
  let visited = 0;
  const walker = new Walker({
    vfs,
    cwd: '/',
    symlinks: 'P',
    maxDepth: Infinity,
    minDepth: 0,
    depthFirst: false,
    sameDevice: false,
    ignoreVanished: false,
    readAhead,
    prefetchStats: readAhead > 0,
    readAheadSubtrees: true,
    signal: new AbortController().signal,
    report: async (message) => { throw new Error(message); },
  }, {
    event: async () => {},
    visit: async () => {
      if (++visited % Math.floor(ENTRIES / SAMPLES) === 0) {
        Bun.gc(true);
        heap.push(process.memoryUsage().heapUsed);
      }
      return 'continue';
    },
  });
  await walker.run(['/t']);
  await walker.settled();
  assert.equal(visited, ENTRIES);
  return heap;
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const most = {};
for (const readAhead of [0, 16]) {
  const heap = await retained(readAhead);
  const growth = Math.max(...heap.slice(1)) - heap[0];
  most[readAhead] = Math.max(...heap);
  console.log(`read-ahead ${readAhead}: retained ${heap.map(mib).join(', ')}`);
  assert.ok(growth < ALLOWED_GROWTH, `read-ahead ${readAhead}: the walk keeps what it has finished with (${mib(growth)} more after ${ENTRIES} entries)`);
}
// The window is counted in entries, so it costs a few megabytes whatever the tree.
assert.ok(most[16] - most[0] < WINDOW, `the read-ahead window holds ${mib(most[16] - most[0])}`);
console.log(`find-walk-retention: ${ENTRIES} entries, retained heap level, read ahead or not`);
