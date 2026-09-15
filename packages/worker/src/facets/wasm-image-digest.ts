/**
 * wasm-image-digest.ts — the content key a wasm image is registered under.
 *
 * A launch stages every wasm image its program's closure holds as a
 * module-map member, compiled by the loader, and registers it by VFS path
 * AND by a digest of its bytes. The node-shims WebAssembly seam answers
 * `new WebAssembly.Module(bytes)` / `WebAssembly.compile(bytes)` with the
 * compiled module when the bytes match a registered digest — whether the
 * program read them off the filesystem, inlined them as base64 in its own
 * source, or received them some other way. The key is what wasm IS, not how
 * it arrived.
 *
 * Length and FNV-1a over every byte. Synchronous because
 * `new WebAssembly.Module(bytes)` is, and SubtleCrypto is not. Duplicated in
 * node-shims.ts (`__nimbusWasmDigest`) because that copy runs inside a facet
 * with no imports; both must compute the same value, which a unit test pins.
 */
export function wasmImageDigest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return bytes.length + ':' + hash.toString(16);
}

/** One wasm image a launch registers: where the program reads it, and its content key. */
export interface WasmImageRecord {
  /** Absolute VFS path (leading slash). */
  vfsPath: string;
  digest: string;
}
