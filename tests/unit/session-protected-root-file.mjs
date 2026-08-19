#!/usr/bin/env bun
// A host-governed file inside a session the guest otherwise owns.
//
// An embedder that wants to pin a policy, identity or manifest file into a
// sandbox has to survive the sandboxed program deleting it. Nothing special is
// added to the filesystem for this: the root becomes a sticky 1777 directory
// owned by the kernel and the file is kernel-owned 0444, which is exactly what
// POSIX already means. The guest keeps normal use of the root.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { _rpcWriteProtectedRootFile } from '../../packages/worker/src/session/rpc.ts';

const harness = createSqliteVfsTestHarness();
const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
const root = sqliteFs.as(CRED_KERNEL);
const user = sqliteFs.as(CRED_SESSION_USER);
const host = { sqliteFs, ensureSqliteFs() {} };

root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
user.writeFile('home/user/project.md', 'the guest owns this');

await _rpcWriteProtectedRootFile(host, '/home/user', '/home/user/SOUL.md', 'owner identity');

// ── The guest can read it, and cannot change or remove it ───────────────────
assert.equal(user.readFileString('home/user/SOUL.md'), 'owner identity');
assert.throws(() => user.writeFile('home/user/SOUL.md', 'forged'), /EACCES|EPERM/);
assert.throws(() => user.unlink('home/user/SOUL.md'), /EPERM/, 'sticky refuses the removal');
assert.throws(() => user.rename('home/user/SOUL.md', 'home/user/gone.md'), /EPERM/);
assert.throws(
  () => user.rename('home/user/project.md', 'home/user/SOUL.md'),
  /EPERM/,
  'and refuses being clobbered by a rename',
);
assert.equal(user.readFileString('home/user/SOUL.md'), 'owner identity', 'every refusal left it intact');

// ── The guest keeps ordinary use of its own root ────────────────────────────
user.writeFile('home/user/notes.md', 'mine');
user.unlink('home/user/notes.md');
user.mkdir('home/user/src', { recursive: true });
assert.equal(user.exists('home/user/src'), true, 'the root is still the guest\'s working directory');
assert.equal((root.stat('home/user').mode & 0o1000) !== 0, true, 'the root carries the sticky bit');

// ── The host can replace it; that is the point of the asymmetry ─────────────
await _rpcWriteProtectedRootFile(host, '/home/user', '/home/user/SOUL.md', 'owner update');
assert.equal(user.readFileString('home/user/SOUL.md'), 'owner update');

// ── It refuses anything that is not a direct child of the declared root ─────
await assert.rejects(
  () => _rpcWriteProtectedRootFile(host, '/home/user', '/home/user/src/nested.md', 'x'),
  /direct child/,
);
await assert.rejects(
  () => _rpcWriteProtectedRootFile(host, '/home/user', '/etc/passwd', 'x'),
  /direct child/,
);
await assert.rejects(
  () => _rpcWriteProtectedRootFile(host, '/home/absent', '/home/absent/SOUL.md', 'x'),
  /does not exist/,
);

console.log('session protected root file: ok');
