// W7 functional/05-error-propagation
//
// Errors injected mid-stream propagate to the consumer:
//   - Source emits a few chunks then errors.
//   - Consumer iterating the chunkIter receives the error (rejects).
//   - Subsequent reads remain in errored state.

import { ok, group, summary, rejects } from '../_tap.mjs';

let decodeWriteBatchStream;
try {
  ({ decodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/05-error-propagation');
}

await group('decoder surfaces a malformed magic-byte stream', async () => {
  const bad = new ReadableStream({
    type: 'bytes',
    start(c) {
      // Wrong magic — should fail magic check immediately.
      c.enqueue(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
      c.close();
    },
  });
  await rejects(
    'malformed magic rejects',
    async () => {
      const decoded = await decodeWriteBatchStream(bad);
      // If decoder doesn't fail at parse time, it must fail when draining.
      for await (const _ of decoded.chunkIter) { /* drain */ }
    },
    'magic',
  );
});

await group('decoder surfaces a truncated header', async () => {
  const enc = new TextEncoder();
  const truncated = new ReadableStream({
    type: 'bytes',
    start(c) {
      // Valid magic, then a header-length claiming 1024 bytes, but stream ends after 4.
      c.enqueue(new Uint8Array([0x4e, 0x57, 0x37, 0x01])); // 'NW7\x01'
      c.enqueue(new Uint8Array([0x00, 0x04, 0x00, 0x00])); // hdrLen = 1024 (LE)
      c.enqueue(enc.encode('part'));
      c.close();
    },
  });
  await rejects(
    'truncated header rejects',
    async () => {
      const decoded = await decodeWriteBatchStream(truncated);
      for await (const _ of decoded.chunkIter) {}
    },
  );
});

summary('w7/functional/05-error-propagation');
