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
/** Bytes moved per read. Comfortably under any RPC payload ceiling. */
export const STREAM_CHUNK_BYTES = 64 * 1024;
/**
 * Feeds bytes to a {@link ByteSink}, decoding across chunk boundaries when the
 * sink is textual. Callers must `end()` so a trailing partial UTF-8 sequence
 * is flushed.
 */
export class SinkWriter {
    sink;
    decoder;
    written = 0;
    constructor(sink) {
        this.sink = sink;
        // A stream's text keeps a leading U+FEFF: it is output, not a document.
        this.decoder = sink.writeBytes ? null : new TextDecoder('utf-8', { ignoreBOM: true });
    }
    get bytesWritten() {
        return this.written;
    }
    async write(bytes) {
        if (bytes.length === 0)
            return;
        if (this.decoder) {
            // A chunk that ends inside a multibyte character may decode to nothing yet.
            const text = this.decoder.decode(bytes, { stream: true });
            if (text)
                await this.sink.write(text);
        }
        else {
            await this.sink.writeBytes(bytes);
        }
        this.written += bytes.length;
    }
    /**
     * Text, in order with the bytes: for a textual sink, after any character
     * the bytes before it left unfinished (a replacement character, as decoding
     * those bytes and the text's as one stream gives). Not counted in
     * {@link bytesWritten}, which is what was written as bytes.
     */
    async writeText(text) {
        // No text is no boundary: the bytes before and after decode as one.
        if (!text)
            return;
        const unfinished = this.decoder ? this.decoder.decode() : '';
        await this.sink.write(unfinished + text);
    }
    async end() {
        if (!this.decoder)
            return;
        const tail = this.decoder.decode();
        if (tail)
            await this.sink.write(tail);
    }
}
/**
 * Copies bytes from `read` into `sink` in {@link STREAM_CHUNK_BYTES} chunks.
 *
 * Stops at `length` bytes when given one, otherwise at the first empty read
 * (EOF). Returns the number of bytes copied. Does not call `sink.end()` —
 * callers that write more than one range share a single writer.
 */
export async function streamRange(read, writer, options = {}) {
    const { offset = 0, length, signal } = options;
    let position = offset;
    let copied = 0;
    while (length === undefined || copied < length) {
        signal?.throwIfAborted();
        const want = length === undefined
            ? STREAM_CHUNK_BYTES
            : Math.min(STREAM_CHUNK_BYTES, length - copied);
        const chunk = await read(position, want);
        if (chunk.length === 0)
            break;
        await writer.write(chunk);
        position += chunk.length;
        copied += chunk.length;
    }
    return copied;
}
/**
 * An `onStdout`/`onStderr` pair of byte hooks into `outputs`' stdout and
 * stderr, each through a SinkWriter of its own, and `end`, which ends both
 * (a character their last bytes left unfinished is written), the second
 * even when the first fails.
 */
export function outputHooks(outputs) {
    const stdout = new SinkWriter(outputs.stdout);
    const stderr = new SinkWriter(outputs.stderr);
    return {
        onStdout: (bytes) => stdout.write(bytes),
        onStderr: (bytes) => stderr.write(bytes),
        end: async () => {
            try {
                await stdout.end();
            }
            finally {
                await stderr.end();
            }
        },
    };
}
