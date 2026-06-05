/**
 * binding-kv.ts — KV namespace emulator for nimbus-wrangler.
 *
 * Implements the Workers KV runtime API
 * (https://developers.cloudflare.com/kv/api/) backed by SqliteVFS file
 * blobs. The emulator is constructed inline by NimbusWrangler.buildInnerEnv()
 * and attached as `env.<binding>` on the inner Worker.
 *
 * Storage layout:
 *   <root>/.nimbus/kv/<binding>/<key>             — body (raw bytes)
 *   <root>/.nimbus/kv/<binding>/<key>.meta        — sidecar JSON:
 *      { exp?: number,           // unix seconds, absolute expiration
 *        meta?: any,              // user-supplied metadata
 *        v: 1 }                   // schema version
 *
 * Keys are URL-encoded so that '/' / '\\' / '\0' / '#' / etc. don't break
 * the VFS path. We then add ".meta" to derive the sidecar path.
 *
 * Concurrency: KV semantics permit eventual consistency. We do not use
 * VFS writeBatch for the body+meta pair (a torn write surfaces as a meta
 * read mismatch which we treat as no-metadata; the body still resolves).
 *
 * Test seam: `_setKvNow(() => ts)` replaces the wall clock (Date.now/1000)
 * for TTL probes. Production reads Date.now() / 1000.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
export interface KvEmulatorOptions {
    vfs: SqliteVFS | any;
    root: string;
    binding: string;
    onLog: (msg: string) => void;
}
export interface KvPutOptions {
    expiration?: number;
    expirationTtl?: number;
    metadata?: any;
}
export interface KvGetOptions {
    type?: 'text' | 'json' | 'arrayBuffer' | 'stream';
    cacheTtl?: number;
}
export interface KvListOptions {
    prefix?: string;
    limit?: number;
    cursor?: string;
}
export interface KvListResult {
    keys: {
        name: string;
        expiration?: number;
        metadata?: any;
    }[];
    list_complete: boolean;
    cursor?: string;
    cacheStatus: string | null;
}
export declare function _setKvNow(fn: () => number): void;
export declare class KvEmulator {
    private vfs;
    private dir;
    private metaCache;
    private onLog;
    constructor(opts: KvEmulatorOptions);
    get(key: string, options?: KvGetOptions | string): Promise<any>;
    getWithMetadata<T = unknown>(key: string, options?: KvGetOptions | string): Promise<{
        value: any;
        metadata: T | null;
        cacheStatus: string | null;
    }>;
    put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Uint8Array | null, options?: KvPutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: KvListOptions): Promise<KvListResult>;
    private _ensureDir;
    private _coerceBody;
    private _project;
    private _readResolved;
    private _readMeta;
    private _lazyDelete;
    private _encodeCursor;
    private _decodeCursor;
}
//# sourceMappingURL=kv.d.ts.map