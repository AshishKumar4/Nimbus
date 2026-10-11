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

console.log('session-user-surfaces-namespace: ok');
