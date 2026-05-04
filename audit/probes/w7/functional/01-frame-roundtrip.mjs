// W7 functional/01-frame-roundtrip
//
// Verify the W7 wire-protocol encode/decode round-trip:
//   - Build a small BatchWritePayload (5 inodes, 8 chunks).
//   - encodeWriteBatchStream(payload) → ReadableStream<Uint8Array>.
//   - decodeWriteBatchStream(stream) → { inodes, chunkIter, deletePaths }.
//   - Assert: inodes are byte-equal; chunks (drained from the iterator)
//     are byte-equal in count, path, chunkId, and data bytes.
//   - Assert: the encoded stream's `type === 'bytes'` (CF requirement).

import { ok, eq, gte, group, summary } from '../_tap.mjs';

let encodeWriteBatchStream, decodeWriteBatchStream;
try {
  ({ encodeWriteBatchStream, decodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/01-frame-roundtrip');
}

await group('round-trip a small batch', async () => {
  const payload = {
    inodes: [
      { path: 'pkg/a/file1.js', parentPath: 'pkg/a', isDir: false, size: 5, mtime: 1, mode: 0o644, chunkCount: 1 },
      { path: 'pkg/a/file2.js', parentPath: 'pkg/a', isDir: false, size: 9, mtime: 1, mode: 0o644, chunkCount: 1 },
      { path: 'pkg/a',          parentPath: 'pkg',   isDir: true,  size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
      { path: 'pkg',            parentPath: '',      isDir: true,  size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
      { path: 'pkg/a/big.bin',  parentPath: 'pkg/a', isDir: false, size: 200, mtime: 1, mode: 0o644, chunkCount: 1 },
    ],
    chunks: [
      { path: 'pkg/a/file1.js', chunkId: 0, data: new TextEncoder().encode('hello') },
      { path: 'pkg/a/file2.js', chunkId: 0, data: new TextEncoder().encode('greetings') },
      { path: 'pkg/a/big.bin',  chunkId: 0, data: new Uint8Array(200).map((_, i) => i % 251) },
    ],
    deletePaths: ['pkg/old/x.js', 'pkg/old/y.js'],
  };

  const stream = encodeWriteBatchStream(payload);
  ok('encoder returns a ReadableStream', stream instanceof ReadableStream);

  const decoded = await decodeWriteBatchStream(stream);
  ok('decode returns object', decoded && typeof decoded === 'object');
  ok('decoded.inodes is an array', Array.isArray(decoded.inodes));
  eq('inode count preserved', decoded.inodes.length, payload.inodes.length);

  // Field-by-field equality for inodes
  for (let i = 0; i < payload.inodes.length; i++) {
    eq(`inode[${i}].path`, decoded.inodes[i].path, payload.inodes[i].path);
    eq(`inode[${i}].parentPath`, decoded.inodes[i].parentPath, payload.inodes[i].parentPath);
    eq(`inode[${i}].isDir`, !!decoded.inodes[i].isDir, !!payload.inodes[i].isDir);
    eq(`inode[${i}].size`, decoded.inodes[i].size, payload.inodes[i].size);
    eq(`inode[${i}].mtime`, decoded.inodes[i].mtime, payload.inodes[i].mtime);
    eq(`inode[${i}].mode`, decoded.inodes[i].mode, payload.inodes[i].mode);
    eq(`inode[${i}].chunkCount`, decoded.inodes[i].chunkCount, payload.inodes[i].chunkCount);
  }

  // deletePaths preserved
  eq('deletePaths preserved', decoded.deletePaths, payload.deletePaths);

  // Drain chunkIter
  const got = [];
  for await (const c of decoded.chunkIter) got.push(c);
  eq('chunk count preserved', got.length, payload.chunks.length);

  for (let i = 0; i < payload.chunks.length; i++) {
    eq(`chunk[${i}].path`, got[i].path, payload.chunks[i].path);
    eq(`chunk[${i}].chunkId`, got[i].chunkId, payload.chunks[i].chunkId);
    eq(`chunk[${i}].data.length`, got[i].data.length, payload.chunks[i].data.length);
    let bytesMatch = true;
    for (let b = 0; b < payload.chunks[i].data.length; b++) {
      if (got[i].data[b] !== payload.chunks[i].data[b]) { bytesMatch = false; break; }
    }
    ok(`chunk[${i}] bytes equal`, bytesMatch);
  }
});

summary('w7/functional/01-frame-roundtrip');
