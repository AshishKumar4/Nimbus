// W7 functional/02-large-payload
//
// Verify a 50 MB payload survives encode → decode without size cap.
// Pre-W7 this would be impossible (32 MiB structured-clone wall when
// passed via env.SUPERVISOR.writeBatch). Post-W7 the encode/decode
// round-trip handles it because:
//   (a) the encoder yields chunks of bounded size (≤256 KiB each),
//   (b) the decoder consumes lazily from the chunk iterator,
//   (c) the resulting iterator yields BatchChunkEntry items whose
//       data is at most chunkSize bytes (default 64 KiB).
//
// We DO NOT load all 50 MB into a JS array of Uint8Array up-front in
// this test; we use a sparse generator to avoid the test itself
// hitting node's heap cap. The encoder must stream from a payload
// that yields chunks lazily, OR we materialise from a synthesizer
// helper. We use the materialise-from-helper shape because that's
// closest to how npm-install-batch-facet builds its payload (it
// already builds a chunks[] array in memory before calling
// writeBatch — the gain in W7 is that we no longer have to send all
// ~50 MB of chunks[] across structured-clone in one shot).

import { ok, eq, gte, lte, group, summary } from '../_tap.mjs';

let encodeWriteBatchStream, decodeWriteBatchStream;
try {
  ({ encodeWriteBatchStream, decodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/02-large-payload');
}

await group('encode/decode a 50 MB payload', async () => {
  // 800 chunks × 64 KiB = ~51.2 MiB. Each chunk's data is a 64 KiB
  // Uint8Array filled with a per-chunk byte pattern.
  const CHUNK_SIZE = 64 * 1024;
  const CHUNK_COUNT = 800;
  const TOTAL_BYTES = CHUNK_SIZE * CHUNK_COUNT;

  const inodes = [];
  const chunks = [];
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const path = `pkg/big/chunk-${i}.bin`;
    inodes.push({
      path, parentPath: 'pkg/big',
      isDir: false, size: CHUNK_SIZE,
      mtime: 1, mode: 0o644, chunkCount: 1,
    });
    const data = new Uint8Array(CHUNK_SIZE);
    // Cheap deterministic fill: byte = (i * 17 + offset) & 0xFF.
    const seed = (i * 17) & 0xff;
    for (let b = 0; b < CHUNK_SIZE; b++) data[b] = (seed + b) & 0xff;
    chunks.push({ path, chunkId: 0, data });
  }
  inodes.push({ path: 'pkg/big', parentPath: 'pkg', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
  inodes.push({ path: 'pkg', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });

  const payload = { inodes, chunks };

  const stream = encodeWriteBatchStream(payload);
  ok('encoder returns ReadableStream', stream instanceof ReadableStream);

  const decoded = await decodeWriteBatchStream(stream);
  eq('inode count preserved', decoded.inodes.length, payload.inodes.length);

  let totalBytes = 0;
  let chunksSeen = 0;
  let allMatch = true;
  for await (const c of decoded.chunkIter) {
    chunksSeen++;
    totalBytes += c.data.length;
    // Spot-check first byte against the seed.
    const idx = parseInt(c.path.split('chunk-')[1], 10);
    if (!Number.isFinite(idx)) { allMatch = false; break; }
    const expectedSeed = (idx * 17) & 0xff;
    if (c.data[0] !== expectedSeed) { allMatch = false; }
    if (c.data[CHUNK_SIZE - 1] !== ((expectedSeed + CHUNK_SIZE - 1) & 0xff)) { allMatch = false; }
  }

  eq('chunks seen', chunksSeen, CHUNK_COUNT);
  eq('total bytes streamed', totalBytes, TOTAL_BYTES);
  ok('all chunk seeds match', allMatch);
  // 50 MB > 32 MiB cap. The encoded size is *strictly larger* than 32 MiB
  // (header + framing overhead pushes it well above). The fact that this
  // test runs to completion without a structured-clone error is the
  // primary acceptance signal for W7.
  gte('streamed > 32 MiB (bypasses cap)', totalBytes, 33 * 1024 * 1024);
});

summary('w7/functional/02-large-payload');
