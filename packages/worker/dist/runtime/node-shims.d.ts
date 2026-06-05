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
 *   - zlib: real gzip/gunzip/deflate via CompressionStream/DecompressionStream
 *   - dns: real DNS resolution via Cloudflare DNS-over-HTTPS
 *   - http: virtual server with port registry for supervisor routing
 *   - https: fetch()-backed request/get
 *   - net: Socket/Server with connect/write/end
 *   - child_process: ChildProcess objects (execution requires supervisor RPC)
 *   - assert, util, url, querystring, string_decoder, readline, tty, timers
 *
 * VFS access: reads from __vfsBundle (pre-bundled by FacetManager),
 * writes to __vfsWrites (flushed back to VFS on completion).
 */
export declare function generateShimsCode(): string;
//# sourceMappingURL=node-shims.d.ts.map