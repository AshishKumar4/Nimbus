/**
 * w7-frame.ts — Wire protocol for streaming bulk-write payloads
 * from facet to supervisor over RPC, bypassing the 32 MiB
 * structured-clone cap.
 *
 * Frame format (W7 wire protocol v1):
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ MAGIC: 4 bytes — 'NW7\x01'  (Nimbus W7 v1)             │
 *   │ HDR_LEN: 4 bytes uint32-LE — length of header JSON      │
 *   │ HDR_JSON: HDR_LEN bytes UTF-8 JSON                      │
 *   │   { inodes: BatchInodeEntry[], deletePaths?: string[],  │
 *   │     chunkCount: number }                                │
 *   │ For each chunk (chunkCount times):                       │
 *   │   PATH_LEN: 4 bytes uint32-LE                            │
 *   │   PATH_BYTES: PATH_LEN bytes UTF-8                       │
 *   │   CHUNK_ID:  4 bytes uint32-LE                           │
 *   │   DATA_LEN:  4 bytes uint32-LE                            │
 *   │   DATA:      DATA_LEN bytes raw                            │
 *   │ TRAILER: 4 bytes — 'NEND'                                │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Why a custom frame and not CBOR / protobuf:
 *   - We control both ends; no schema-evolution constraint.
 *   - The whole point is byte-counted streaming with type: 'bytes'.
 *   - Adding a transport dep would bloat the facet preamble.
 *
 * Contract per Cloudflare Workers RPC docs
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/):
 *
 *   - Only byte-oriented streams (`type: 'bytes'`) traverse RPC.
 *   - Ownership transfers — sender cannot read after sending.
 *   - Flow control is automatic on the byte-stream.
 *
 * The encoder uses `type: 'bytes'` so the resulting stream is
 * byob-readable, which is the precise requirement for RPC transit.
 */

import type { BatchInodeEntry, BatchChunkEntry, BatchWritePayload } from '../vfs/sqlite-vfs.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Magic bytes 'NW7\x01' — start of every W7 frame.
 *  Not Object.freeze'd: typed-array storage isn't a configurable property,
 *  so freezing throws on any later byte-write. We rely on internal
 *  discipline + .slice() at every emission point. */
export const W7_MAGIC = new Uint8Array([0x4e, 0x57, 0x37, 0x01]);

/** Trailer 'NEND' — sanity terminator. Same freeze caveat applies. */
export const W7_TRAILER = new Uint8Array([0x4e, 0x45, 0x4e, 0x44]);

/** Highwater mark for the encoder's queueing strategy. Bounds backpressure. */
const ENCODER_QUEUE_HWM = 256 * 1024;

/** Chunk-emit boundary inside the encoder (max bytes per ReadableStream
 *  enqueue). 64 KiB matches typical SqliteVFS chunk size. */
const ENCODER_EMIT_CAP = 64 * 1024;

// ── Diagnostics ────────────────────────────────────────────────────────
//
// W7-plan §9.4 — the heap-peak harness needs visibility into how many
// bytes are simultaneously resident inside the encoder's queue. We
// maintain a module-scoped peak counter that the test harness reads.
//
// Production code must NOT depend on this. It's purely diagnostic.
// `_resetPeakInFlightBytes()` is called at the start of each test
// scenario to isolate measurements.

let _peakInFlight = 0;
let _currentInFlight = 0;

/** Diagnostics — peak in-flight bytes resident inside any active encoder
 *  queue since last reset. Used by the heap-peak probe to verify the
 *  ≤ 30 MiB acceptance gate. */
export function _peakInFlightBytes(): number {
  return _peakInFlight;
}

/** Diagnostics — reset both peak and current counters. Intended for
 *  test isolation between scenarios. */
export function _resetPeakInFlightBytes(): void {
  _peakInFlight = 0;
  _currentInFlight = 0;
}

function _trackInFlightAdd(n: number): void {
  _currentInFlight += n;
  if (_currentInFlight > _peakInFlight) _peakInFlight = _currentInFlight;
}

function _trackInFlightSub(n: number): void {
  _currentInFlight -= n;
  if (_currentInFlight < 0) _currentInFlight = 0;
}

// ── Encoder ────────────────────────────────────────────────────────────

/**
 * Encode a BatchWritePayload as a byte-oriented ReadableStream.
 *
 * Returns a `ReadableStream<Uint8Array>` with `type: 'bytes'` (BYOB
 * readable, RPC-transferable). The stream:
 *   1. Emits MAGIC.
 *   2. Emits HDR_LEN + HDR_JSON encoding inode metadata, deletePaths,
 *      and chunkCount.
 *   3. Emits each chunk record (PATH_LEN, PATH, CHUNK_ID, DATA_LEN, DATA).
 *   4. Emits TRAILER.
 *   5. Closes.
 *
 * Backpressure: the source uses `pull()` — the encoder produces the
 * NEXT chunk only when the consumer has drained the queue below the
 * HWM. Module-level `_currentInFlight` tracks queue residency for the
 * heap-peak probe.
 */
export function encodeWriteBatchStream(payload: BatchWritePayload): ReadableStream<Uint8Array> {
  const inodes = payload.inodes ?? [];
  const chunks = payload.chunks ?? [];
  const deletePaths = payload.deletePaths;

  // Stream emission state:
  //   phase 0 = magic
  //   phase 1 = header (length-prefixed JSON)
  //   phase 2 = chunks (iterating)
  //   phase 3 = trailer
  //   phase 4 = closed
  let phase: 0 | 1 | 2 | 3 | 4 = 0;
  let chunkIdx = 0;
  const enc = new TextEncoder();
  const headerBytes = enc.encode(JSON.stringify({
    inodes,
    deletePaths,
    chunkCount: chunks.length,
  }));

  // The DOM `ReadableStream<R>` constructor has two overloads keyed by
  // the literal type of `source.type`. When the object literal's
  // `type` is widened to `string` (as happens through @cloudflare's
  // ambient-typed mods), TS picks the default-controller overload and
  // rejects `'bytes'`. Build the source as `UnderlyingByteSource` and
  // pass it through an explicit cast — runtime behaviour is unchanged.
  const source: UnderlyingByteSource = {
    type: 'bytes',
    pull(controller: ReadableByteStreamController) {
      // Each pull() emits ONE bounded record. The HWM combined with
      // pull-on-demand means the queue holds at most ~1 emit-cap of
      // bytes at a time — backpressure is automatic.
      try {
        if (phase === 0) {
          enqueue(controller, W7_MAGIC.slice());
          phase = 1;
          return;
        }
        if (phase === 1) {
          // HDR_LEN (uint32 LE) + HDR_JSON.
          const hdr = new Uint8Array(4 + headerBytes.length);
          writeU32LE(hdr, 0, headerBytes.length);
          hdr.set(headerBytes, 4);
          enqueue(controller, hdr);
          phase = 2;
          return;
        }
        if (phase === 2) {
          if (chunkIdx >= chunks.length) {
            phase = 3;
            // Tail-call the trailer immediately so we don't waste a
            // pull() iteration on a no-op.
          } else {
            const c = chunks[chunkIdx++];
            const pathBytes = enc.encode(c.path);
            const data = c.data instanceof Uint8Array
              ? c.data
              : new Uint8Array(c.data as ArrayBufferLike);
            // Emit the chunk record. If the data exceeds the emit cap,
            // split into multiple enqueues (header chunk first, then
            // data segments). This bounds the per-pull queue load even
            // for very large chunk payloads (rare in practice; SqliteVFS
            // chunks are 64 KiB max).
            const headerSize = 4 + pathBytes.length + 4 + 4;
            const headerOut = new Uint8Array(headerSize);
            let o = 0;
            writeU32LE(headerOut, o, pathBytes.length); o += 4;
            headerOut.set(pathBytes, o); o += pathBytes.length;
            writeU32LE(headerOut, o, c.chunkId); o += 4;
            writeU32LE(headerOut, o, data.length); o += 4;
            enqueue(controller, headerOut);
            // Chunk data — split by emit cap if oversize.
            if (data.length === 0) return;
            if (data.length <= ENCODER_EMIT_CAP) {
              enqueue(controller, data);
            } else {
              for (let i = 0; i < data.length; i += ENCODER_EMIT_CAP) {
                enqueue(controller, data.subarray(i, Math.min(i + ENCODER_EMIT_CAP, data.length)));
              }
            }
            return;
          }
        }
        if (phase === 3) {
          enqueue(controller, W7_TRAILER.slice());
          phase = 4;
          controller.close();
          return;
        }
        // phase === 4 — already closed; defensive.
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      // Reset diagnostics on cancellation so a leaked counter doesn't
      // pollute subsequent measurements.
      phase = 4;
      chunkIdx = chunks.length;
    },
  };
  return new ReadableStream<Uint8Array>(source as any, {
    // Byte streams (`type: 'bytes'`) MUST use the default byte-counted
    // strategy: highWaterMark is in bytes, size is implicit. Custom
    // `size` callbacks are forbidden — they throw at construction.
    highWaterMark: ENCODER_QUEUE_HWM,
  });

  function enqueue(controller: ReadableByteStreamController, bytes: Uint8Array): void {
    _trackInFlightAdd(bytes.byteLength);
    controller.enqueue(bytes);
    // The bytes leave our queue once the consumer reads them. We can't
    // observe that directly; we approximate by decrementing on the
    // next microtask, which is when the read settles in workerd.
    queueMicrotask(() => _trackInFlightSub(bytes.byteLength));
  }
}

// ── Decoder ────────────────────────────────────────────────────────────

/**
 * Decode a W7 stream into a structured handle:
 *   - `inodes` and `deletePaths` are read eagerly (the header arrives
 *     in the first frame; metadata is small).
 *   - `chunkIter` is an AsyncIterable that yields `BatchChunkEntry`
 *     items one at a time, lazily, as bytes arrive.
 *
 * The chunk iterator is resumable but NOT seekable. The caller must
 * iterate it linearly. Closing the iterator early is permitted (the
 * underlying reader is released).
 *
 * Errors propagate:
 *   - Magic mismatch → rejects on the returned promise.
 *   - Truncated header → rejects on the returned promise.
 *   - Truncated chunk record → the iterator throws the error.
 *   - Source error mid-stream → the iterator throws the error.
 */
export async function decodeWriteBatchStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{
  inodes: BatchInodeEntry[];
  chunkIter: AsyncIterable<BatchChunkEntry>;
  deletePaths?: string[];
}> {
  const reader = stream.getReader();
  // Pull byte-buffer of unread data; we accumulate as needed.
  const buf = new ByteBuffer(reader);

  // 1. Magic.
  const magic = await buf.readExact(4, 'magic');
  if (!bytesEqual(magic, W7_MAGIC)) {
    try { reader.releaseLock(); } catch { /* best-effort */ }
    throw new Error(`w7-frame: bad magic, expected NW7\\x01, got ${Array.from(magic).map(b => b.toString(16)).join(' ')}`);
  }

  // 2. Header length + JSON.
  const hdrLenBytes = await buf.readExact(4, 'header-length');
  const hdrLen = readU32LE(hdrLenBytes, 0);
  if (hdrLen < 0 || hdrLen > 64 * 1024 * 1024) {
    throw new Error(`w7-frame: implausible header length ${hdrLen}`);
  }
  const hdrJson = await buf.readExact(hdrLen, 'header-json');
  let header: { inodes: BatchInodeEntry[]; deletePaths?: string[]; chunkCount: number };
  try {
    header = JSON.parse(new TextDecoder().decode(hdrJson));
  } catch (e: any) {
    throw new Error(`w7-frame: header JSON parse failed: ${e?.message || e}`);
  }
  if (!header || !Array.isArray(header.inodes) || typeof header.chunkCount !== 'number') {
    throw new Error('w7-frame: header missing required fields (inodes / chunkCount)');
  }

  // 3. Chunk iterator.
  const chunkIter: AsyncIterable<BatchChunkEntry> = {
    [Symbol.asyncIterator]() {
      let idx = 0;
      let exhausted = false;
      return {
        async next(): Promise<IteratorResult<BatchChunkEntry>> {
          if (exhausted) return { value: undefined as any, done: true };
          if (idx >= header.chunkCount) {
            // Read trailer.
            const trailer = await buf.readExact(4, 'trailer');
            if (!bytesEqual(trailer, W7_TRAILER)) {
              throw new Error(
                `w7-frame: bad trailer, expected NEND, got ${Array.from(trailer).map(b => String.fromCharCode(b)).join('')}`,
              );
            }
            try { reader.releaseLock(); } catch { /* best-effort */ }
            exhausted = true;
            return { value: undefined as any, done: true };
          }
          // PATH_LEN, PATH, CHUNK_ID, DATA_LEN, DATA.
          const pathLenBytes = await buf.readExact(4, 'chunk-path-length');
          const pathLen = readU32LE(pathLenBytes, 0);
          if (pathLen < 0 || pathLen > 64 * 1024) {
            throw new Error(`w7-frame: implausible path length ${pathLen} at chunk ${idx}`);
          }
          const pathBytes = await buf.readExact(pathLen, 'chunk-path');
          const path = new TextDecoder().decode(pathBytes);
          const chunkIdBytes = await buf.readExact(4, 'chunk-id');
          const chunkId = readU32LE(chunkIdBytes, 0);
          const dataLenBytes = await buf.readExact(4, 'chunk-data-length');
          const dataLen = readU32LE(dataLenBytes, 0);
          if (dataLen < 0 || dataLen > 64 * 1024 * 1024) {
            throw new Error(`w7-frame: implausible data length ${dataLen} at chunk ${idx}`);
          }
          const data = await buf.readExact(dataLen, 'chunk-data');
          idx++;
          return { value: { path, chunkId, data }, done: false };
        },
        async return(): Promise<IteratorResult<BatchChunkEntry>> {
          exhausted = true;
          try { reader.releaseLock(); } catch { /* best-effort */ }
          return { value: undefined as any, done: true };
        },
      };
    },
  };

  return {
    inodes: header.inodes,
    deletePaths: header.deletePaths,
    chunkIter,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function writeU32LE(out: Uint8Array, off: number, n: number): void {
  out[off] = n & 0xff;
  out[off + 1] = (n >>> 8) & 0xff;
  out[off + 2] = (n >>> 16) & 0xff;
  out[off + 3] = (n >>> 24) & 0xff;
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array | Readonly<Uint8Array>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Lazy byte buffer over a ReadableStreamDefaultReader<Uint8Array>.
 * `readExact(n, label)` returns a contiguous Uint8Array of exactly N
 * bytes. Reads from the underlying reader as needed; throws if the
 * stream ends before N bytes are available.
 *
 * NOTE: returns a fresh Uint8Array (copy). This costs a memcpy per
 * read but simplifies lifetime — callers can hold the slice past the
 * next read without worrying about buffer overwrites.
 */
class ByteBuffer {
  private chunks: Uint8Array[] = [];
  private avail = 0;
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readExact(n: number, label: string): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);
    while (this.avail < n) {
      if (this.done) {
        throw new Error(
          `w7-frame: stream ended ${this.avail} bytes into expected ${n}-byte ${label}`,
        );
      }
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
      } else if (value && value.length > 0) {
        this.chunks.push(value);
        this.avail += value.length;
      }
    }
    // Copy the first N bytes into a fresh slice; advance the buffer.
    const out = new Uint8Array(n);
    let copied = 0;
    while (copied < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - copied);
      out.set(head.subarray(0, take), copied);
      copied += take;
      if (take === head.length) {
        this.chunks.shift();
      } else {
        // Replace head with the unconsumed tail.
        this.chunks[0] = head.subarray(take);
      }
    }
    this.avail -= n;
    return out;
  }
}
