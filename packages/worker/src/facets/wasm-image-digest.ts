/**
 * wasm-image-digest.ts — the content key of a wasm image file, read where it
 * lies (wasm-image-key.ts is the key itself).
 */
import type { RuntimeFsBridge } from '@nimbus-sh/core/runtime/os-contracts.js';
import { WASM_IMAGE_HASH_SEED, wasmImageHash, wasmImageKey } from './wasm-image-key.js';

/** Bytes one streamed digest step reads. */
const DIGEST_SLICE_BYTES = 1024 * 1024;

/**
 * `wasmImageDigest` of a file, read one slice at a time: the coordinator
 * digests a closure's images while the launch's module map is resident, and
 * a 15 MiB image read whole beside it was enough to reset the isolate. Null
 * when the file cannot be read.
 */
export async function streamedWasmImageDigest(
  fs: Pick<RuntimeFsBridge, 'stat' | 'readRange'>,
  path: string,
): Promise<string | null> {
  const st = await Promise.resolve(fs.stat(path)).catch(() => null);
  if (!st || st.type !== 'file' || typeof st.size !== 'number') return null;
  let hash = WASM_IMAGE_HASH_SEED;
  for (let offset = 0; offset < st.size; offset += DIGEST_SLICE_BYTES) {
    const slice = await Promise.resolve(fs.readRange(path, offset, Math.min(DIGEST_SLICE_BYTES, st.size - offset)))
      .catch(() => null);
    if (!slice) return null;
    hash = wasmImageHash(hash, slice);
  }
  return wasmImageKey(st.size, hash);
}

/** One wasm image a launch registers: where the program reads it, and its content key. */
export interface WasmImageRecord {
  /** Absolute VFS path (leading slash). */
  vfsPath: string;
  digest: string;
}
