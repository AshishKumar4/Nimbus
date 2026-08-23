/**
 * node-shims.ts — Nimbus v2.0 Node.js runtime shims for dynamic workers.
 *
 * Generates a raw JS string embedded in facet code. Provides:
 *   - fs: full sync/async/promises/streams VFS-backed filesystem
 *   - path: complete POSIX path operations
 *   - os/process: Linux edge environment simulation
 *   - Buffer: Uint8Array wrapper with encoding support
 *   - events: full EventEmitter
 *   - stream: real Readable/Writable/Transform/Duplex with backpressure
 *   - crypto: createHash (FNV-1a sync, SubtleCrypto async), randomBytes/UUID
 *   - zlib: forward to workerd's native node:zlib when the facet real-import
 *     block materialised (full sync/brotli/stream surface; results are the
 *     host realm's own Buffers, recognized by the widened isBuffer);
 *     CompressionStream fallback with honest sync refusal
 *   - dns: real DNS resolution via Cloudflare DNS-over-HTTPS
 *   - http: virtual server with port registry for supervisor routing
 *   - https: fetch()-backed request/get
 *   - net: Socket/Server with connect/write/end
 *   - child_process: ChildProcess objects (execution requires supervisor RPC)
 *   - assert, util, url, querystring, string_decoder, readline, tty, timers
 *
 * VFS access: sync reads use __vfsBundle (pre-bundled by FacetManager);
 * async reads use the supervisor bridge as their source of truth whenever it
 * is available. Sync writes stay in __vfsWrites until an async observation or
 * process completion flushes them to the supervisor.
 */
export declare function generateShimsCode(): string;
//# sourceMappingURL=node-shims.d.ts.map