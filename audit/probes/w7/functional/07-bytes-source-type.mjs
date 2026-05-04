// W7 functional/07-bytes-source-type
//
// CF requires `type: "bytes"` for streams over RPC:
//   "Only byte-oriented streams (streams with an underlying byte source
//    of type: 'bytes') are supported."
//
// Verify our encoder emits a byte-oriented stream by attempting to
// acquire a BYOB reader (only available on byte streams). A non-byte
// stream throws TypeError on getReader({ mode: 'byob' }).

import { ok, group, summary } from '../_tap.mjs';

let encodeWriteBatchStream;
try {
  ({ encodeWriteBatchStream } =
    await import('../../../../src/_shared/w7-frame.ts'));
} catch (e) {
  ok('module src/_shared/w7-frame.ts is importable', false, e.message);
  summary('w7/functional/07-bytes-source-type');
}

await group('encoder produces a byte-oriented stream', async () => {
  const stream = encodeWriteBatchStream({
    inodes: [{ path: 'a', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }],
    chunks: [],
  });
  let byobOk = false;
  try {
    const reader = stream.getReader({ mode: 'byob' });
    byobOk = true;
    // Drain so we don't leave a locked stream.
    const buf = new Uint8Array(64 * 1024);
    while (true) {
      const { done } = await reader.read(buf);
      if (done) break;
    }
  } catch (e) {
    // If byob isn't supported, the stream is not byte-typed —
    // fail loudly with the error message.
    ok('getReader({mode:"byob"}) succeeds (byte-typed source)', false, e?.message || String(e));
  }
  if (byobOk) {
    ok('getReader({mode:"byob"}) succeeds (byte-typed source)', true);
  }
});

summary('w7/functional/07-bytes-source-type');
