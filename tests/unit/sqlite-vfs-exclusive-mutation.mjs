#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { encodeWriteBatchStream } from '../../packages/worker/src/_shared/w7-frame.ts';
import { getSymlinkRegistry } from '../../packages/worker/src/vfs/symlink-registry.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const legacySymlinks = getSymlinkRegistry(rawVfs);
vfs.mkdir('workspace');
const leadingParentLease = rawVfs.acquireExclusiveMutation('/workspace/new/nested/repo', {
  includeMissingAncestors: true,
});
assert.equal(leadingParentLease.root, 'workspace/new');
rawVfs.releaseExclusiveMutation(leadingParentLease.owner);
assert.equal(legacySymlinks.hasAtOrBelow('preexisting'), false);
vfs.writeFile('.nimbus-symlinks.json', '{"preexisting/link":"target.txt"}');
const proofLease = rawVfs.acquireExclusiveMutation('/preexisting');
assert.equal(
  legacySymlinks.hasAtOrBelow('preexisting'),
  true,
  'clone destination proof used a stale legacy-registry cache',
);
rawVfs.releaseExclusiveMutation(proofLease.owner);
assert.equal(legacySymlinks.delete('preexisting/link'), true);
vfs.mkdir('repo');
legacySymlinks.set('repo/legacy-link', 'target.txt');
vfs.mkdir('repo');
const lease = rawVfs.acquireExclusiveMutation('/repo');

assert.throws(
  () => rawVfs.acquireExclusiveMutation('/repo/nested'),
  /EBUSY: repo\/nested overlaps exclusive mutation at repo/,
);
assert.throws(
  () => vfs.writeFile('repo/concurrent.txt', 'must-not-land'),
  /EBUSY: repo\/concurrent\.txt is locked by exclusive mutation at repo/,
);
assert.equal(vfs.exists('repo/concurrent.txt'), false);
vfs.mkdir('repo/injected/../../outside-dir', { recursive: true });
assert.equal(vfs.exists('repo/injected'), false);
assert.equal(vfs.isDirectory('outside-dir'), true);
assert.throws(
  () => legacySymlinks.set('repo/concurrent-link', 'target.txt'),
  /EBUSY: repo\/concurrent-link is locked by exclusive mutation at repo/,
);
assert.throws(
  () => legacySymlinks.delete('repo/legacy-link'),
  /EBUSY: repo\/legacy-link is locked by exclusive mutation at repo/,
);
assert.equal(legacySymlinks.readlink('repo/legacy-link'), 'target.txt');
assert.throws(
  () => vfs.writeFile('.nimbus-symlinks.json', '{"repo/injected":"target.txt"}'),
  /EBUSY: \.nimbus-symlinks\.json is locked while an exclusive mutation is active/,
);
assert.equal(legacySymlinks.readlink('repo/injected'), null);

vfs.writeFile('outside.txt', 'outside');
assert.equal(vfs.readFileString('outside.txt'), 'outside');
vfs.writeFile('outside-delete.txt', 'outside');
const bridge = new SqliteRuntimeFsBridge(rawVfs);
await bridge.unlink('/outside-delete.txt');
assert.equal(vfs.exists('outside-delete.txt'), false, 'outside unlink reported failure after commit');

const data = new TextEncoder().encode('owned');
const owned = await vfs.writeStream(encodeWriteBatchStream({
  inodes: [{
    path: 'repo/owned.txt',
    parentPath: 'repo',
    kind: 'file',
    isDir: false,
    size: data.byteLength,
    mtime: Date.now(),
    mode: 0o644,
    chunkCount: 1,
  }],
  chunks: [{ path: 'repo/owned.txt', chunkId: 0, data }],
}), { mutationOwner: lease.owner });
assert.equal(owned.ok, true);
assert.equal(vfs.readFileString('repo/owned.txt'), 'owned');

const escaped = await vfs.writeStream(encodeWriteBatchStream({
  inodes: [{
    path: 'escape.txt',
    parentPath: '',
    kind: 'file',
    isDir: false,
    size: 0,
    mtime: Date.now(),
    mode: 0o644,
    chunkCount: 0,
  }],
  chunks: [],
}), { mutationOwner: lease.owner });
assert.equal(escaped.ok, false);
assert.match(escaped.error.message, /EPERM: escape\.txt is outside exclusive mutation root repo/);
assert.equal(vfs.exists('escape.txt'), false);

rawVfs.releaseExclusiveMutation(lease.owner);
assert.equal(legacySymlinks.delete('repo/legacy-link'), true);
vfs.writeFile('repo/concurrent.txt', 'after-release');
assert.equal(vfs.readFileString('repo/concurrent.txt'), 'after-release');

vfs.mkdir('outside-dir');
vfs.symlink('../outside-dir', 'repo/out-link');
vfs.symlink('repo', 'outside-link');
const symlinkEscapeLease = rawVfs.acquireExclusiveMutation('/repo');
await assert.rejects(
  bridge.writeFile('/repo/out-link/injected.txt', 'blocked'),
  /EBUSY: repo\/out-link\/injected\.txt is locked by exclusive mutation at repo/,
);
assert.equal(vfs.exists('outside-dir/injected.txt'), false);
await assert.rejects(
  bridge.mkdir('/outside-link/new-dir'),
  /EBUSY: repo\/new-dir is locked by exclusive mutation at repo/,
);
assert.equal(vfs.exists('repo/new-dir'), false);
rawVfs.releaseExclusiveMutation(symlinkEscapeLease.owner);

const destroyLease = rawVfs.acquireGlobalExclusiveMutation();
assert.throws(
  () => rawVfs.acquireExclusiveMutation('/repo'),
  /EBUSY: repo overlaps exclusive mutation at /,
);
assert.throws(
  () => vfs.writeFile('anywhere.txt', 'blocked'),
  /EBUSY: anywhere\.txt is locked by exclusive mutation at /,
);
rawVfs.releaseExclusiveMutation(destroyLease.owner);

vfs.symlink('target', 'chunk-link');
assert.throws(
  () => vfs.writeBatch({
    inodes: [],
    chunks: [{ path: 'chunk-link', chunkId: 0, data: new TextEncoder().encode('mutate') }],
  }),
  /EINVAL: chunk has no regular file inode: chunk-link/,
);
assert.equal(vfs.readlink('chunk-link'), 'target');

vfs.mkdir('late');
const lateData = new TextEncoder().encode('late');
const lateEncoded = await collect(encodeWriteBatchStream({
  inodes: [{
    path: 'late/file.txt',
    parentPath: 'late',
    kind: 'file',
    isDir: false,
    size: lateData.byteLength,
    mtime: Date.now(),
    mode: 0o644,
    chunkCount: 1,
  }],
  chunks: [{ path: 'late/file.txt', chunkId: 0, data: lateData }],
}));
const frames = frameRecords(lateEncoded);
const fileEndOffset = frames.at(-2).offset;
let releaseSuffix;
let requestedSuffix;
const suffixRequested = new Promise((resolve) => { requestedSuffix = resolve; });
const suffixReleased = new Promise((resolve) => { releaseSuffix = resolve; });
let phase = 0;
const gatedStream = new ReadableStream({
  type: 'bytes',
  async pull(controller) {
    if (phase === 0) {
      phase = 1;
      controller.enqueue(lateEncoded.slice(0, fileEndOffset));
      return;
    }
    if (phase === 1) {
      phase = 2;
      requestedSuffix();
      await suffixReleased;
      controller.enqueue(lateEncoded.slice(fileEndOffset));
      controller.close();
    }
  },
}, { highWaterMark: 0 });
const lateWrite = vfs.writeStream(gatedStream);
await suffixRequested;
const lateLease = rawVfs.acquireExclusiveMutation('/late');
releaseSuffix();
const lateResult = await lateWrite;
assert.equal(lateResult.ok, false);
assert.match(lateResult.error.message, /EBUSY: late\/file\.txt is locked by exclusive mutation at late/);
assert.equal(vfs.exists('late/file.txt'), false);
rawVfs.releaseExclusiveMutation(lateLease.owner);

async function collect(stream) {
  const reader = stream.getReader();
  const parts = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    length += next.value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function frameRecords(value) {
  const records = [];
  let offset = 4;
  while (offset < value.byteLength) {
    const length = new DataView(value.buffer, value.byteOffset + offset + 1, 4).getUint32(0, true);
    records.push({ offset, length });
    offset += 5 + length;
  }
  assert.equal(offset, value.byteLength);
  return records;
}

console.log('sqlite VFS exclusive mutation: ok');
