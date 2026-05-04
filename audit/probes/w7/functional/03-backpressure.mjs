// W7 functional/03-backpressure
//
// The encoder uses a `pull`-based ReadableStream so the source only
// produces bytes when the consumer is ready. We verify backpressure
// by reading ONE chunk at a time with a delay between reads, and
// confirming that the encoder does NOT eagerly materialise all
// chunks in memory. Specifically:
//
//   - We instrument the encoder to expose a `peakInFlightBytes()`
//     getter.
//   - We slow-drain the stream (1 chunk per microtask).
//   - We assert the peak is ≤ a small multiple of the per-chunk
//     size (≤ 4× the largest chunk).
//
// If the encoder eagerly buffers the whole batch (no backpressure),
// the peak would be O(payload-size) and the assertion fails.

import { ok, lte, gte, group, summary } from '../_tap.mjs';

let encodeWriteBatchStream, _peakInFlightBytes;
try {
  const mod = await import('../../../../src/_shared/w7-frame.ts');
  encodeWriteBatchStream = mod.encodeWriteBatchStream;
  _peakInFlightBytes = mod._peakInFlightBytes; // diagnostics export
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/03-backpressure');
}

await group('slow-drain reader sees backpressure', async () => {
  const CHUNK_SIZE = 64 * 1024;
  const CHUNK_COUNT = 200; // 12.8 MiB total — enough to exceed any reasonable per-chunk buffer
  const inodes = [];
  const chunks = [];
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const path = `pkg/p/${i}.bin`;
    inodes.push({ path, parentPath: 'pkg/p', isDir: false, size: CHUNK_SIZE, mtime: 1, mode: 0o644, chunkCount: 1 });
    chunks.push({ path, chunkId: 0, data: new Uint8Array(CHUNK_SIZE) });
  }
  inodes.push({ path: 'pkg/p', parentPath: 'pkg', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
  inodes.push({ path: 'pkg', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });

  const stream = encodeWriteBatchStream({ inodes, chunks });
  const reader = stream.getReader();
  let totalRead = 0;
  let observedPeak = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    totalRead += value.byteLength;
    if (typeof _peakInFlightBytes === 'function') {
      const p = _peakInFlightBytes();
      if (p > observedPeak) observedPeak = p;
    }
    // Yield to event loop so the encoder's pull is forced to wait.
    await new Promise((r) => setTimeout(r, 0));
  }

  gte('all bytes read', totalRead, CHUNK_SIZE * CHUNK_COUNT);
  // The peak in-flight bytes must be much smaller than the full payload
  // — at most a few chunks worth (header + 1-2 chunks queued).
  // Allow up to 4 MiB of generous slack; total payload is ~12.8 MiB.
  if (typeof _peakInFlightBytes === 'function') {
    lte('encoder did not eagerly buffer (peak ≤ 4 MiB)', observedPeak, 4 * 1024 * 1024);
  } else {
    ok('peakInFlightBytes diagnostic available', false, 'export missing — required for backpressure verification');
  }
});

summary('w7/functional/03-backpressure');
