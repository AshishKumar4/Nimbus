#!/usr/bin/env bun
// What a user reads and changes through the session's own surfaces — the
// editor pane, the SDK's files.delete — is the session's namespace, mounts
// included: the filesystem their programs see. Red before: each read and
// wrote the SQLite engine directly, so a file on a mount was invisible to the
// editor, an editor save to a mounted path landed in SQLite beneath the
// mount, and files.delete could not remove what files.write had written.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { getSymlinkRegistry } from '../../packages/core/src/vfs/symlink-registry.ts';
import { serveEditorFs } from '../../packages/worker/src/session/editor-fs.ts';
import { rpcDeleteFile } from '../../packages/worker/src/session/programmatic.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const dec = new TextDecoder();
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const data = new MemoryVFS();
data.writeFile('/stored.txt', new TextEncoder().encode('stored on the mount'));
const namespace = new ProcessFiles(engine);
namespace.vfs.mount('/mnt/data', data);
const editor = { files: namespace.namespaceFs(CRED_KERNEL), tree: namespace.namespaceFs(CRED_KERNEL, { landed: true }) };

// ── the editor pane reads, saves and lists on the mount ─────────────────────
assert.deepEqual(
  await serveEditorFs(editor, { type: 'fs-read', path: '/mnt/data/stored.txt' }),
  { type: 'fs-read-result', path: '/mnt/data/stored.txt', content: 'stored on the mount' },
);
assert.deepEqual(
  await serveEditorFs(editor, { type: 'fs-write', path: '/mnt/data/notes/a.txt', content: 'saved from the editor' }),
  { type: 'fs-write-result', path: '/mnt/data/notes/a.txt', ok: true },
);
assert.equal(dec.decode(data.readFile('/notes/a.txt')), 'saved from the editor', 'the save lands on the mount');
assert.equal(engine.as(CRED_KERNEL).exists('mnt/data/notes/a.txt'), false, 'and not in SQLite beneath it');
const listed = await serveEditorFs(editor, { type: 'fs-list', dir: '/mnt/data', recursive: true });
assert.deepEqual(
  listed.entries.map(({ path, type }) => `${type} ${path}`).sort(),
  ['directory /mnt/data/notes', 'file /mnt/data/notes/a.txt', 'file /mnt/data/stored.txt'],
);
console.log('  the editor reads, saves and lists a mounted path');

// ── files.delete removes what is on the mount ───────────────────────────────
const host = { getFilesystemAuthority: () => namespace, async ensureRuntimeReady() {} };
await rpcDeleteFile(host, '/mnt/data/stored.txt');
assert.equal(data.stat('/stored.txt'), null, 'a file on the mount is removed');
await rpcDeleteFile(host, '/mnt/data/notes', { recursive: true });
assert.equal(data.stat('/notes'), null, 'and a directory, recursively');
console.log('  files.delete removes a mounted path');

// ── A write beside a held subtree makes no change to its parents ───────────
// While another owner holds /home/user/repo exclusively (a clone), a file
// written beside it, whose parents are already there, goes ahead: making a
// directory that exists changes nothing, so it meets no lease. Red before:
// the surfaces' mkdir -p of /home/user took the mutation guard first, which
// refuses an ancestor of a held root, EBUSY.
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  engine.as(CRED_KERNEL).mkdir('home/user/repo', { recursive: true });
  const namespace = new ProcessFiles(engine);
  const lease = engine.acquireExclusiveMutation('home/user/repo');
  const editor = { files: namespace.namespaceFs(CRED_KERNEL), tree: namespace.namespaceFs(CRED_KERNEL, { landed: true }) };
  assert.deepEqual(
    await serveEditorFs(editor, { type: 'fs-write', path: '/home/user/notes.txt', content: 'beside the clone' }),
    { type: 'fs-write-result', path: '/home/user/notes.txt', ok: true },
  );
  namespace.namespaceFs(CRED_KERNEL).mkdir('/home/user', { recursive: true });
  assert.equal(dec.decode(engine.as(CRED_KERNEL).readFile('home/user/notes.txt')), 'beside the clone');
  assert.throws(() => namespace.namespaceFs(CRED_KERNEL).mkdir('/home/user/repo/sub', { recursive: true }), (error) => error.code === 'EBUSY', 'inside the held subtree is still refused');
  engine.releaseExclusiveMutation(lease.owner);
  console.log('  a write beside a held subtree goes ahead');
}

// ── mkdir keeps the namespace's answers: a registry link is there, and a
//    nonrecursive mkdir meets the lease before its lookup ──────────────────
// FilthySwordtail's review of 29f7ce62e. A compatibility link only the
// legacy registry holds (/home/user/link -> real-dir) is a name that is
// there: mkdir -p of it is the directory it leads to, and mkdir of it is
// EEXIST, never a native directory shadowing it. And a nonrecursive mkdir
// in a held subtree is refused by the lease before its lookup can answer
// for it (EACCES under a directory it may not search).
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/real-dir', { recursive: true });
  getSymlinkRegistry(engine).set('home/user/link', 'real-dir');
  const fs = new ProcessFiles(engine).namespaceFs(CRED_KERNEL);
  fs.mkdir('/home/user/link', { recursive: true });
  assert.equal(kernel.exists('home/user/link'), false, 'mkdir -p of a registry link makes nothing in its place');
  assert.equal(getSymlinkRegistry(engine).isSymlink('home/user/link'), true, 'and the link stands');
  assert.throws(() => fs.mkdir('/home/user/link'), (error) => error.code === 'EEXIST', 'mkdir of it is EEXIST');
  assert.equal(kernel.exists('home/user/link'), false);

  kernel.mkdir('home/user/held/private', { recursive: true });
  kernel.chmod('home/user/held/private', 0o700);
  kernel.chown('home/user/held/private', 0, 0);
  const lease = engine.acquireExclusiveMutation('home/user/held');
  const user = new ProcessFiles(engine).namespaceFs({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
  assert.throws(() => user.mkdir('/home/user/held/private/x'), (error) => error.code === 'EBUSY', 'the lease answers before the lookup');
  engine.releaseExclusiveMutation(lease.owner);
  assert.throws(() => user.mkdir('/home/user/held/private/x'), (error) => error.code === 'EACCES', 'and the lookup after it');
  console.log('  mkdir answers for registry links, and a nonrecursive one meets the lease first');
}

console.log('session-user-surfaces-namespace: ok');
