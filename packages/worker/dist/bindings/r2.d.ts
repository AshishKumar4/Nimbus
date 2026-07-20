/**
 * binding-r2.ts — R2 bucket emulator for nimbus-wrangler.
 *
 * Implements the Workers R2 runtime API
 * (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
 * backed by SqliteVFS file blobs. Mirrors KV's storage layout:
 *
 *   <root>/.nimbus/r2/<binding>/<key>          — body (raw bytes)
 *   <root>/.nimbus/r2/<binding>/<key>.meta     — sidecar JSON:
 *      { etag: string,                       // sha256 hex of body
 *        size: number,
 *        uploaded: number,                    // unix ms
 *        httpMetadata?: R2HTTPMetadata,
 *        customMetadata?: Record<string,string>,
 *        v: 1 }
 *
 * Out of scope for W10 (W10.5 candidates):
 *   - Multipart uploads (createMultipartUpload / resumeMultipartUpload
 *     throw "not supported" errors with a clear message)
 *   - Server-side checksums (md5/sha1/sha256/sha512 verifies passed via
 *     `options` are honored only loosely — we compute sha256 ourselves
 *     and compare; mismatched verify hashes cause put() to throw)
 *
 * Range reads return bodies sliced from the in-memory Uint8Array.
 *
 * The `R2ObjectBody` returned by get() carries a fresh ReadableStream on
 * every call (the body is one-shot per real-R2 contract), plus convenience
 * helpers text() / arrayBuffer() / json() / blob().
 */
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
export interface R2HTTPMetadata {
    contentType?: string;
    contentLanguage?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheControl?: string;
    cacheExpiry?: Date;
}
export interface R2Conditional {
    etagMatches?: string;
    etagDoesNotMatch?: string;
    uploadedBefore?: Date;
    uploadedAfter?: Date;
}
export interface R2Range {
    offset?: number;
    length?: number;
    suffix?: number;
}
export interface R2PutOptions {
    httpMetadata?: R2HTTPMetadata;
    customMetadata?: Record<string, string>;
    md5?: string | ArrayBuffer;
    sha1?: string | ArrayBuffer;
    sha256?: string | ArrayBuffer;
    sha512?: string | ArrayBuffer;
    onlyIf?: R2Conditional;
}
export interface R2GetOptions {
    onlyIf?: R2Conditional;
    range?: R2Range;
}
export interface R2ListOptions {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
    include?: ('httpMetadata' | 'customMetadata')[];
}
export interface R2EmulatorOptions {
    vfs: CredentialedVfs;
    root: string;
    binding: string;
    onLog?: (msg: string) => void;
}
interface R2Sidecar {
    etag: string;
    size: number;
    uploaded: number;
    httpMetadata?: R2HTTPMetadata;
    customMetadata?: Record<string, string>;
    v: 1;
}
export declare class R2Object {
    key: string;
    version: string;
    size: number;
    etag: string;
    httpEtag: string;
    uploaded: Date;
    httpMetadata: R2HTTPMetadata;
    customMetadata: Record<string, string>;
    constructor(key: string, side: R2Sidecar);
}
export declare class R2ObjectBody extends R2Object {
    /** @internal */
    private _body;
    constructor(key: string, side: R2Sidecar, body: Uint8Array);
    get body(): ReadableStream<Uint8Array>;
    get bodyUsed(): boolean;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    json<T = any>(): Promise<T>;
    blob(): Promise<Blob>;
}
export declare class R2Emulator {
    private vfs;
    private dir;
    private onLog;
    constructor(opts: R2EmulatorOptions);
    head(key: string): Promise<R2Object | null>;
    get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
    put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | Uint8Array | string | null, options?: R2PutOptions): Promise<R2Object | null>;
    delete(keys: string | string[]): Promise<void>;
    list(options?: R2ListOptions): Promise<{
        objects: R2Object[];
        truncated: boolean;
        cursor?: string;
        delimitedPrefixes: string[];
    }>;
    createMultipartUpload(_key: string, _options?: any): Promise<never>;
    resumeMultipartUpload(_key: string, _uploadId: string): Promise<never>;
    private _ensureDir;
    private _coerceBody;
    private _readSide;
    private _readSideEnc;
    private _readBody;
    private _evalConditional;
    private _normalizeEtag;
    private _applyRange;
    private _sha256Hex;
    private _normalizeHash;
    private _encodeCursor;
    private _decodeCursor;
}
export {};
//# sourceMappingURL=r2.d.ts.map