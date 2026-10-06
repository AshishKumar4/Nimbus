/**
 * _shared/bytes.ts — Singleton TextEncoder / TextDecoder.
 *
 * TextEncoder and TextDecoder for UTF-8 are stateless per the WHATWG
 * Encoding spec, so a module-scope singleton is safe and saves the
 * repeated allocation (which shows up in flame graphs of hot paths
 * like sqlite-vfs writeFile and the WebSocket terminal frame decoder).
 *
 * Use these everywhere instead of `new TextEncoder()` / `new TextDecoder()`
 * in the supervisor isolate. Facet-isolate code-strings (e.g. inside
 * generateGitNetworkFacetCode) cannot import this module and must keep
 * their inline allocations — those copies are justified.
 */
import { SinkWriter } from './byte-stream.js';
/** Shared UTF-8 encoder. Stateless; safe to share across all callers. */
export const enc = new TextEncoder();
/** Shared UTF-8 decoder. Stateless; safe to share across all callers. */
export const dec = new TextDecoder();
/**
 * A fresh ArrayBuffer holding exactly the bytes `bytes` views — its window,
 * not its whole backing buffer — for APIs that take an ArrayBuffer
 * (WebAssembly modules, structured clone across a facet boundary).
 */
export function toArrayBuffer(bytes) {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}
/**
 * A text consumer's edge over a byte stream: one streaming UTF-8 decoder per
 * key (a pid, or a (pid, stream) pair), so a multibyte character whose bytes
 * arrive in two chunks still decodes as one character. `drop(key)` flushes
 * the decoder's pending bytes and forgets it; call it when the stream ends.
 */
export class StreamTextDecoders {
    decoders = new Map();
    decode(key, bytes) {
        let decoder = this.decoders.get(key);
        if (!decoder) {
            decoder = new TextDecoder('utf-8');
            this.decoders.set(key, decoder);
        }
        return decoder.decode(bytes, { stream: true });
    }
    /** Flush what a truncated final character left behind, then forget the key. */
    drop(key) {
        const decoder = this.decoders.get(key);
        if (!decoder)
            return '';
        this.decoders.delete(key);
        return decoder.decode();
    }
}
/**
 * A text writer's edge over a byte hook: an `onStdout`-shaped callback whose
 * bytes reach `write` as text through its own {@link SinkWriter}, so a text
 * consumer reads whole characters even when a multibyte one straddles two
 * chunks. One per stream; do not share a sink between stdout and stderr.
 */
export function textSink(write) {
    const writer = new SinkWriter({ write });
    return (bytes) => writer.write(bytes);
}
