// W7 functional/06-empty-batches
//
// Corner cases:
//   - Zero inodes, zero chunks (no-op).
//   - Inode-only batch (mkdir flush).
//   - Chunks-only batch (rare; tolerate it).
//   - deletePaths-only batch.

import { ok, eq, group, summary } from '../_tap.mjs';

let encodeWriteBatchStream, decodeWriteBatchStream;
try {
  ({ encodeWriteBatchStream, decodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/06-empty-batches');
}

async function roundTrip(payload, label) {
  const stream = encodeWriteBatchStream(payload);
  const decoded = await decodeWriteBatchStream(stream);
  const chunks = [];
  for await (const c of decoded.chunkIter) chunks.push(c);
  eq(`${label}: inode count`, decoded.inodes.length, payload.inodes.length);
  eq(`${label}: chunk count`, chunks.length, payload.chunks.length);
  eq(`${label}: deletePaths`, decoded.deletePaths || [], payload.deletePaths || []);
}

await group('empty batch round-trip', async () => {
  await roundTrip({ inodes: [], chunks: [] }, 'fully-empty');
});

await group('inode-only batch round-trip', async () => {
  await roundTrip({
    inodes: [
      { path: 'pkg/x', parentPath: 'pkg', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
    ],
    chunks: [],
  }, 'inode-only');
});

await group('chunks-only batch round-trip', async () => {
  await roundTrip({
    inodes: [],
    chunks: [
      { path: 'pkg/y', chunkId: 0, data: new TextEncoder().encode('chunky') },
    ],
  }, 'chunks-only');
});

await group('deletePaths-only batch round-trip', async () => {
  await roundTrip({
    inodes: [],
    chunks: [],
    deletePaths: ['pkg/old/a', 'pkg/old/b', 'pkg/old/c'],
  }, 'delete-only');
});

summary('w7/functional/06-empty-batches');
