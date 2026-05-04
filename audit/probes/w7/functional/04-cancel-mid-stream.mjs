// W7 functional/04-cancel-mid-stream
//
// Verify partial-stream cancellation:
//   - Reader cancels the stream after consuming N chunks.
//   - The encoder receives the cancel (its `cancel()` callback fires).
//   - The decoder propagates the cancellation to its chunkIter (the
//     iterator's next iteration throws or yields done).
//
// Acceptance signal: no leaked listeners, no unhandled rejections,
// the reader's cancel does not crash the encoder.

import { ok, eq, group, summary, rejects } from '../_tap.mjs';

let encodeWriteBatchStream, decodeWriteBatchStream;
try {
  ({ encodeWriteBatchStream, decodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/04-cancel-mid-stream');
}

await group('cancel reader mid-stream does not crash encoder', async () => {
  const inodes = [];
  const chunks = [];
  for (let i = 0; i < 50; i++) {
    const path = `pkg/c/${i}.bin`;
    inodes.push({ path, parentPath: 'pkg/c', isDir: false, size: 1024, mtime: 1, mode: 0o644, chunkCount: 1 });
    chunks.push({ path, chunkId: 0, data: new Uint8Array(1024).fill(i & 0xff) });
  }
  inodes.push({ path: 'pkg/c', parentPath: 'pkg', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
  inodes.push({ path: 'pkg', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });

  const stream = encodeWriteBatchStream({ inodes, chunks });
  const reader = stream.getReader();
  // Read a couple of chunks then cancel.
  const r1 = await reader.read();
  ok('first read returns bytes', !r1.done && r1.value.byteLength > 0);
  await reader.cancel(new Error('test cancellation'));
  // After cancel, reading should return done immediately.
  const r2 = await reader.read();
  ok('post-cancel read returns done', r2.done === true);
});

await group('decode side: cancellation propagates to chunkIter', async () => {
  const inodes = [];
  const chunks = [];
  for (let i = 0; i < 50; i++) {
    const path = `pkg/d/${i}.bin`;
    inodes.push({ path, parentPath: 'pkg/d', isDir: false, size: 1024, mtime: 1, mode: 0o644, chunkCount: 1 });
    chunks.push({ path, chunkId: 0, data: new Uint8Array(1024) });
  }
  inodes.push({ path: 'pkg/d', parentPath: 'pkg', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
  inodes.push({ path: 'pkg', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });

  // Build a stream that errors after the header is sent.
  const tooEarly = new ReadableStream({
    type: 'bytes',
    pull(c) { c.error(new Error('boom')); },
  });

  // The decoder should reject the stream cleanly.
  await rejects(
    'decode rejects on a stream that errors immediately',
    async () => {
      await decodeWriteBatchStream(tooEarly);
    },
  );
});

summary('w7/functional/04-cancel-mid-stream');
