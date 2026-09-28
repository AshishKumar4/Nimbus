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
export function wasmImageDigest(bytes) {
    return bytes.length + ':' + fnv1a(0x811c9dc5, bytes).toString(16);
}
function fnv1a(seed, bytes) {
    let hash = seed;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}
/** Bytes one streamed digest step reads. */
const DIGEST_SLICE_BYTES = 1024 * 1024;
/**
 * `wasmImageDigest` of a file, read one slice at a time: the coordinator
 * digests a closure's images while the launch's module map is resident, and
 * a 15 MiB image read whole beside it was enough to reset the isolate. Null
 * when the file cannot be read.
 */
export async function streamedWasmImageDigest(fs, path) {
    const st = await Promise.resolve(fs.stat(path)).catch(() => null);
    if (!st || st.type !== 'file' || typeof st.size !== 'number')
        return null;
    let hash = 0x811c9dc5;
    for (let offset = 0; offset < st.size; offset += DIGEST_SLICE_BYTES) {
        const slice = await Promise.resolve(fs.readRange(path, offset, Math.min(DIGEST_SLICE_BYTES, st.size - offset)))
            .catch(() => null);
        if (!slice)
            return null;
        hash = fnv1a(hash, slice);
    }
    return st.size + ':' + hash.toString(16);
}
