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
import { loadWasiPreamble, makeGuest, makeSession } from './lib/wasi-authority.mjs';

const P = await loadWasiPreamble();
const sessions = [];

function layer({ abi }) {
  const session = makeSession({ dirs: ['a', 'b'], files: { 'a/one.txt': 'one', 'b/two.txt': 'two' } });
  sessions.push(session);
  // The empty preopen name is what a pre-cwd wasi-libc matches a relative
  // path against; naming it '/' serves absolute paths only.
  const guest = makeGuest(P, session, { preopens: [{ wasiPath: '', vfsPath: '' }] }, { abi });
  return {
    /** path_filestat_get, decoded the way a guest reads it. */
    stat(path) {
      const st = guest.stat(path);
      assert.equal(st.errno, 0, `path_filestat_get(${path}) => ${st.errno}`);
      return { dev: st.dev, ino: st.ino, filetype: st.filetype };
    },
    /** fd_filestat_get, for the fds that have no path at all. */
    fstat(fd) {
      const st = guest.fstat(fd);
      assert.equal(st.errno, 0, `fd_filestat_get(${fd}) => ${st.errno}`);
      return { dev: st.dev, ino: st.ino, filetype: st.filetype };
    },
  };
}

for (const abi of ['preview1', 'preview0']) {
  const fs = layer({ abi });

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
  // objects, not one, none of them is the preopen, and none of them is a
  // file: a pathless descriptor's (dev, ino) is on a device of its own, so
  // the small fd-derived inode it carries never names /home by accident.
  const fds = [0, 1, 2, 3].map((fd) => fs.fstat(fd));
  const identity = (s) => `${s.dev}:${s.ino}`;
  assert.equal(new Set(fds.map(identity)).size, 4, `${abi}: pathless fds need distinct identities`);
  for (const s of fds) assert.notEqual(s.ino, 0n, `${abi}: fd inode must never be 0`);
  for (const s of fds.slice(0, 3)) {
    assert.notEqual(s.dev, all[0].dev, `${abi}: stdio is not on the filesystem's device`);
    for (const file of all) assert.notEqual(identity(s), identity(file), `${abi}: a stdio fd must not alias a file`);
  }
}

for (const session of sessions) await session.dispose();
console.log('wasi-inode-identity: inodes are distinct, stable and non-zero in both ABIs');
