import { Buffer } from './buffer.js';

type ZlibCallback = (err: Error | null, result?: Buffer) => void;

/**
 * Node's async surface: the callback is required, with options optional in
 * front of it. There is no promise return to fall back on.
 */
interface ZlibAsync {
  (data: ZlibInput, callback: ZlibCallback): void;
  (data: ZlibInput, options: object, callback: ZlibCallback): void;
}

/**
 * Everything a zlib entry point accepts: strings encode to UTF-8;
 * ArrayBuffers and every ArrayBufferView carry their own bytes.
 */
type ZlibInput = string | ArrayBufferView | ArrayBuffer;

/**
 * One funnel for every entry point. The result views the caller's exact
 * byte region — byteOffset and byteLength preserved, element values never
 * reinterpreted — so sniffing and the codec see identical bytes for a
 * Uint8Array, a Uint16Array, an offset DataView, or a bare ArrayBuffer.
 */
function toBytes(data: ZlibInput): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * Node splits decompression failures two ways, and the engine's own failure
 * is the only thing that can tell them apart: an input that ran out is
 * Z_BUF_ERROR / errno -5, while everything else — bad header, bad block, and
 * a checksum or length trailer that can only fail once the member is
 * complete — is Z_DATA_ERROR / errno -3 carrying the engine's message. Which
 * side of a write or a close the failure lands on says nothing about that,
 * so it is not consulted.
 */
function isUnexpectedEnd(cause: unknown): boolean {
  const message = cause instanceof Error && typeof cause.message === 'string' ? cause.message : String(cause);
  return /unexpected end|end of (?:file|input|stream)|premature|truncated|\bEOF\b/i.test(message);
}

function zDataError(cause: unknown): Error {
  const message = cause instanceof Error && cause.message ? cause.message : String(cause);
  return Object.assign(new Error(message), { code: 'Z_DATA_ERROR', errno: -3, cause });
}

function zBufError(cause: unknown): Error {
  return Object.assign(new Error('unexpected end of file'), {
    code: 'Z_BUF_ERROR',
    errno: -5,
    cause,
  });
}

/**
 * Node throws this synchronously rather than deferring a callback that does
 * not exist.
 */
function invalidCallback(value: unknown): TypeError {
  const received =
    value === undefined ? 'undefined'
    : value === null ? 'null'
    : typeof value === 'object' ? `an instance of ${value.constructor?.name ?? 'Object'}`
    : `type ${typeof value} (${String(value)})`;
  return Object.assign(
    new TypeError(`The "callback" argument must be of type function. Received ${received}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

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
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  // Feeding and draining run together: a single write large enough to fill
  // the codec's output queue only completes while somebody reads. Both sides
  // are contained so neither rejection surfaces unhandled, and the first
  // failure is the one reported.
  const failures: unknown[] = [];
  const record = (reason: unknown): void => {
    if (failures.length === 0) failures.push(reason);
  };
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value);
    }
  })().catch(record);
  const feed = (async () => {
    await writer.write(data);
    await writer.close();
  })().catch(record);
  await Promise.all([drain, feed]);

  if (failures.length > 0) {
    const reason = failures[0];
    if (type === 'decompress') {
      throw isUnexpectedEnd(reason) ? zBufError(reason) : zDataError(reason);
    }
    throw reason instanceof Error ? reason : new Error(String(reason));
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
): ZlibAsync {
  return function (data: ZlibInput, optionsOrCb: object | ZlibCallback, cb?: ZlibCallback): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    if (typeof callback !== 'function') throw invalidCallback(callback);
    const bytes = toBytes(data);
    // Two arms, not .then().catch(): a callback that throws on success must
    // not be handed its own exception as a second, failed invocation.
    processStream(bytes, typeof format === 'function' ? format(bytes) : format, type).then(
      (result) => callback(null, result),
      (err) => callback(err instanceof Error ? err : new Error(String(err))),
    );
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

export function gzipSync(buffer?: ZlibInput, options?: object): never {
  syncUnavailable('gzipSync', 'gzip');
}
export function gunzipSync(buffer?: ZlibInput, options?: object): never {
  syncUnavailable('gunzipSync', 'gunzip');
}
export function deflateSync(buffer?: ZlibInput, options?: object): never {
  syncUnavailable('deflateSync', 'deflate');
}
export function inflateSync(buffer?: ZlibInput, options?: object): never {
  syncUnavailable('inflateSync', 'inflate');
}
export function deflateRawSync(buffer?: ZlibInput, options?: object): never {
  syncUnavailable('deflateRawSync', 'deflateRaw');
}
export function inflateRawSync(buffer?: ZlibInput, options?: object): never {
  syncUnavailable('inflateRawSync', 'inflateRaw');
}
export function unzipSync(buffer?: ZlibInput, options?: object): never {
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
