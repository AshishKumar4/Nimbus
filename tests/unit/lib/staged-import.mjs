// The staged-import side of the SQLite VFS: a store opened as the kernel,
// and the writeBatch payloads (inodes and their CHUNK_SIZE chunks) an
// import stages into it.

import { CHUNK_SIZE } from '../../../packages/platform/src/limits.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/**
 * A store over `harness`, its running counters loaded now: a later probe
 * reading stats from inside a statement must not re-enter the first
 * aggregate, and _verifyCounters judges how every later mutation kept them.
 */
export function openVfs(harness = createSqliteVfsTestHarness()) {
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  rawVfs.getStats();
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL), baselineTransactions: harness.transactionCount };
}

/** The same database reopened, as a fresh isolate would find it. */
export function reopenVfs(harness) {
  return openVfs(createSqliteVfsTestHarness(harness.db)).vfs;
}

/** `length` deterministic bytes, varied by `seed`. */
export function bytes(length, seed = 0) {
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index++) data[index] = (index + seed) % 251;
  return data;
}

const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A file inode of `size` bytes. */
export function fileInode(path, size, mtime = 1) {
  return {
    path,
    parentPath: parentOf(path),
    isDir: false,
    size,
    mtime,
    mode: 0o644,
    chunkCount: size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE),
  };
}

/** A directory inode. */
export function dirInode(path) {
  return { path, parentPath: parentOf(path), isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 };
}

/** `data` cut into its CHUNK_SIZE chunks. */
export function fileChunks(path, data) {
  return Array.from(
    { length: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE) },
    (_, chunkId) => ({ path, chunkId, data: data.slice(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE) }),
  );
}

/** A one-file writeBatch payload. */
export function filePayload(path, data) {
  return { inodes: [fileInode(path, data.length)], chunks: fileChunks(path, data) };
}
