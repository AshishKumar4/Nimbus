#!/usr/bin/env bun
// A session-wide exclusive mutation that says why (SqliteVFS
// acquireGlobalExclusiveMutation(reason)): a write it refuses is EBUSY with
// that reason, the legacy symlink registry's too; the reason follows the
// lease through a rotation and goes with its release. One that says
// nothing refuses as before, naming its root.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { LEGACY_SYMLINK_REGISTRY_PATH } from '../../packages/core/src/vfs/symlink-registry.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const refused = (fn, detail) => assert.throws(fn, (error) => error?.code === 'EBUSY' && error.message.endsWith(detail), detail);

const why = 'held while the session recovers';
const lease = vfs.acquireGlobalExclusiveMutation(why);
refused(() => user.writeFile('home/user/a.txt', 'a'), why);
refused(() => kernel.writeFile(LEGACY_SYMLINK_REGISTRY_PATH, '{}'), why);
const rotated = vfs.rotateExclusiveMutation(lease.owner);
refused(() => user.writeFile('home/user/a.txt', 'a'), why);
vfs.releaseExclusiveMutation(rotated);
user.writeFile('home/user/a.txt', 'a');
console.log('  ok  a session-wide hold with a reason: refused writes say it, through a rotation; released, writes go');

const plain = vfs.acquireGlobalExclusiveMutation();
refused(() => user.writeFile('home/user/b.txt', 'b'), 'locked by an exclusive mutation at /');
refused(() => kernel.writeFile(LEGACY_SYMLINK_REGISTRY_PATH, '{}'), 'locked while an exclusive mutation is active');
vfs.releaseExclusiveMutation(plain);
console.log('  ok  a hold without a reason: refusals as before');
console.log('vfs-exclusive-mutation-reason: ok');
