// W7 regression/legacy-writeBatch-still-works
//
// Backwards-compat: the legacy writeBatch path on SqliteVFS must
// remain functional even after writeStream is added. Many callers
// (git-network-facet, seed-project, npm-installer's bin entries,
// npm-install-facet's legacy path) still call writeBatch directly.
// Removing or breaking it would silently break all of them.

import { SqliteVFS } from '../../../../src/sqlite-vfs.ts';
import { makeMockCtx } from '../../w5/_mock-sql.mjs';
import { ok, eq, gte, group, summary } from '../_tap.mjs';

await group('legacy writeBatch is still callable and returns counts', () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/legacy', { recursive: true });

  const inodes = [
    { path: 'legacy/x.js', parentPath: 'legacy', isDir: false, size: 5, mtime: 1, mode: 0o644, chunkCount: 1 },
    { path: 'legacy/y.js', parentPath: 'legacy', isDir: false, size: 7, mtime: 1, mode: 0o644, chunkCount: 1 },
  ];
  const chunks = [
    { path: 'legacy/x.js', chunkId: 0, data: new TextEncoder().encode('hello') },
    { path: 'legacy/y.js', chunkId: 0, data: new TextEncoder().encode('goodbye') },
  ];
  const r = vfs.writeBatch({ inodes, chunks });
  ok('writeBatch returns object', r && typeof r === 'object');
  eq('writeBatch.inodes', r.inodes, inodes.length);
  eq('writeBatch.chunks', r.chunks, chunks.length);

  // Verify mutation semantics: inodes are now in this.inodes (in-memory tree)
  ok('legacy/x.js exists in inode tree', vfs.exists('legacy/x.js'));
  ok('legacy/y.js exists in inode tree', vfs.exists('legacy/y.js'));
});

await group('writeBatch still works after writeStream coexists', async () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/coexist', { recursive: true });

  // First run a writeStream batch (W7 method)
  if (typeof vfs.writeStream === 'function') {
    async function* g1() {
      yield { path: 'coexist/a', chunkId: 0, data: new Uint8Array([1, 2, 3]) };
    }
    await vfs.writeStream({
      inodes: [{ path: 'coexist/a', parentPath: 'coexist', isDir: false, size: 3, mtime: 1, mode: 0o644, chunkCount: 1 }],
      chunkIter: g1(),
    });
  }

  // Then a legacy writeBatch
  const r2 = vfs.writeBatch({
    inodes: [{ path: 'coexist/b', parentPath: 'coexist', isDir: false, size: 3, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'coexist/b', chunkId: 0, data: new Uint8Array([4, 5, 6]) }],
  });
  eq('legacy writeBatch returns inode count after coexist', r2.inodes, 1);
  eq('legacy writeBatch returns chunk count after coexist', r2.chunks, 1);
});

summary('legacy-writeBatch-still-works [W7 regression]');
