/**
 * node-shims.ts — Nimbus v2.0 Node.js runtime shims for dynamic workers.
 *
 * Generates a raw JS string embedded in facet code. Provides:
 *   - fs: full sync/async/promises/streams VFS-backed filesystem
 *   - path: complete POSIX path operations
 *   - os/process: Linux edge environment simulation
 *   - Buffer: Uint8Array wrapper with encoding support
 *   - events: workerd's native node:events
 *   - stream: the platform's node:stream; every stream here is one of its classes
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
 * VFS access: every fs call goes through the process's filesystem (core
 * runtime/wasi/resident-filesystem.ts) over the launch's store: a synchronous
 * call through its synchronous face, an asynchronous one through the
 * filesystem itself (__nimbusStartProcessFilesystem).
 */
/**
 * The shims reach the platform's Node builtins through one provider,
 * `__nativeBuiltin`: the runner's static imports of them (node-shims-imports.ts),
 * else the host's `process.getBuiltinModule`, taken before the program's
 * process replaces the global one. A unit embedding's host (Bun) answers with
 * its own.
 */
export declare function generateShimsCode(): string;
//# sourceMappingURL=node-shims.d.ts.map