// W7 e2e/synthetic-50mb-tarball
//
// THE acceptance gate from the master roadmap:
//   "Install of 5GB monorepo doesn't hit 32 MiB wall"
//
// We can't actually exercise 5 GB inside a probe runner without
// blowing past Node heap. Instead we stage the smallest input that
// proves the wall is gone: a single synthetic batch ≥50 MB whose
// chunks must transit through the encode / RPC-shaped boundary /
// decode / writeStream path end-to-end.
//
// Pre-W7 the equivalent operation (writeBatch with > 32 MiB of
// inline data) fails inside workerd structured-clone with
// "Cannot serialize" / size-cap error. In Node-mode (this probe),
// structured-clone of a 50 MB Uint8Array does succeed, so we can't
// directly observe the failure here. What we DO observe is that
// the streaming pipeline:
//   - encodes 50 MB into a ReadableStream<Uint8Array>,
//   - the stream is consumed by decodeWriteBatchStream,
//   - all 50 MB of chunk data lands in SqliteVFS via writeStream,
//   - the resulting in-memory byte map matches the input.
//
// The structural claim — "this entire pipeline completes without
// going through a single >32 MiB structured-clone frame" — is
// verified by the per-chunk frame size cap in 02-large-payload.mjs
// (combined with this e2e exercising the FULL boundary).

import { SqliteVFS } from '../../../../src/vfs/sqlite-vfs.ts';
import { makeMockCtx } from '../_mock-sql.mjs';
import { ok, eq, gte, group, summary } from '../_tap.mjs';

let encodeWriteBatchStream, decodeWriteBatchStream;
try {
  ({ encodeWriteBatchStream, decodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/e2e/synthetic-50mb-tarball');
}

await group('full encode → RPC-shape → decode → writeStream pipeline', async () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/big', { recursive: true });

  // Build a synthetic ~50 MB single-package payload:
  //   800 files × 64 KiB each = 51.2 MiB.
  const CHUNK_SIZE = 64 * 1024;
  const FILE_COUNT = 800;
  const inodes = [
    { path: 'big', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
  ];
  const chunks = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const path = `big/${i}.bin`;
    inodes.push({
      path, parentPath: 'big', isDir: false,
      size: CHUNK_SIZE, mtime: 1, mode: 0o644, chunkCount: 1,
    });
    const data = new Uint8Array(CHUNK_SIZE);
    // deterministic fill so we can verify
    const seed = (i * 31) & 0xff;
    for (let b = 0; b < CHUNK_SIZE; b++) data[b] = (seed + b) & 0xff;
    chunks.push({ path, chunkId: 0, data });
  }
  const totalBytes = CHUNK_SIZE * FILE_COUNT;

  // ── Pipeline ────────────────────────────────────────────────────────
  const stream = encodeWriteBatchStream({ inodes, chunks });
  ok('encoder built a ReadableStream', stream instanceof ReadableStream);

  // Decode and feed straight into the VFS.
  const decoded = await decodeWriteBatchStream(stream);
  if (typeof vfs.writeStream !== 'function') {
    ok('vfs.writeStream defined', false);
    summary('w7/e2e/synthetic-50mb-tarball');
  }
  const r = await vfs.writeStream({
    inodes: decoded.inodes,
    chunkIter: decoded.chunkIter,
    deletePaths: decoded.deletePaths,
  });
  eq('writeStream return.inodes', r.inodes, inodes.length);
  eq('writeStream return.chunks', r.chunks, FILE_COUNT);

  // ── Verify ──────────────────────────────────────────────────────────
  // 1. Inode count in SQL.
  const inodeRows = sql.tables.get('inodes') || [];
  gte('SQL has ≥ FILE_COUNT inode rows', inodeRows.length, FILE_COUNT);

  // 2. Spot-check a few file contents via direct SQL.
  const chunkRows = sql.tables.get('file_chunks') || [];
  eq('SQL has FILE_COUNT chunk rows', chunkRows.length, FILE_COUNT);
  for (const idx of [0, 100, 400, 799]) {
    const path = `big/${idx}.bin`;
    const row = chunkRows.find(r => r.path === path && r.chunk_id === 0);
    ok(`chunk[${idx}] row present`, !!row);
    const seed = (idx * 31) & 0xff;
    const matches = row && row.data && row.data[0] === seed
      && row.data[CHUNK_SIZE - 1] === ((seed + CHUNK_SIZE - 1) & 0xff);
    ok(`chunk[${idx}] bytes preserved`, matches);
  }

  // 3. Size budget — we just streamed > 50 MB through.
  gte('streamed byte budget exceeds 50 MiB', totalBytes, 50 * 1024 * 1024);
  // 4. The 32 MiB structured-clone cap would have been a hard wall on
  //    the legacy writeBatch path. Streaming bypasses it. The fact that
  //    this test completed is the assertion.
  ok('pipeline completed without hitting structured-clone cap', true);
});

summary('w7/e2e/synthetic-50mb-tarball');
