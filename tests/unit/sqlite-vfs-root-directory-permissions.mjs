#!/usr/bin/env bun
// SECURITY: the root directory is 0755 root:root, and adding, removing or
// renaming a name directly in `/` needs write and search on it, as on Linux.
// The engine skipped the parent check at `/` (the root has no row), so any
// principal (a confined agent uid included) could mkdir or write there,
// rename a kernel directory away, rmdir one, and unlink a kernel file.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

function setup() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('shared');
  kernel.chown('shared', 0, 1000);
  kernel.chmod('shared', 0o2775);
  kernel.mkdir('empty-root-dir');
  kernel.writeFile('root-file', 'kernel');
  kernel.mkdir('var/agents/a2000/tmp', { recursive: true });
  kernel.chown('var/agents/a2000/tmp', 2000, 2000);
  kernel.chmod('var/agents/a2000/tmp', 0o700);
  return { vfs, kernel };
}

const code = (run) => { try { run(); return 'ALLOWED'; } catch (error) { return error.code ?? error.message; } };
const names = (kernel) => kernel.readdir('').map((e) => e.name).sort();

for (const [label, cred, confine] of [
  ['a confined agent uid', { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 }, true],
  ['the session user', { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, false],
]) {
  const { vfs, kernel } = setup();
  if (confine) vfs.confinePrincipal(2000, 'var/agents/a2000/tmp');
  const before = names(kernel);
  const user = vfs.as(cred);
  assert.equal(code(() => user.mkdir('foo')), 'EACCES', `${label}: mkdir /foo`);
  assert.equal(code(() => user.writeFile('f', 'x')), 'EACCES', `${label}: writeFile /f`);
  assert.equal(code(() => user.rename('shared', 'moved')), 'EACCES', `${label}: rename /shared -> /moved`);
  assert.equal(code(() => user.rmdir('empty-root-dir')), 'EACCES', `${label}: rmdir /empty-root-dir`);
  assert.equal(code(() => user.unlink('root-file')), 'EACCES', `${label}: unlink /root-file`);
  assert.equal(code(() => user.symlink('/etc', 'ln')), 'EACCES', `${label}: symlink /ln`);
  assert.equal(code(() => user.writeBatch({ inodes: [{ path: 'batch', parentPath: '', kind: 'file', isDir: false, size: 0, mtime: 0, mode: 0o644, uid: cred.uid, gid: cred.gid, chunkCount: 0 }], chunks: [], deletedInodes: [] })), 'EACCES', `${label}: a batch row in /`);
  assert.deepEqual(names(kernel), before, `${label}: / is unchanged`);
  // Below the top level, a directory the user may write still works.
  assert.equal(code(() => user.writeFile('shared/mine', 'ok')), cred.uid === 1000 ? 'ALLOWED' : 'EACCES');
  // Reading and searching `/` is everyone's.
  assert.ok(user.readdir('').length > 0);
  assert.equal(user.readFileString('root-file'), 'kernel');
}

// The kernel keeps every right in `/`.
{
  const { kernel } = setup();
  kernel.mkdir('made-by-kernel');
  kernel.rename('shared', 'moved');
  kernel.rmdir('empty-root-dir');
  kernel.unlink('root-file');
  assert.deepEqual(names(kernel), ['made-by-kernel', 'moved', 'var']);
}

console.log('sqlite-vfs-root-directory-permissions: ok');
