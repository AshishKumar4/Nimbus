#!/usr/bin/env bun
// Root's access is Linux's capabilities (CAP_DAC_OVERRIDE, CAP_DAC_READ_SEARCH):
// it reads and writes anything and searches every directory, whatever its
// mode; it executes a regular file only when some execute bit is set.
//   1. the one calculation (posixAccess), on directories and files;
//   2. the session's store: root stats, lists and writes under a mode-000
//      directory, and rm -r of a tree holding one removes it whole;
//   3. a mounted backend that keeps modes without file-type bits;
//   4. the namespace's check.
// Red before: root was denied search on a directory with no execute bits, so
// root's rm -r of a tree holding a non-empty chmod 000 directory threw from
// the middle of its groups.
import assert from 'node:assert/strict';
import { posixAccess } from '../../packages/core/src/vfs/posix-access.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { namespaceAllows } from '../../packages/worker/src/vfs/resident/permissions.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const ROOT = { uid: 0, gid: 0, groups: [0] };
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

// ── 1. the one calculation ───────────────────────────────────────────────
const closedDir = { mode: 0o040000, uid: 1000, gid: 1000 };
const closedFile = { mode: 0o100000, uid: 1000, gid: 1000 };
const ownerExec = { mode: 0o100100, uid: 1000, gid: 1000 };
assert.deepEqual([1, 2, 4, 7].map((want) => posixAccess(closedDir, want, ROOT)), [true, true, true, true], 'root searches, writes and reads a mode-000 directory');
assert.deepEqual([2, 4, 6].map((want) => posixAccess(closedFile, want, ROOT)), [true, true, true], 'root reads and writes a mode-000 file');
assert.equal(posixAccess(closedFile, 1, ROOT), false, 'root does not execute a file with no execute bit');
assert.equal(posixAccess(ownerExec, 1, ROOT), true, 'root executes a file any execute bit is set on');
assert.equal(posixAccess({ mode: 0, uid: 1000, gid: 1000, directory: true }, 1, ROOT), true, 'a directory named as one, its mode without type bits');
assert.equal(posixAccess(closedDir, 1, USER), false, 'others are still judged by the mode');

// ── 2. the session's store ───────────────────────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  const user = engine.as(USER);
  root.mkdir('home', { mode: 0o755 });
  root.chown('home', USER.uid, USER.gid);
  user.mkdir('home/tree/closed/deep', { recursive: true });
  user.writeFile('home/tree/closed/deep/f', 'f');
  user.writeFile('home/tree/free', 'free');
  user.chmod('home/tree/closed', 0o000);
  assert.equal(root.stat('home/tree/closed/deep/f').size, 1, 'root stats under a mode-000 directory');
  assert.deepEqual(root.readdir('home/tree/closed').map((entry) => entry.name), ['deep'], 'and lists it');
  root.writeFile('home/tree/closed/deep/g', 'g');
  assert.deepEqual(root.removeRecursive('home/tree'), { removed: ['home/tree'], kept: [], failures: [] }, "root's rm -r removes it whole");
  assert.equal(root.exists('home/tree'), false);
  harness.db.close();
}

// ── 3. a mounted backend whose modes carry no file-type bits ─────────────
{
  const memory = new MemoryVFS({ uid: 1000, gid: 1000 });
  memory.mkdir('/closed');
  memory.writeFile('/closed/f', new TextEncoder().encode('f'));
  memory.chmod('/closed', 0o000);
  const composite = new CompositeVFS(new MemoryVFS({ uid: 0, gid: 0 }));
  composite.mount('/m', memory);
  assert.equal(composite.as(ROOT).sync.stat('/m/closed/f')?.size, 1, 'root searches a mounted mode-000 directory');
}

// ── 4. the namespace's check ─────────────────────────────────────────────
assert.equal(namespaceAllows(ROOT, { mode: 0o040000, uid: 1000, gid: 1000 }, 1), true, 'the namespace lets root search a mode-000 directory');
assert.equal(namespaceAllows(ROOT, { mode: 0o100000, uid: 1000, gid: 1000 }, 1), false, 'and not execute a file with no execute bit');

console.log('root-dac-override: ok');
