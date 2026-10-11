/**
 * node-shims.ts — Nimbus v2.0 Node.js runtime shims for dynamic workers.
 *
 * Generates a raw JS string embedded in facet code. Provides:
 *   - fs: full sync/async/promises/streams VFS-backed filesystem
 *   - path: complete POSIX path operations
 *   - os/process: Linux edge environment simulation
 *   - Buffer: Uint8Array wrapper with encoding support
 *   - events: workerd's native node:events
 *   - stream: real Readable/Writable/Transform/Duplex with backpressure
 *   - crypto, zlib, tls, vm, repl, async_hooks, diagnostics_channel,
 *     inspector, string_decoder, perf_hooks: the platform's own, through the
 *     one native provider (__nativeBuiltin), with Nimbus's adapters over them
 *   - dns: real DNS resolution via Cloudflare DNS-over-HTTPS
 *   - http: virtual server with port registry for supervisor routing
 *   - https: fetch()-backed request/get
 *   - net: Socket/Server with connect/write/end
 *   - child_process: ChildProcess objects (execution requires supervisor RPC)
 *   - assert, querystring, punycode and util.inspect: Node's own modules
 *     (node-lib-source.ts) over node-lib-host.ts
 *   - util, url, string_decoder, readline, tty, timers
 *
 * VFS access: sync reads use __vfsBundle (pre-bundled by FacetManager);
 * async reads use the supervisor bridge as their source of truth whenever it
 * is available. Sync writes stay in __vfsWrites until an async observation or
 * process completion flushes them to the supervisor.
 */
/**
 * The shims reach the platform's Node builtins through one provider,
 * `__nativeBuiltin`: the host's `process.getBuiltinModule`, taken before the
 * program's process replaces the global one. What it returns in workerd
 * (probe-verified 2026-05-04 at compat date 2026-04-01, flag `nodejs_compat`):
 *   - node:crypto       — full Node 20 surface
 *   - node:tls          — connect/TLSSocket/createSecureContext/...
 *   - node:async_hooks  — AsyncLocalStorage + AsyncResource + createHook
 *   - node:diagnostics_channel — full surface incl. tracingChannel +
 *                                Channel.runStores (fastify-critical)
 *   - node:repl         — surface stub (start/REPLServer)
 *   - node:vm           — surface stub: classes/constants present BUT every
 *                         code-running method throws ERR_METHOD_NOT_IMPLEMENTED;
 *                         the vm block forwards the surface and answers eval
 *                         through the runtime-code service.
 *   - node:inspector    — Session/console/url surface present; the V8
 *                         debugger isn't attachable in workerd, so a
 *                         constructed Session's connect/post are inert.
 *   - node:zlib         — full surface: every *Sync variant, brotli/zstd,
 *                         crc32, constants, and streaming create* factories
 *                         (probe-verified 2026-08-23).
 *   - node:string_decoder, node:perf_hooks — Node's surfaces (perf_hooks'
 *                         createHistogram and monitorEventLoopDelay throw
 *                         ERR_METHOD_NOT_IMPLEMENTED).
 *   - node:url          — full surface, including the legacy parse/format/
 *                         resolve/resolveObject/Url API (v1.20260926.1).
 * A unit embedding's host (Bun) answers with its own.
 */
export declare function generateShimsCode(): string;
//# sourceMappingURL=node-shims.d.ts.map