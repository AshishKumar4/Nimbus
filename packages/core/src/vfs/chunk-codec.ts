/**
 * How the durable filesystem stores a chunk's bytes: deflated when that pays.
 *
 * A chunk is deflated (raw deflate, level 1, native zlib) and kept that way
 * when the result is at least an eighth smaller, else stored as it is. Source
 * trees and node_modules shrink 2.8-4x, and a DO write costs what it puts on
 * pages, so the smaller row is also the faster write. A chunk's name (its
 * sha256) and size are always of its bytes as written: dedup, manifests,
 * exports and the cold store never see the stored form.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** zlib's fastest level: most of the saving for a fraction of the CPU. */
const DEFLATE_LEVEL = 1;

/** `raw` deflated, or null when that does not save at least an eighth of it. */
export function deflateChunk(raw: Uint8Array): Uint8Array | null {
  const deflated = deflateRawSync(raw, { level: DEFLATE_LEVEL });
  if (deflated.byteLength > raw.byteLength - raw.byteLength / 8) return null;
  // zlib's output is a view of a larger buffer; the row gets only its bytes.
  return new Uint8Array(deflated);
}

/** A deflated chunk's bytes; throws unless they inflate to exactly `size`. */
export function inflateChunk(data: Uint8Array, size: number): Uint8Array {
  const raw = inflateRawSync(data);
  if (raw.byteLength !== size) throw new Error(`inflates to ${raw.byteLength} bytes, not ${size}`);
  return raw.byteOffset === 0 && raw.buffer.byteLength === size
    ? new Uint8Array(raw.buffer, 0, size)
    : new Uint8Array(raw);
}
