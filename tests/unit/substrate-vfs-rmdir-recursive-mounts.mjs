#!/usr/bin/env bun
// The kernel VFS's recursive removal reaches directories that exist through a
// MountProvider.
//
// `rmdirRecursive` used to resolve its path in the in-memory tree only, while
// every sibling mutation (mkdir, rmdir, unlink, chmod) dispatched on the mount
// table first. A directory the user could `ls`, `stat` and `mkdir` under —
// because it lived on a mounted SqliteVFS — answered ENOENT to `rm -r`, and
// an embedder composing NimbusWorkspace over its own filesystem had to carry
// a depth-first removal of its own to get around it.
//
// Three shapes, on two providers — a minimal in-memory MountProvider fixture
// and the real SqliteVFSProvider the workspace mounts:
//   1. a tree created through the provider is removed recursively;
//   2. a mixed tree — an in-memory directory holding a mount — is cleared,
//      the mount's contents included, and the mount itself stays mounted;
//   3. ENOENT still fires for a genuinely missing path, in-memory and mounted.

import assert from 'node:assert/strict';

import { VFS } from '../../packages/core/src/substrate/lifo/kernel/vfs/VFS.ts';
import { VFSError } from '../../packages/core/src/substrate/lifo/kernel/vfs/types.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/**
 * The smallest MountProvider: a flat map of subpath → bytes | directory.
 * Every method a MountProvider must have, so `isMountProvider` admits it,
 * and every call is logged so a test can assert HOW the tree was removed —
 * through this provider, not around it.
 */
function createMemoryMountProvider() {
  const entries = new Map([['/', { type: 'directory' }]]);
  const calls = [];
  const norm = (sub) => (sub === '/' ? '/' : '/' + sub.replace(/^\/+/, '').replace(/\/+$/, ''));
  const missing = (sub) => new VFSError('ENOENT', `'${sub}': no such file or directory`);
  const childrenOf = (dir) => {
    const prefix = dir === '/' ? '/' : dir + '/';
    return [...entries.keys()].filter((k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
  };
  const provider = {
    readFile(sub) { const e = entries.get(norm(sub)); if (!e) throw missing(sub); return e.data; },
    readFileString(sub) { return new TextDecoder().decode(provider.readFile(sub)); },
    exists(sub) { return entries.has(norm(sub)); },
    stat(sub) {
      const e = entries.get(norm(sub));
      if (!e) throw missing(sub);
      return { type: e.type, size: e.data?.length ?? 0, ctime: 0, mtime: 0, mode: e.type === 'directory' ? 0o755 : 0o644 };
    },
    readdir(sub) {
      const dir = norm(sub);
      const e = entries.get(dir);
      if (!e) throw missing(sub);
      return childrenOf(dir).map((k) => ({ name: k.slice(k.lastIndexOf('/') + 1), type: entries.get(k).type }));
    },
    writeFile(sub, content) {
      const p = norm(sub);
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      entries.set(p, { type: 'file', data });
    },
    unlink(sub) {
      const p = norm(sub);
      calls.push(['unlink', p]);
      const e = entries.get(p);
      if (!e) throw missing(sub);
      if (e.type === 'directory') throw new VFSError('EISDIR', `'${sub}': is a directory`);
      entries.delete(p);
    },
    mkdir(sub, options) {
      const p = norm(sub);
      if (options?.recursive) {
        const parts = p.split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) { cur += '/' + part; if (!entries.has(cur)) entries.set(cur, { type: 'directory' }); }
        return;
      }
      if (entries.has(p)) throw new VFSError('EEXIST', `'${sub}': file exists`);
      entries.set(p, { type: 'directory' });
    },
    rmdir(sub) {
      const p = norm(sub);
      calls.push(['rmdir', p]);
      const e = entries.get(p);
      if (!e) throw missing(sub);
      if (e.type !== 'directory') throw new VFSError('ENOTDIR', `'${sub}': not a directory`);
      if (childrenOf(p).length > 0) throw new VFSError('ENOTEMPTY', `'${sub}': directory not empty`);
      entries.delete(p);
    },
    rename() { throw new Error('not exercised'); },
    copyFile() { throw new Error('not exercised'); },
  };
  return { provider, entries, calls };
}

const enoent = (fn, what) => {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, `${what}: expected a throw`);
  assert.equal(thrown.code, 'ENOENT', `${what}: expected ENOENT, got ${thrown.code ?? thrown.message}`);
};

// ── 1. a tree that exists only through the provider is removed through it ─
{
  const vfs = new VFS();
  const mount = createMemoryMountProvider();
  vfs.mount('/mnt', mount.provider);

  vfs.mkdir('/mnt/project/src/lib', { recursive: true });
  vfs.writeFile('/mnt/project/src/lib/a.js', 'a');
  vfs.writeFile('/mnt/project/src/b.js', 'b');
  vfs.writeFile('/mnt/project/README', 'r');
  assert.equal(vfs.stat('/mnt/project').type, 'directory', 'the directory is visible through the mount');

  vfs.rmdirRecursive('/mnt/project');

  assert.equal(vfs.exists('/mnt/project'), false, 'the tree is gone');
  assert.equal(mount.entries.has('/project'), false, 'gone from the provider, not merely from a cache');
  assert.deepEqual(
    mount.calls,
    [
      ['unlink', '/project/src/lib/a.js'], ['rmdir', '/project/src/lib'],
      ['unlink', '/project/src/b.js'], ['rmdir', '/project/src'],
      ['unlink', '/project/README'], ['rmdir', '/project'],
    ],
    'every entry was removed through the provider, children before their directory',
  );
  assert.equal(vfs.stat('/mnt').type, 'directory', 'the mount root is untouched');
}

// ── 2. a mixed tree: an in-memory directory holding a mount ────────────────
{
  const vfs = new VFS();
  vfs.mkdir('/data/plain/deep', { recursive: true });
  vfs.writeFile('/data/plain/deep/x.txt', 'x');
  vfs.writeFile('/data/top.txt', 't');
  const mount = createMemoryMountProvider();
  vfs.mount('/data/mnt', mount.provider);
  vfs.mkdir('/data/mnt/keep/inner', { recursive: true });
  vfs.writeFile('/data/mnt/keep/inner/y.txt', 'y');
  vfs.writeFile('/data/mnt/z.txt', 'z');
  assert.ok(vfs.readdir('/data').some((d) => d.name === 'mnt'), 'the mount point is listed under /data');

  vfs.rmdirRecursive('/data');

  assert.equal(vfs.exists('/data/plain'), false, 'the in-memory subtree is gone');
  assert.equal(vfs.exists('/data/top.txt'), false);
  assert.deepEqual(
    [...mount.entries.keys()], ['/'],
    "the mount's contents were cleared through its provider",
  );
  assert.ok(
    !mount.calls.some(([op, p]) => op === 'rmdir' && p === '/'),
    'the provider root — the mount itself — was never rmdir-ed',
  );
  assert.equal(vfs.stat('/data/mnt').type, 'directory', 'the mount is still mounted and answers');
  enoent(() => vfs.stat('/data/top.txt'), 'the removed in-memory file');
}

// ── 3. ENOENT still fires for a genuinely missing path ─────────────────────
{
  const vfs = new VFS();
  const mount = createMemoryMountProvider();
  vfs.mount('/mnt', mount.provider);
  vfs.mkdir('/real', { recursive: true });

  enoent(() => vfs.rmdirRecursive('/nowhere'), 'a missing in-memory path');
  enoent(() => vfs.rmdirRecursive('/mnt/nowhere'), 'a missing mounted path');
  assert.deepEqual(mount.calls, [], 'a missing mounted path removed nothing');
  assert.equal(vfs.exists('/real'), true, 'and nothing else was touched');

  // A file is not a directory, on either side.
  vfs.writeFile('/mnt/file', 'f');
  vfs.writeFile('/real/file', 'f');
  assert.throws(() => vfs.rmdirRecursive('/mnt/file'), { code: 'ENOTDIR' });
  assert.throws(() => vfs.rmdirRecursive('/real/file'), { code: 'ENOTDIR' });
}

// ── 4. the real provider: SqliteVFSProvider mounted the way the workspace does ─
{
  const harness = createSqliteVfsTestHarness();
  const sqlite = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = sqlite.as(CRED_KERNEL);
  kernel.mkdir('home', { recursive: true, mode: 0o755 });
  const vfs = new VFS();
  vfs.mount('/home', new SqliteVFSProvider(sqlite, 'home'));

  vfs.mkdir('/home/user/project/src', { recursive: true });
  vfs.writeFile('/home/user/project/src/index.js', 'export {}');
  vfs.writeFile('/home/user/project/package.json', '{}');
  assert.equal(kernel.exists('home/user/project/src/index.js'), true, 'the tree landed in SQLite');

  vfs.rmdirRecursive('/home/user/project');

  assert.equal(kernel.exists('home/user/project'), false, 'removed from the SQLite filesystem');
  assert.equal(vfs.exists('/home/user/project'), false);
  assert.equal(vfs.stat('/home/user').type, 'directory', 'the parent survives');
  enoent(() => vfs.rmdirRecursive('/home/user/project'), 'the removed directory, a second time');
}

console.log('PASS substrate-vfs-rmdir-recursive-mounts');
