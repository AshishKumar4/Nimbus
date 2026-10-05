#!/usr/bin/env bun
// clone-finish removes a full clone's staged files (lists, batches,
// checkpoints, index shares: vscode ~200) one record each. As one recursive
// delete they passed a write group's row limit live ("transaction exceeds
// logicalRows limit: 326 > 256") and the clone failed after its history had
// landed. Red before: the same error here. And it writes the index in a
// later second than the newest file, or git would re-read those files.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { cloneFinish } from '../../packages/worker/src/git/pack/clone.ts';
import { encodeIndexEntry } from '../../packages/worker/src/git/worktree/dircache.ts';
import { createWaveWriter } from '../../packages/worker/src/git/wave-writer.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const files = vfs.as(CRED_KERNEL);
const dir = 'home/user/repo';
files.mkdir(dir + '/.git/nimbus-clone', { recursive: true });
for (let i = 0; i < 200; i++) files.writeFile(`${dir}/.git/nimbus-clone/list-trees-${i}-0`, new Uint8Array(64));
files.writeFile(dir + '/.git/shallow', '1'.repeat(40) + '\n');
// A file written this very second: the index must land in a later one (git's racy rule).
const writtenAt = Date.now();
const share = encodeIndexEntry('a.txt', 0o100644, new Uint8Array(20).fill(7), { ctimeMs: writtenAt, mtimeMs: writtenAt, dev: 1, ino: 1, uid: 1, gid: 1, size: 1 });
files.writeFile(dir + '/.git/nimbus-clone/index-0', share);

const context = {
  supervisor: {
    async fsReadRange(path, offset, length) { return files.readRange(path.replace(/^\/+/, ''), offset, length); },
    async readdir(path) { return files.readdir(path.replace(/^\/+/, '')).map((entry) => (typeof entry === 'string' ? entry : entry.name)); },
    async fsWriteRange() { throw new Error('unused'); },
    async fsTruncate() { throw new Error('unused'); },
    async rename() { throw new Error('unused'); },
  },
  writer: () => createWaveWriter({ supervisor: { writeBatchStream: (stream) => files.writeStream(stream) }, root: null, base: dir }),
  dir,
  url: 'https://example.invalid/repo.git',
  marker: { path: '.git/nimbus-clone-job', text: '{}' },
};
const finished = await cloneFinish(context, { shares: [{ name: 'index-0', bytes: share.byteLength }], full: true });
assert.equal(finished.indexEntries, 1);
assert.equal(files.exists(dir + '/.git/nimbus-clone'), false, 'staging removed');
assert.equal(files.exists(dir + '/.git/shallow'), false, 'no longer shallow');
assert.ok(files.exists(dir + '/.git/index'));
assert.ok(Date.now() >= (Math.floor(writtenAt / 1000) + 1) * 1000, 'the index was written after the newest file\'s second');
console.log('git-clone-finish-staging: ok');
