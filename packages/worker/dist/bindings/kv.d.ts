/**
 * kv.ts — the KV namespace a Worker is given under `nimbus wrangler dev`
 * (https://developers.cloudflare.com/kv/api/), as `wrangler dev` gives it:
 * workerd's KV client (kv.c++) over Cloudflare's local store (Miniflare's
 * KV namespace), each checking and answering as they do.
 *
 * The session serves it (session/rpc.ts _rpcKvCall) for the Worker's binding
 * (fabric bindings.ts NimbusKVNamespace), backed by SqliteVFS files:
 *
 *   <root>/.nimbus/kv/<binding>/<key>             — body (raw bytes)
 *   <root>/.nimbus/kv/<binding>/<key>.meta        — sidecar JSON:
 *      { exp?: number,           // unix seconds, absolute expiration
 *        meta?: <JSON>,           // user-supplied metadata
 *        v: 1 }                   // schema version
 *
 * A value is streamed to its file as it arrives, and one past KV's 25 MiB
 * is refused as it passes it, its stream cancelled; it is written beside
 * the key's file and replaces it once whole, so a refused put leaves the
 * value it would have replaced.
 *
 * Test seam: `_setKvNow(() => ts)` replaces the wall clock (Date.now/1000)
 * for TTL probes. Production reads Date.now() / 1000.
 */
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { KvCall, KvGetOptions, KvJson, KvListOptions, KvPutOptions } from '@nimbus-sh/fabric/inner-storage-env.js';
export interface KvEmulatorOptions {
    vfs: CredentialedVfs;
    root: string;
    binding: string;
}
/** A value as get answers it, by its type. */
export type KvValue = string | KvJson | ArrayBuffer | ReadableStream<Uint8Array> | null;
export interface KvListKey {
    name: string;
    expiration?: number;
    metadata?: KvJson;
}
export interface KvListResult {
    keys: KvListKey[];
    list_complete: boolean;
    cursor?: string;
    cacheStatus: null;
}
export declare function _setKvNow(fn: () => number): void;
export declare class KvEmulator {
    #private;
    private vfs;
    private dir;
    constructor(opts: KvEmulatorOptions);
    get(key: string | string[], options?: string | KvGetOptions): Promise<KvValue | Map<string, KvJson>>;
    getWithMetadata(key: string | string[], options?: string | KvGetOptions): Promise<{
        value: KvValue;
        metadata: KvJson;
        cacheStatus: null;
    } | Map<string, KvJson>>;
    put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KvPutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: KvListOptions): Promise<KvListResult>;
}
/** One call of the KV API (fabric bindings.ts NimbusKVNamespace), served by `kv`. */
export declare function serveKvCall(kv: KvEmulator, call: KvCall): Promise<KvValue | Map<string, KvJson> | {
    value: KvValue;
    metadata: KvJson;
    cacheStatus: null;
} | KvListResult | void>;
//# sourceMappingURL=kv.d.ts.map