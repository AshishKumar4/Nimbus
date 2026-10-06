// The `node:zlib` surface Nimbus uses: the git pack code's zlib streams and
// the durable filesystem's deflated chunks (vfs/chunk-codec.ts). workerd
// provides it natively under nodejs_compat; bun and node natively. `info: true`
// returns the engine, whose bytesWritten is how many input bytes the stream
// consumed: the length of one zlib stream inside a pack, which carries no
// length of its own.
declare module 'node:zlib' {
  interface ZlibOptions {
    level?: number;
    /** Output buffer size; the result is a view of one buffer this long when the object fits. */
    chunkSize?: number;
    finishFlush?: number;
    maxOutputLength?: number;
  }
  interface ZlibEngine {
    bytesWritten: number;
  }
  export function inflateSync(data: Uint8Array, options: ZlibOptions & { info: true }): { buffer: Uint8Array; engine: ZlibEngine };
  export function inflateSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
  export function deflateSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
  export function inflateRawSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
  export function deflateRawSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
  export function crc32(data: Uint8Array, value?: number): number;
}
