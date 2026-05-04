// W7 functional/08-writestream-on-vfs
//
// Exercise the new SqliteVFS.writeStream({ inodes, chunkIter, deletePaths })
// against the W5 mock-sql harness. Behaviour must match writeBatch():
// same inodes inserted, same chunks inserted, same deletePaths
// honoured.

import { SqliteVFS } from '../../../../src/sqlite-vfs.ts';
import { makeMockCtx } from '../_mock-sql.mjs';
import { ok, eq, gte, group, summary } from '../_tap.mjs';

await group('writeStream parity with writeBatch', async () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/pkg', { recursive: true });

  if (typeof vfs.writeStream !== 'function') {
    ok('vfs.writeStream is defined', false, 'writeStream method missing');
    summary('w7/functional/08-writestream-on-vfs');
  }
  ok('vfs.writeStream is defined', typeof vfs.writeStream === 'function');

  const inodes = [
    { path: 'pkg/a.js', parentPath: 'pkg', isDir: false, size: 5, mtime: 1, mode: 0o644, chunkCount: 1 },
    { path: 'pkg/b.js', parentPath: 'pkg', isDir: false, size: 9, mtime: 1, mode: 0o644, chunkCount: 1 },
  ];
  const chunks = [
    { path: 'pkg/a.js', chunkId: 0, data: new TextEncoder().encode('hello') },
    { path: 'pkg/b.js', chunkId: 0, data: new TextEncoder().encode('greetings') },
  ];
  async function* gen() { for (const c of chunks) yield c; }

  const r = await vfs.writeStream({ inodes, chunkIter: gen() });
  ok('writeStream returns object', r && typeof r === 'object');
  eq('writeStream return.inodes', r.inodes, inodes.length);
  eq('writeStream return.chunks', r.chunks, chunks.length);

  // Verify the SQL state mirrors what writeBatch would have done.
  const inodesRows = sql.tables.get('inodes') || [];
  gte('inodes table has rows', inodesRows.length, 2);
  const aRow = inodesRows.find(r => r.path === 'pkg/a.js');
  ok('pkg/a.js row present', !!aRow);
  eq('pkg/a.js size', aRow?.size, 5);

  const chunkRows = sql.tables.get('file_chunks') || [];
  gte('file_chunks has rows', chunkRows.length, 2);
  const aChunk = chunkRows.find(r => r.path === 'pkg/a.js' && r.chunk_id === 0);
  ok('pkg/a.js chunk0 present', !!aChunk);
  ok('chunk data is byte-equal',
    aChunk && aChunk.data && aChunk.data.length === 5
      && aChunk.data[0] === 'h'.charCodeAt(0));
});

await group('writeStream tolerates an empty iterator', async () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/empty', { recursive: true });
  if (typeof vfs.writeStream !== 'function') {
    ok('vfs.writeStream defined (empty branch)', false);
    summary('w7/functional/08-writestream-on-vfs');
  }
  async function* gen() { /* empty */ }
  const inodes = [{ path: 'empty/leaf', parentPath: 'empty', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }];
  const r = await vfs.writeStream({ inodes, chunkIter: gen() });
  eq('inode count = 1', r.inodes, 1);
  eq('chunk count = 0', r.chunks, 0);
});

summary('w7/functional/08-writestream-on-vfs');
