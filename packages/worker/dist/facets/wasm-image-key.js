/**
 * wasm-image-key.ts — the content key a wasm image is registered under.
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
 * `new WebAssembly.Module(bytes)` is, and SubtleCrypto is not. Collisions
 * do not matter for correctness the way they would in a security check: the
 * set is the handful of images one launch registered, and the length is part
 * of the key. The seam computes it with this module, which imports nothing:
 * scripts/bundle-facet-workers.mjs splices it into the node shims
 * (WASM_IMAGE_KEY_PREAMBLE), so the host and the guest have one key.
 */
/** FNV-1a's offset basis: the hash of no bytes, where every key's hash starts. */
export const WASM_IMAGE_HASH_SEED = 0x811c9dc5;
/** FNV-1a continued from `hash` over `bytes`. */
export function wasmImageHash(hash, bytes) {
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}
/** The key of `length` bytes whose hash is `hash`. */
export function wasmImageKey(length, hash) {
    return length + ':' + hash.toString(16);
}
export function wasmImageDigest(bytes) {
    return wasmImageKey(bytes.length, wasmImageHash(WASM_IMAGE_HASH_SEED, bytes));
}
