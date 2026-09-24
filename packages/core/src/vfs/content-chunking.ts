/**
 * Content addressing for the durable filesystem: how file bytes become chunks,
 * and what identifies a chunk and a file.
 *
 * A file of at most CHUNK_SIZE bytes is one chunk. A larger file is cut by
 * FastCDC with normalized chunking (Xia et al., USENIX ATC 2016) at 16/32/64
 * KiB, so an edit moves only the cuts near it and identical runs of bytes in
 * different files or versions land on identical chunks. The maximum equals
 * CHUNK_SIZE, which keeps every existing per-row and per-transaction bound.
 *
 * A cut depends only on the bytes from the previous cut to at most CDC_MAX
 * beyond it, so cutting a stream piecewise (ContentCutter) gives exactly the
 * cuts of cutting the whole buffer at once.
 */

import { createHash } from 'node:crypto';
import { CHUNK_SIZE } from '@nimbus-sh/platform/limits.js';

export const CDC_MIN = 16_384;
export const CDC_AVG = 32_768;
export const CDC_MAX = CHUNK_SIZE;

// Int32 throughout: a uint32 past 2^31 leaves the engines' small-integer
// representation, which halves the scan rate.
const GEAR = new Int32Array(256);
{
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    GEAR[i] = x | 0;
  }
}

/** `bits` one-bits spread across the top of a 32-bit word (the paper's padded masks). */
function spreadMask(bits: number): number {
  let mask = 0;
  const step = 32 / bits;
  for (let i = 0; i < bits; i++) mask |= 1 << (31 - Math.floor(i * step));
  return mask | 0;
}

const AVG_BITS = Math.round(Math.log2(CDC_AVG));
const MASK_S = spreadMask(AVG_BITS + 2);
const MASK_L = spreadMask(AVG_BITS - 2);

/**
 * End offset of the chunk that starts at `start`, given bytes up to `end`.
 * Returns -1 when the answer needs bytes past `end` and `final` is false.
 */
export function cdcCut(data: Uint8Array, start: number, end: number, final: boolean): number {
  const remaining = end - start;
  if (remaining <= CDC_MIN) return final ? end : -1;
  if (remaining < CDC_MAX && !final) {
    // The cut may still fall inside what is here; only a miss needs more.
    const cut = scan(data, start, end);
    return cut < end ? cut : -1;
  }
  return scan(data, start, Math.min(start + CDC_MAX, end));
}

function scan(data: Uint8Array, start: number, limit: number): number {
  const normal = Math.min(start + CDC_AVG, limit);
  let h = 0;
  let i = start + CDC_MIN;
  for (; i < normal; i++) {
    h = ((h << 1) + GEAR[data[i]!]!) | 0;
    if ((h & MASK_S) === 0) return i + 1;
  }
  for (; i < limit; i++) {
    h = ((h << 1) + GEAR[data[i]!]!) | 0;
    if ((h & MASK_L) === 0) return i + 1;
  }
  return limit;
}

/** Chunk end offsets of a whole buffer: one chunk up to CHUNK_SIZE, FastCDC above. */
export function cutContent(data: Uint8Array): number[] {
  if (data.length <= CHUNK_SIZE) return data.length === 0 ? [] : [data.length];
  const ends: number[] = [];
  let start = 0;
  while (start < data.length) {
    const cut = cdcCut(data, start, data.length, true);
    ends.push(cut);
    start = cut;
  }
  return ends;
}

/**
 * Incremental FastCDC over bytes that arrive in pieces. Holds at most CDC_MAX
 * bytes plus the piece being pushed.
 */
export class ContentCutter {
  private carry: Uint8Array = new Uint8Array(0);

  /** Complete chunks the bytes pushed so far determine. */
  push(bytes: Uint8Array): Uint8Array[] {
    const buffer = this.carry.length === 0 ? bytes : concat(this.carry, bytes);
    const out: Uint8Array[] = [];
    let start = 0;
    for (;;) {
      const cut = cdcCut(buffer, start, buffer.length, false);
      if (cut < 0) break;
      out.push(buffer.subarray(start, cut));
      start = cut;
    }
    // The carry must outlive the caller's buffer, which it may reuse.
    this.carry = buffer.slice(start);
    return out;
  }

  /** The chunks left once the stream has ended. */
  finish(): Uint8Array[] {
    const buffer = this.carry;
    this.carry = new Uint8Array(0);
    const out: Uint8Array[] = [];
    let start = 0;
    while (start < buffer.length) {
      const cut = cdcCut(buffer, start, buffer.length, true);
      out.push(buffer.subarray(start, cut));
      start = cut;
    }
    return out;
  }

  get pending(): number {
    return this.carry.length;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** sha256 of one chunk: the chunk's durable identity. */
export function chunkHash(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

const MANIFEST_DOMAIN = new TextEncoder().encode('nimbus-manifest-v1');

/** Running digest of a manifest: domain ‖ size ‖ chunk hashes in order. */
export class ManifestDigest {
  private readonly hash = createHash('sha256').update(MANIFEST_DOMAIN);

  add(chunk: Uint8Array): void {
    this.hash.update(chunk);
  }

  digest(size: number): Uint8Array {
    const trailer = new Uint8Array(8);
    new DataView(trailer.buffer).setBigUint64(0, BigInt(size));
    return new Uint8Array(this.hash.update(trailer).digest());
  }
}

/** Content key of the empty file. */
export const EMPTY_CONTENT_KEY = chunkHash(new Uint8Array(0));

const HEX_BYTE: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
const nativeHex = (Uint8Array.prototype as { toHex?: (this: Uint8Array) => string }).toHex;

/**
 * Lowercase hex. A listing encodes one key per file, so this is on the
 * enumeration's hot path: the native encoder where the runtime has one, else
 * a table (measured 0.03 and 0.17 µs per 32-byte key, against 0.82 for a
 * toString/padStart loop).
 */
export function hex(bytes: Uint8Array): string {
  if (nativeHex !== undefined) return nativeHex.call(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX_BYTE[bytes[i]!];
  return out;
}
