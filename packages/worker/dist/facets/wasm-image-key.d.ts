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
export declare const WASM_IMAGE_HASH_SEED = 2166136261;
/** FNV-1a continued from `hash` over `bytes`. */
export declare function wasmImageHash(hash: number, bytes: Uint8Array): number;
/** The key of `length` bytes whose hash is `hash`. */
export declare function wasmImageKey(length: number, hash: number): string;
export declare function wasmImageDigest(bytes: Uint8Array): string;
//# sourceMappingURL=wasm-image-key.d.ts.map