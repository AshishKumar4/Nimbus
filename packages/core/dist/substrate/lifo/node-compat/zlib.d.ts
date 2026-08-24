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
export declare const gzip: ZlibAsync;
export declare const gunzip: ZlibAsync;
export declare const deflate: ZlibAsync;
export declare const inflate: ZlibAsync;
export declare const deflateRaw: ZlibAsync;
export declare const inflateRaw: ZlibAsync;
export declare const unzip: ZlibAsync;
export declare function gzipSync(buffer?: ZlibInput, options?: object): never;
export declare function gunzipSync(buffer?: ZlibInput, options?: object): never;
export declare function deflateSync(buffer?: ZlibInput, options?: object): never;
export declare function inflateSync(buffer?: ZlibInput, options?: object): never;
export declare function deflateRawSync(buffer?: ZlibInput, options?: object): never;
export declare function inflateRawSync(buffer?: ZlibInput, options?: object): never;
export declare function unzipSync(buffer?: ZlibInput, options?: object): never;
export declare const constants: {
    Z_NO_FLUSH: number;
    Z_PARTIAL_FLUSH: number;
    Z_SYNC_FLUSH: number;
    Z_FULL_FLUSH: number;
    Z_FINISH: number;
    Z_OK: number;
    Z_STREAM_END: number;
    Z_NEED_DICT: number;
    Z_ERRNO: number;
    Z_STREAM_ERROR: number;
    Z_DATA_ERROR: number;
    Z_MEM_ERROR: number;
    Z_BUF_ERROR: number;
    Z_NO_COMPRESSION: number;
    Z_BEST_SPEED: number;
    Z_BEST_COMPRESSION: number;
    Z_DEFAULT_COMPRESSION: number;
};
declare const _default: {
    gzip: ZlibAsync;
    gunzip: ZlibAsync;
    deflate: ZlibAsync;
    inflate: ZlibAsync;
    deflateRaw: ZlibAsync;
    inflateRaw: ZlibAsync;
    unzip: ZlibAsync;
    gzipSync: typeof gzipSync;
    gunzipSync: typeof gunzipSync;
    deflateSync: typeof deflateSync;
    inflateSync: typeof inflateSync;
    deflateRawSync: typeof deflateRawSync;
    inflateRawSync: typeof inflateRawSync;
    unzipSync: typeof unzipSync;
    constants: {
        Z_NO_FLUSH: number;
        Z_PARTIAL_FLUSH: number;
        Z_SYNC_FLUSH: number;
        Z_FULL_FLUSH: number;
        Z_FINISH: number;
        Z_OK: number;
        Z_STREAM_END: number;
        Z_NEED_DICT: number;
        Z_ERRNO: number;
        Z_STREAM_ERROR: number;
        Z_DATA_ERROR: number;
        Z_MEM_ERROR: number;
        Z_BUF_ERROR: number;
        Z_NO_COMPRESSION: number;
        Z_BEST_SPEED: number;
        Z_BEST_COMPRESSION: number;
        Z_DEFAULT_COMPRESSION: number;
    };
};
export default _default;
//# sourceMappingURL=zlib.d.ts.map