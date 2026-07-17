#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { bytesToB64, flushVfsDiff, snapshotVfs } from '../../packages/worker/src/runtime/vfs-snapshot.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

function makeVfs() {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  return { root: vfs.as(CRED_KERNEL), user: vfs.as(USER) };
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}

// Snapshot traversal records effective rights for every visible inode. Permission denials are not
// treated as corrupt snapshots, and denied file contents never cross the credential boundary.
{
  const { root, user } = makeVfs();
  root.mkdir('workspace', { mode: 0o755 });
  root.writeFile('workspace/readable.txt', 'public', { mode: 0o644 });
  root.writeFile('workspace/unreadable.txt', 'secret', { mode: 0o600 });
  root.writeFile('workspace/executable', 'run', { mode: 0o711 });
  root.mkdir('workspace/traverse-only', { mode: 0o711 });
  root.writeFile('workspace/traverse-only/hidden.txt', 'hidden', { mode: 0o600 });

  const result = snapshotVfs(user, 'workspace', { extraRoots: ['missing'] });
  assert.ok('snapshot' in result, 'permission denials should produce an honest snapshot, not an incomplete-snapshot error');
  assert.equal(result.snapshot.files['workspace/readable.txt'], bytesToB64(new TextEncoder().encode('public')));
  assert.equal(result.snapshot.files['workspace/unreadable.txt'], undefined, 'denied contents must not leak into the snapshot');
  assert.deepEqual(result.snapshot.modes, {
    workspace: 0o5,
    'workspace/executable': 0o1,
    'workspace/readable.txt': 0o4,
    'workspace/traverse-only': 0o1,
    'workspace/unreadable.txt': 0o0,
  });
  assert.ok(result.snapshot.dirs.includes('workspace/traverse-only'));
  assert.equal(result.snapshot.modes['workspace/traverse-only/hidden.txt'], undefined);
  assert.equal(result.snapshot.modes.missing, undefined, 'a nonexistent path must remain ENOENT, not become a denial cell');
}

// A requested root below an untraversable ancestor is still a present snapshot cell. The
// denial must cross the runtime boundary instead of aborting snapshot construction.
{
  const { root, user } = makeVfs();
  root.mkdir('private', { mode: 0o700 });
  root.mkdir('private/workspace', { mode: 0o755 });
  root.writeFile('private/workspace/secret.txt', 'secret', { mode: 0o644 });

  const result = snapshotVfs(user, 'private/workspace');
  assert.ok('snapshot' in result, 'an inaccessible requested root must be represented, not abort the snapshot');
  assert.equal(result.snapshot.modes['private/workspace'], 0o0);
  assert.ok(result.snapshot.dirs.includes('private/workspace'));
  assert.equal(result.snapshot.files['private/workspace/secret.txt'], undefined);
}

// Flushes execute through the same credentialed view used for the snapshot. Permission changes
// between snapshot and write-back are re-checked, while independent permitted writes still land.
{
  const { root, user } = makeVfs();
  root.mkdir('workspace', { mode: 0o777 });
  root.chmod('workspace', 0o777);
  user.writeFile('workspace/protected.txt', 'before');
  user.writeFile('workspace/allowed.txt', 'before');
  root.mkdir('workspace/locked', { mode: 0o555 });

  const snapshot = snapshotVfs(user, 'workspace');
  assert.ok('snapshot' in snapshot);

  root.chown('workspace/protected.txt', 0, 0);
  root.chmod('workspace/protected.txt', 0o400);
  const result = flushVfsDiff(user, {
    filesWritten: {
      'workspace/protected.txt': bytesToB64(new TextEncoder().encode('denied')),
      'workspace/allowed.txt': bytesToB64(new TextEncoder().encode('after')),
      'workspace/locked/new.txt': bytesToB64(new TextEncoder().encode('denied create')),
    },
    filesDeleted: [],
    dirsCreated: [],
    dirsDeleted: [],
  });

  assert.equal(result.written, 1);
  assert.equal(text(root.readFile('workspace/protected.txt')), 'before');
  assert.equal(text(user.readFile('workspace/allowed.txt')), 'after');
  assert.equal(root.exists('workspace/locked/new.txt'), false);
}

console.log('vfs-snapshot-permissions: all assertions passed');
