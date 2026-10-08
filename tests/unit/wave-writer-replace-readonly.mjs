#!/usr/bin/env bun
// A removal and a create of one path in one buffered wave land as rm then
// create (WaveWriter.afterRemoval): over an existing read-only file, as a
// non-root user, the directory's write permission decides, and the create
// succeeds. Red before: buffering the create dropped the pending removal, so
// the wave carried only the create, which the store applied as an overwrite
// of the 0444 file: EACCES. (Found by ObnoxiousHookworm, scratch/wave-repro.)
import assert from 'node:assert/strict';
import { createWaveWriter } from '../../packages/platform/src/wave-writer.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const supervisor = { writeBatchStream: (stream) => user.writeStream(stream) };

const first = createWaveWriter({ supervisor, root: 'home/user', base: 'home/user' });
await first.file('lock', 0o444, new TextEncoder().encode('stale\n'));
await first.flush();
assert.equal(user.stat('home/user/lock').mode & 0o777, 0o444);

const second = createWaveWriter({ supervisor, root: 'home/user', base: 'home/user' });
await second.remove('lock');
await second.file('lock', 0o444, new TextEncoder().encode('fresh\n'));
await second.flush();
assert.equal(user.readFileString('home/user/lock'), 'fresh\n', 'remove then create replaces a read-only file, as rm and create do');
console.log('wave-writer-replace-readonly: ok');
