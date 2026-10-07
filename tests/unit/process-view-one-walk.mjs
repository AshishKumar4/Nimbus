#!/usr/bin/env bun
// A process's filesystem calls on SQLite resolve their path in one walk
// (SqliteVFS.resolveName), and the operation that follows reuses that walk
// instead of repeating it. What has to hold, through a process's own bridge:
//
//   (1) the answer is the one the component-by-component walk gave: links
//       followed (relative, absolute, chained, to a directory), `..` after a
//       link taken physically, the leaf of an lstat not followed, a missing
//       name, a name under a file, a mount reached through a link;
//   (2) nothing that changes where a path leads is missed between calls: a
//       directory losing search permission, a rename, a link retargeted, a
//       file removed, another principal's view of the same name;
//   (3) installing a mount over a previously resolved path changes routing
//       immediately; the engine's traversal proof cannot shadow a mount.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const OTHER = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };
const dec = new TextDecoder();
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', USER.uid, USER.gid);
const user = vfs.as(USER);
user.mkdir('home/user/a/b/c', { recursive: true });
user.writeFile('home/user/a/b/c/f.txt', 'deep');
user.writeFile('home/user/a/g.txt', 'shallow');
user.symlink('a/b', 'home/user/rel');
user.symlink('/home/user/a/b/c', 'home/user/abs');
user.symlink('rel', 'home/user/chain');
user.symlink('c/f.txt', 'home/user/a/b/leaf');
const files = new ProcessFiles(vfs);
const memory = new MemoryVFS({ uid: 1000, gid: 1000 });
memory.writeFile('/m.txt', new TextEncoder().encode('mounted'));
files.vfs.mount('/mnt', new Proxy(memory, { get: (t, k) => (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }));
user.symlink('/mnt', 'home/user/to-mount');
const proc = files.bind({ pid: 7, cred: USER });
const read = (path) => dec.decode(proc.readFile(path));

// ── (1) the same answers ─────────────────────────────────────────────────
assert.equal(read('/home/user/a/b/c/f.txt'), 'deep');
assert.equal(read('/home/user/rel/c/f.txt'), 'deep', 'a relative link in the middle');
assert.equal(read('/home/user/abs/f.txt'), 'deep', 'an absolute link');
assert.equal(read('/home/user/chain/c/f.txt'), 'deep', 'a link to a link');
assert.equal(read('/home/user/a/b/leaf'), 'deep', 'a link at the leaf, followed');
assert.equal(proc.stat('/home/user/a/b/leaf', { followSymlinks: false }).type, 'symlink', 'an lstat leaves the leaf');
assert.equal(read('/home/user/rel/../g.txt'), 'shallow', '`..` after a link climbs from where the link leads');
assert.equal(proc.stat('/home/user/a/nothing/here'), null, 'a missing name');
assert.throws(() => proc.stat('/home/user/a/g.txt/x'), (error) => error.code === 'ENOTDIR', 'a name under a file');
assert.equal(read('/home/user/to-mount/m.txt'), 'mounted', 'a link into a mount reaches the mount');
assert.equal(proc.stat('/home/user/a/b/c').type, 'directory');

// ── (2) no stale walk ────────────────────────────────────────────────────
{
  assert.equal(read('/home/user/a/b/c/f.txt'), 'deep');
  root.chmod('home/user/a/b', 0o700);
  root.chown('home/user/a/b', 0, 0);
  assert.throws(() => proc.stat('/home/user/a/b/c/f.txt'), (error) => error.code === 'EACCES', 'a directory that no longer grants search');
  root.chown('home/user/a/b', USER.uid, USER.gid);
  root.chmod('home/user/a/b', 0o755);
  assert.equal(read('/home/user/a/b/c/f.txt'), 'deep');

  user.rename('home/user/a/b/c', 'home/user/a/b/d');
  assert.equal(proc.stat('/home/user/a/b/c/f.txt'), null, 'a renamed directory');
  assert.equal(read('/home/user/a/b/d/f.txt'), 'deep');
  user.rename('home/user/a/b/d', 'home/user/a/b/c');

  assert.equal(read('/home/user/abs/f.txt'), 'deep');
  user.unlink('home/user/abs');
  user.symlink('/home/user/a', 'home/user/abs');
  assert.equal(proc.stat('/home/user/abs/f.txt'), null, 'a retargeted link');
  assert.equal(read('/home/user/abs/g.txt'), 'shallow');

  user.writeFile('home/user/a/gone.txt', 'x');
  assert.equal(read('/home/user/a/gone.txt'), 'x');
  user.unlink('home/user/a/gone.txt');
  assert.equal(proc.stat('/home/user/a/gone.txt'), null, 'a removed file');

  user.chmod('home/user/a', 0o700);
  const other = files.bind({ pid: 8, cred: OTHER });
  assert.equal(read('/home/user/a/g.txt'), 'shallow');
  assert.throws(() => other.stat('/home/user/a/g.txt'), (error) => error.code === 'EACCES', 'the same name, another principal');
  user.chmod('home/user/a', 0o755);
}

// ── (3) namespace changes still decide every call ───────────────────────
{
  assert.equal(read('/home/user/a/b/c/f.txt'), 'deep');
  const over = new MemoryVFS({ uid: 1000, gid: 1000 });
  over.writeFile('/f.txt', new TextEncoder().encode('overlay'));
  files.vfs.mount('/home/user/a/b/c', over);
  assert.equal(read('/home/user/a/b/c/f.txt'), 'overlay');
  proc.writeFile('/home/user/a/b/c/f.txt', 'changed overlay');
  assert.equal(dec.decode(over.readFile('/f.txt')), 'changed overlay');
  assert.equal(user.readFileString('home/user/a/b/c/f.txt'), 'deep', 'the covered SQLite file is untouched');
  files.vfs.unmount('/home/user/a/b/c');
  assert.equal(read('/home/user/a/b/c/f.txt'), 'deep');
}

console.log('ok - process-view-one-walk (same answers, no stale resolution, namespace changes respected)');
