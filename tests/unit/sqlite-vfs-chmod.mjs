#!/usr/bin/env bun
// WASI Stage 1: SqliteVFS.chmod — durable permission bits.
//
//   - chmod stores full POSIX st_mode (S_IF* filetype bits | perms) in the
//     inode row AND the in-memory index; stat reflects it immediately and
//     after a rehydrate (fresh SqliteVFS over the same DB).
//   - chmod follows symlinks (POSIX), ENOENT on missing paths, ELOOP on
//     symlink cycles.
//   - writeFile: rewriting an existing file preserves its mode (POSIX —
//     mode is chosen only at creation); creation defaults to 0o644.
//   - writeRange/truncate/rename carry the mode through.
//   - chmod bumps the per-path revision and emits an fs change event.

import assert from 'node:assert/strict';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { Database } from 'bun:sqlite';

function makeVfs(db = new Database(':memory:')) {
  const harness = createSqliteVfsTestHarness(db);
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  vfs.mkdir('home/user', { recursive: true });
  return { harness, db, rawVfs, vfs };
}

// ── set + reflect (exec bits) ────────────────────────────────────────────
{
  const { vfs } = makeVfs();
  vfs.writeFile('home/user/hello', 'x');
  assert.equal(vfs.stat('home/user/hello').mode, 0o644, 'creation default 0o644');

  vfs.chmod('home/user/hello', 0o755);
  assert.equal(vfs.stat('home/user/hello').mode, 0o100755, 'chmod stamps S_IFREG | perms');
  assert.ok(vfs.stat('home/user/hello').mode & 0o111, 'exec bits set');

  vfs.chmod('home/user/hello', 0o644);
  assert.equal(vfs.stat('home/user/hello').mode, 0o100644, 'chmod -x clears exec bits');
  assert.equal(vfs.stat('home/user/hello').mode & 0o111, 0, 'no exec bits');

  // Full st_mode input is masked to perms; filetype comes from the inode.
  vfs.chmod('home/user/hello', 0o100755);
  assert.equal(vfs.stat('home/user/hello').mode, 0o100755);

  // Directory chmod stamps S_IFDIR.
  vfs.mkdir('home/user/dir');
  vfs.chmod('home/user/dir', 0o700);
  assert.equal(vfs.stat('home/user/dir').mode, 0o040700);
}

// ── durability: mode survives a rehydrate over the same DB ─────────────
{
  const db = new Database(':memory:');
  {
    const harness = createSqliteVfsTestHarness(db);
    const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
    vfs.mkdir('home/user', { recursive: true });
    vfs.writeFile('home/user/bin', 'x');
    vfs.chmod('home/user/bin', 0o755);
  }
  const harness2 = createSqliteVfsTestHarness(db);
  const vfs2 = new SqliteVFS(harness2.sql, harness2.ctx).as(CRED_KERNEL);
  assert.equal(vfs2.stat('home/user/bin').mode, 0o100755, 'mode rehydrates from the inode row');
}

// ── errors: ENOENT, symlink follow, ELOOP ───────────────────────────────
{
  const { vfs } = makeVfs();
  assert.throws(() => vfs.chmod('home/user/nope', 0o755), /ENOENT/);

  vfs.writeFile('home/user/real', 'x');
  vfs.symlink('/home/user/real', 'home/user/link');
  vfs.chmod('home/user/link', 0o755);
  assert.equal(vfs.stat('home/user/real').mode, 0o100755, 'chmod follows symlinks');
  assert.equal(vfs.lstat('home/user/link').mode, 0o120777, 'link inode untouched');

  vfs.symlink('/home/user/loop-b', 'home/user/loop-a');
  vfs.symlink('/home/user/loop-a', 'home/user/loop-b');
  assert.throws(() => vfs.chmod('home/user/loop-a', 0o755), /ELOOP/);
}

// ── writeFile preserves mode on overwrite; writeRange/truncate carry it ──
{
  const { vfs } = makeVfs();
  vfs.writeFile('home/user/tool', 'v1');
  vfs.chmod('home/user/tool', 0o755);
  vfs.writeFile('home/user/tool', 'v2 rewritten');
  assert.equal(vfs.stat('home/user/tool').mode, 0o100755, 'rewrite preserves mode');

  vfs.writeRange('home/user/tool', 3, new Uint8Array([65, 66]));
  assert.equal(vfs.stat('home/user/tool').mode, 0o100755, 'writeRange preserves mode');

  vfs.truncate('home/user/tool', 2);
  assert.equal(vfs.stat('home/user/tool').mode, 0o100755, 'truncate preserves mode');

  vfs.rename('home/user/tool', 'home/user/tool2');
  assert.equal(vfs.stat('home/user/tool2').mode, 0o100755, 'rename preserves mode');
}

// ── revision bump + fs event ─────────────────────────────────────────────
{
  const { rawVfs, vfs } = makeVfs();
  vfs.writeFile('home/user/x', 'x');
  const before = rawVfs.revision('home/user/x');
  const events = [];
  rawVfs.events.onPath('home/user/x', (event) => events.push(event.type));
  vfs.chmod('home/user/x', 0o711);
  assert.ok(rawVfs.revision('home/user/x') > before, 'revision bumped');
  assert.deepEqual(events, ['change'], 'change event emitted');
}

// ── provider delegation (kernel VFS mount surface) ───────────────────────
{
  const { rawVfs, vfs } = makeVfs();
  vfs.mkdir('home/user', { recursive: true });
  vfs.writeFile('home/user/p', 'x');
  const provider = new SqliteVFSProvider(rawVfs, 'home');
  provider.chmod('/user/p', 0o755);
  assert.equal(vfs.stat('home/user/p').mode, 0o100755);
}

console.log('sqlite-vfs-chmod: all assertions passed');
