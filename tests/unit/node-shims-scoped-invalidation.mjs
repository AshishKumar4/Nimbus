#!/usr/bin/env bun
// A Node process's heap cells follow the delta entries that cover a subtree.
//
// An ACQUIRE delta reports a directory that went, or whose mode, owner or
// group changed, as `structural`, and a change beneath a directory the
// process may not see as that directory, `subtree`-scoped. Neither names the
// cells under it, so a reader that evicted only named paths kept serving
// them: the files of a directory made private, and of one made private and
// then removed. The shims now evict every cell at or under such an entry, and
// a synchronous read there no longer returns the old bytes.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const READER = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const OWNER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
const owner = rawVfs.as(OWNER);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', OWNER.uid, OWNER.gid);
for (const dir of ['d', 'g', 'k']) {
  owner.mkdir(`/home/user/${dir}`);
  owner.writeFile(`/home/user/${dir}/f.txt`, `${dir} v1`);
}
// The process reads as READER, through its own view of the authority.
const bridge = new SqliteRuntimeFsBridge(rawVfs.as(READER), rawVfs);
const dec = new TextDecoder();
const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p), lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p), exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m), mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsAcquire: (epoch, cursor) => bridge.acquire(epoch, cursor),
};
const bundle = {};
const metadata = { 'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } };
const manifest = { 'home/user': ['d', 'g', 'k'] };
for (const dir of ['d', 'g', 'k']) {
  bundle[`home/user/${dir}/f.txt`] = `${dir} v1`;
  metadata[`home/user/${dir}`] = { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
  metadata[`home/user/${dir}/f.txt`] = { type: 'file', size: 4, mode: 0o644, uid: 1000, gid: 1000 };
  manifest[`home/user/${dir}`] = ['f.txt'];
}
const factory = new Function('__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };');
const out = factory(bundle, metadata, {}, manifest, supervisor, READER, '/home/user', [], {}, '/home/user/s.mjs', '/home/user');
const { fs } = out;

/** A synchronous read inside a timer callback, after the barrier it runs behind. */
const readInTimer = (path) => new Promise((resolve) => {
  out.setTimeout(() => {
    try {
      resolve(fs.readFileSync(path, 'utf8'));
    } catch (error) {
      resolve(error.code);
    }
  }, 1);
});

// The first barrier establishes the cursor, and each async read installs its
// cell at it, so a later synchronous read is served from the heap.
for (const dir of ['d', 'g', 'k']) {
  assert.equal(await fs.promises.readFile(`/home/user/${dir}/f.txt`, 'utf8'), `${dir} v1`);
}
for (const dir of ['d', 'g', 'k']) assert.equal(await readInTimer(`/home/user/${dir}/f.txt`), `${dir} v1`);

// ── A directory made private: its cells go ───────────────────────────────
owner.chmod('/home/user/d', 0o700);
assert.notEqual(await readInTimer('/home/user/d/f.txt'), 'd v1', 'a cell under a directory the process was locked out of was served');

// ── Made private, then removed ────────────────────────────────────────────
owner.chmod('/home/user/g', 0o700);
owner.removeRecursive('/home/user/g');
assert.notEqual(await readInTimer('/home/user/g/f.txt'), 'g v1', 'a cell for a removed file was served');

// ── An untouched directory keeps its cells ────────────────────────────────
assert.equal(await readInTimer('/home/user/k/f.txt'), 'k v1');

console.log('node-shims-scoped-invalidation: ok');
