/**
 * r2.ts — the R2 bucket a Worker is given under `nimbus wrangler dev`
 * (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
 * as `wrangler dev` gives it: Cloudflare's local store (Miniflare's R2
 * bucket), its conditionals, ranges, checksums, listing and errors.
 *
 * The session serves it (session/rpc.ts _rpcR2Call) for the Worker's binding
 * (fabric bindings.ts NimbusR2Bucket), which answers each object as its
 * fields; the Worker's env.BUCKET (fabric inner-storage-env.ts) makes the
 * platform's R2Object and R2ObjectBody of them. Backed by SqliteVFS files:
 *
 *   <root>/.nimbus/r2/<binding>/<key>          — body (raw bytes)
 *   <root>/.nimbus/r2/<binding>/<key>.meta     — sidecar JSON:
 *      { etag: string,                       // md5 hex of body
 *        version?: string,                   // random, per put
 *        size: number,
 *        uploaded: number,                   // unix ms
 *        checksums?: { md5?, sha1?, … },     // hex
 *        httpMetadata?: R2HTTPMetadata,
 *        customMetadata?: Record<string,string>,
 *        v: 1 }
 *
 * A sidecar from an older release has a sha256 etag and neither version nor
 * checksums: its etag stands for its version, and it has no checksums.
 */
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { R2Call, R2PutBody, R2WireGetOptions, R2WireGetResult, R2WireListOptions, R2WireObject, R2WireObjects, R2WirePutOptions } from '@nimbus-sh/fabric/inner-storage-env.js';
export interface R2EmulatorOptions {
    vfs: CredentialedVfs;
    root: string;
    binding: string;
}
export declare class R2Emulator {
    #private;
    private vfs;
    private dir;
    constructor(opts: R2EmulatorOptions);
    head(key: string): Promise<R2WireObject | null>;
    get(key: string, options: R2WireGetOptions): Promise<R2WireGetResult | null>;
    put(key: string, value: R2PutBody, options: R2WirePutOptions): Promise<R2WireObject | null>;
    delete(keys: string | string[]): Promise<void>;
    list(options: R2WireListOptions): Promise<R2WireObjects>;
}
/** One call of the R2 API (fabric bindings.ts NimbusR2Bucket), served by `r2`. */
export declare function serveR2Call(r2: R2Emulator, call: R2Call): Promise<R2WireObject | R2WireGetResult | R2WireObjects | null | void>;
//# sourceMappingURL=r2.d.ts.map