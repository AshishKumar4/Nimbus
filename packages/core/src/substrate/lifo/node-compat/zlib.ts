import { Buffer } from './buffer.js';

type ZlibCallback = (err: Error | null, result?: Buffer) => void;

async function processStream(
  data: Uint8Array,
  format: CompressionFormat,
  type: 'compress' | 'decompress',
): Promise<Buffer> {
  const stream =
    type === 'compress'
      ? new CompressionStream(format)
      : new DecompressionStream(format);

  const writer = stream.writable.getWriter();
  writer.write(data as unknown as ArrayBuffer);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;
  const result = Buffer.alloc(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/**
 * Node's Unzip sniffs the wrapper itself: the gzip magic bytes mean gunzip,
 * anything else is treated as zlib-wrapped deflate.
 */
function looksLikeGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function wrapAsync(
  format: CompressionFormat | ((data: Uint8Array) => CompressionFormat),
  type: 'compress' | 'decompress',
) {
  return function (data: Uint8Array | string, optionsOrCb: unknown, cb?: ZlibCallback): void {
    const callback = typeof optionsOrCb === 'function' ? (optionsOrCb as ZlibCallback) : cb!;
    const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const raw = input instanceof Buffer ? new Uint8Array(input) : input;
    processStream(raw, typeof format === 'function' ? format(raw) : format, type)
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
export const unzip = wrapAsync((data) => (looksLikeGzip(data) ? 'gzip' : 'deflate'), 'decompress');

/**
 * The Sync surface needs a synchronous compress primitive; browser-class
 * runtimes only offer the async CompressionStream. Each Sync name refuses
 * with the working async replacement spelled out instead of failing as a
 * missing export or a vague "not supported".
 */
function syncUnavailable(name: string, asyncName: string): never {
  throw Object.assign(new Error(
    `zlib.${name}: synchronous compression is not available on this runtime. Use the async zlib.${asyncName}(data, callback) form instead.`,
  ), { code: 'ERR_ZLIB_SYNC_UNAVAILABLE' });
}

export function gzipSync(): never {
  syncUnavailable('gzipSync', 'gzip');
}
export function gunzipSync(): never {
  syncUnavailable('gunzipSync', 'gunzip');
}
export function deflateSync(): never {
  syncUnavailable('deflateSync', 'deflate');
}
export function inflateSync(): never {
  syncUnavailable('inflateSync', 'inflate');
}
export function deflateRawSync(): never {
  syncUnavailable('deflateRawSync', 'deflateRaw');
}
export function inflateRawSync(): never {
  syncUnavailable('inflateRawSync', 'inflateRaw');
}
export function unzipSync(): never {
  syncUnavailable('unzipSync', 'unzip');
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
  gzipSync, gunzipSync, deflateSync, inflateSync,
  deflateRawSync, inflateRawSync, unzipSync,
  constants,
};
