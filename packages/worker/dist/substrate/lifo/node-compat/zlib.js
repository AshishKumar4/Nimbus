import { Buffer } from './buffer.js';
async function processStream(data, format, type) {
    const stream = type === 'compress'
        ? new CompressionStream(format)
        : new DecompressionStream(format);
    const writer = stream.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = stream.readable.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
    }
    let totalLength = 0;
    for (const c of chunks)
        totalLength += c.length;
    const result = Buffer.alloc(totalLength);
    let offset = 0;
    for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
    }
    return result;
}
function wrapAsync(format, type) {
    return function (data, optionsOrCb, cb) {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const raw = input instanceof Buffer ? new Uint8Array(input) : input;
        processStream(raw, format, type)
            .then((result) => callback(null, result))
            .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
    };
}
export const gzip = wrapAsync('gzip', 'compress');
export const gunzip = wrapAsync('gzip', 'decompress');
export const deflate = wrapAsync('deflate', 'compress');
export const inflate = wrapAsync('deflate', 'decompress');
export const deflateRaw = wrapAsync('deflate-raw', 'compress');
export const inflateRaw = wrapAsync('deflate-raw', 'decompress');
export const unzip = wrapAsync('gzip', 'decompress');
// Sync variants are not supported in the browser
export function gzipSync() {
    throw new Error('zlib sync operations are not supported in Lifo');
}
export function gunzipSync() {
    throw new Error('zlib sync operations are not supported in Lifo');
}
export function deflateSync() {
    throw new Error('zlib sync operations are not supported in Lifo');
}
export function inflateSync() {
    throw new Error('zlib sync operations are not supported in Lifo');
}
export const constants = {
    Z_NO_FLUSH: 0,
    Z_PARTIAL_FLUSH: 1,
    Z_SYNC_FLUSH: 2,
    Z_FULL_FLUSH: 3,
    Z_FINISH: 4,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_NO_COMPRESSION: 0,
    Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9,
    Z_DEFAULT_COMPRESSION: -1,
};
export default {
    gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip,
    gzipSync, gunzipSync, deflateSync, inflateSync, constants,
};
