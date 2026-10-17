/**
 * `bytes` as the ArrayBuffer a `{ wasm }` or `{ data }` member carries: their
 * own buffer when they span all of it, and only otherwise a copy of them, so
 * an image read whole for a load is never held twice.
 */
export function memberBuffer(bytes) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : bytes.slice().buffer;
}
