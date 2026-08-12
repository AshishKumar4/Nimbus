#!/usr/bin/env bun
// wasi-inode-identity — (st_dev, st_ino) is an identity, and callers rely on it.
//
// The layer emitted a constant zero inode for every path. That is not a
// harmless placeholder: LLVM's FileManager keys its directory cache on the
// pair, so every include directory collapsed into one entry and clang searched
// only the first — every system header came back "file not found" while
// path_filestat_get had just reported the directory present. GNU make,
// find -samefile and rsync's hardlink detection read the same pair.
//
// The assertions below decode filestat exactly as a guest's wasi-libc would,
// and pin the three properties a caller actually depends on: distinct paths
// differ, the same path is stable across calls, and no inode is zero.

import assert from 'node:assert';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function layer({ abi }) {
  const P = await new AsyncFunction(`${WASI_INSTANCE_PREAMBLE_SRC}
return { __wasiInitFS, __wasiMakeImports };`)();
  const memory = new WebAssembly.Memory({ initial: 16 });
  P.__wasiInitFS({
    root: '',
    // The empty preopen name is what a pre-cwd wasi-libc matches a relative
    // path against; naming it '/' serves absolute paths only.
    preopens: [{ wasiPath: '', vfsPath: '' }],
    files: { 'a/one.txt': btoa('one'), 'b/two.txt': btoa('two') },
    dirs: ['a', 'b'],
    modes: { '': 7, a: 7, b: 7, 'a/one.txt': 6, 'b/two.txt': 6 },
  });
  const { wasiImport } = makeImportsWithoutJSPI(P, {
    argv: ['probe'], env: {}, abi, getMemory: () => memory,
  });
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);
  const PATH = 4096;
  const STAT = 8192;
  return {
    /** path_filestat_get, decoded the way a guest reads it. */
    stat(path) {
      const bytes = new TextEncoder().encode(path);
      u8.set(bytes, PATH);
      const rc = wasiImport.path_filestat_get(3, 1, PATH, bytes.length, STAT);
      assert.equal(rc, 0, `path_filestat_get(${path}) => ${rc}`);
      return {
        dev: dv.getBigUint64(STAT, true),
        ino: dv.getBigUint64(STAT + 8, true),
        filetype: dv.getUint8(STAT + 16),
      };
    },
    /** fd_filestat_get, for the fds that have no path at all. */
    fstat(fd) {
      const rc = wasiImport.fd_filestat_get(fd, STAT);
      assert.equal(rc, 0, `fd_filestat_get(${fd}) => ${rc}`);
      return { ino: dv.getBigUint64(STAT + 8, true), filetype: dv.getUint8(STAT + 16) };
    },
  };
}

for (const abi of ['preview1', 'preview0']) {
  const fs = await layer({ abi });

  const dirA = fs.stat('a');
  const dirB = fs.stat('b');
  const fileA = fs.stat('a/one.txt');
  const fileB = fs.stat('b/two.txt');
  const all = [dirA, dirB, fileA, fileB];

  // Distinct paths are distinct inodes. This is the property clang needed.
  const inodes = new Set(all.map((s) => s.ino));
  assert.equal(inodes.size, 4, `${abi}: four paths must have four inodes, got ${inodes.size}`);

  // No caller may be handed the "no inode" value.
  for (const s of all) assert.notEqual(s.ino, 0n, `${abi}: inode must never be 0`);

  // One device, and it is not the zero a caller may test against.
  for (const s of all) assert.equal(s.dev, all[0].dev, `${abi}: one filesystem, one dev`);
  assert.notEqual(all[0].dev, 0n, `${abi}: dev must never be 0`);

  // Stable across calls: a cache keyed on the pair must hit on re-stat.
  assert.equal(fs.stat('a').ino, dirA.ino, `${abi}: inode must be stable across calls`);
  assert.equal(fs.stat('a/one.txt').ino, fileA.ino, `${abi}: inode must be stable across calls`);

  // Filetype still decodes at the same offset in both ABIs.
  assert.equal(dirA.filetype, 3, `${abi}: 'a' is a directory`);
  assert.equal(fileA.filetype, 4, `${abi}: 'a/one.txt' is a regular file`);

  // A relative path resolves against the empty-named preopen — the other half
  // of what made a bare 'main.c' unopenable.
  assert.ok(fs.stat('a/one.txt').ino, `${abi}: relative path resolves`);

  // An fd with no path is still its own object. stdin/stdout/stderr are three
  // objects, not one, and none of them is the preopen.
  const fds = [0, 1, 2, 3].map((fd) => fs.fstat(fd).ino);
  assert.equal(new Set(fds).size, 4, `${abi}: pathless fds need distinct inodes`);
  for (const ino of fds) assert.notEqual(ino, 0n, `${abi}: fd inode must never be 0`);
}

console.log('wasi-inode-identity: inodes are distinct, stable and non-zero in both ABIs');
