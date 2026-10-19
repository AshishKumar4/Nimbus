/**
 * _shared/bytes.ts — Singleton TextEncoder / TextDecoder.
 *
 * TextEncoder and TextDecoder for UTF-8 are stateless per the WHATWG
 * Encoding spec, so a module-scope singleton is safe and saves the
 * repeated allocation (which shows up in flame graphs of hot paths
 * like sqlite-vfs writeFile and the WebSocket terminal frame decoder).
 *
 * Use these everywhere instead of `new TextEncoder()` / `new TextDecoder()`,
 * facet bundles included. Facet code that is a string, not a bundle, cannot
 * import this module and keeps its inline allocations.
 */


/** Shared UTF-8 encoder. Stateless; safe to share across all callers. */
export const enc = new TextEncoder();

/** Shared UTF-8 decoder. Stateless; safe to share across all callers. */
export const dec = new TextDecoder();

/**
 * Shared UTF-8 decoder for names (paths, directory and archive entries,
 * link targets, argv and environment) and for a stream's bytes decoded whole
 * (a write's output, a chunk of stdin). It keeps a leading U+FEFF, as git,
 * tar and Linux keep it in a name and a terminal shows it in output; `dec`
 * drops it, as a file's text drops it.
 */
export const nameDec = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * A fresh ArrayBuffer holding exactly the bytes `bytes` views — its window,
 * not its whole backing buffer — for APIs that take an ArrayBuffer
 * (WebAssembly modules, structured clone across a facet boundary).
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * A text consumer's edge over a byte stream: one streaming UTF-8 decoder per
 * key (a pid, or a (pid, stream) pair), so a multibyte character whose bytes
 * arrive in two chunks still decodes as one character, and a leading U+FEFF
 * is the stream's own, as a terminal shows it. `drop(key)` flushes the
 * decoder's pending bytes and forgets it; call it when the stream ends.
 */
export class StreamTextDecoders<K> {
  private readonly decoders = new Map<K, TextDecoder>();

  decode(key: K, bytes: Uint8Array): string {
    let decoder = this.decoders.get(key);
    if (!decoder) {
      decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      this.decoders.set(key, decoder);
    }
    return decoder.decode(bytes, { stream: true });
  }

  /** Whether `key` has a decoder (it has decoded and not been dropped). */
  has(key: K): boolean {
    return this.decoders.has(key);
  }

  /** Flush what a truncated final character left behind, then forget the key. */
  drop(key: K): string {
    const decoder = this.decoders.get(key);
    if (!decoder) return '';
    this.decoders.delete(key);
    return decoder.decode();
  }
}

/** `parts`, one after another, in one array. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
