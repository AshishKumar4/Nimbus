/**
 * _shared/byte-stream.ts — bounded byte streaming between the VFS and a
 * command's output.
 *
 * Every coreutil that copies file content (`cat`, `head -c`, `dd`) needs the
 * same three properties, and getting any of them wrong produces silently
 * wrong bytes:
 *
 *   1. Bounded memory. Content moves one chunk at a time, so a 25 MB file
 *      never becomes a 25 MB buffer — which matters because facet↔supervisor
 *      RPC payloads are capped (MAX_RPC_SAFE_PAYLOAD_BYTES).
 *   2. A real write offset. The sink advances; it does not restate the file.
 *   3. Chunk boundaries that do not corrupt text. A UTF-8 sequence split
 *      across two chunks must decode as one character, not two replacements,
 *      so text sinks get a streaming decoder rather than per-chunk decodes.
 */

/**
 * A command's output destination.
 *
 * `writeBytes` is present on sinks that store bytes verbatim — files,
 * `/dev/null`, and shell pipes, which carry the producer's exact bytes.
 * Sinks without it take decoded text instead. This is a real capability
 * difference, not a fallback: a terminal has no way to hold a byte that is
 * not text.
 */
export interface ByteSink {
  write(text: string): void;
  writeBytes?(bytes: Uint8Array): void;
}

/** Reads at most `length` bytes at `offset`; an empty result means EOF. */
export type RangeReader = (offset: number, length: number) => Uint8Array;

/** Bytes moved per read. Comfortably under any RPC payload ceiling. */
export const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * Feeds bytes to a {@link ByteSink}, decoding across chunk boundaries when the
 * sink is textual. Callers must `end()` so a trailing partial UTF-8 sequence
 * is flushed.
 */
export class SinkWriter {
  private readonly decoder: TextDecoder | null;
  private written = 0;

  constructor(private readonly sink: ByteSink) {
    this.decoder = sink.writeBytes ? null : new TextDecoder('utf-8');
  }

  get bytesWritten(): number {
    return this.written;
  }

  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.written += bytes.length;
    if (this.decoder) this.sink.write(this.decoder.decode(bytes, { stream: true }));
    else this.sink.writeBytes!(bytes);
  }

  end(): void {
    if (!this.decoder) return;
    const tail = this.decoder.decode();
    if (tail) this.sink.write(tail);
  }
}

/**
 * Copies bytes from `read` into `sink` in {@link STREAM_CHUNK_BYTES} chunks.
 *
 * Stops at `length` bytes when given one, otherwise at the first short read
 * (EOF). Returns the number of bytes copied. Does not call `sink.end()` —
 * callers that write more than one range share a single writer.
 */
export function streamRange(
  read: RangeReader,
  writer: SinkWriter,
  options: { offset?: number; length?: number; signal?: AbortSignal } = {},
): number {
  const { offset = 0, length, signal } = options;
  let position = offset;
  let copied = 0;

  while (length === undefined || copied < length) {
    if (signal?.aborted) break;
    const want = length === undefined
      ? STREAM_CHUNK_BYTES
      : Math.min(STREAM_CHUNK_BYTES, length - copied);
    const chunk = read(position, want);
    if (chunk.length === 0) break;
    writer.write(chunk);
    position += chunk.length;
    copied += chunk.length;
  }

  return copied;
}
