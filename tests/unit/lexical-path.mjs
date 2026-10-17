#!/usr/bin/env bun
// One root-clamped lexical path reduction (rootClampedSegments), and the
// shapes its adapters keep: repeated slashes, '.', a '..' past the root,
// empty and root paths, and trailing slashes, through the entry points that
// reduce a path lexically (VFS keys, MemoryVFS lookups, the launch's named
// paths, a module's relative wasm images).

import assert from 'node:assert/strict';
import { rootClampedSegments } from '../../packages/platform/src/lexical-path.ts';
import { normalizeVfsPath } from '../../packages/core/src/vfs/path.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { launchNamedPaths } from '../../packages/core/src/runtime/os-contracts.ts';
import { relativeWasmPaths } from '../../packages/core/src/_shared/relative-wasm-paths.ts';

const cases = [
  ['', []],
  ['/', []],
  ['//', []],
  ['.', []],
  ['..', []],
  ['/..', []],
  ['/../../a', ['a']],
  ['a//b///c', ['a', 'b', 'c']],
  ['/a/./b/.', ['a', 'b']],
  ['/a/b/../../../c/', ['c']],
  ['a/b/', ['a', 'b']],
  ['./a/../..', []],
  ['...', ['...']],
  ['a/..b/.c', ['a', '..b', '.c']],
];
for (const [path, segments] of cases) {
  assert.deepEqual(rootClampedSegments(path), segments, `rootClampedSegments(${JSON.stringify(path)})`);
  assert.equal(normalizeVfsPath(path), segments.join('/'), `normalizeVfsPath(${JSON.stringify(path)}) is its key`);
}

// MemoryVFS resolves the same spellings to the same file, and keeps a '..'
// past its root at the root.
const memory = new MemoryVFS({ uid: 0, gid: 0 });
memory.mkdir('/a/b', { recursive: true });
memory.writeFile('/a/b/f', new TextEncoder().encode('x'));
for (const spelling of ['/a/b/f', 'a//b/./f', '/../a/b/../b/f', '/a/b/c/../f']) {
  assert.equal(memory.stat(spelling)?.size, 1, `MemoryVFS finds ${spelling}`);
}

// The launch's named paths are absolute, anchored at cwd (a trailing slash on
// it is no name), and clamped at the root.
assert.deepEqual(
  launchNamedPaths('/home/user/', 'bin/../run.js', ['-v', './x//y/', '/../../etc', '']),
  ['/home/user/run.js', '/home/user/x/y', '/etc'],
);

// A module's relative wasm images are keys beside it, clamped at the root.
assert.deepEqual(
  relativeWasmPaths(`fetch("./a.wasm"); load('../../../b.wasm'); x = \`./c/../d.wasm\``, '/pkg/lib/index.js').sort(),
  ['b.wasm', 'pkg/lib/a.wasm', 'pkg/lib/d.wasm'],
);

console.log('lexical-path: ok');
