/**
 * supervisor-rpc.ts — WorkerEntrypoint for facet → supervisor IPC.
 *
 * Exported from index.ts. Facets receive `env.SUPERVISOR` service binding
 * pointing to this class via ctx.exports loopback binding.
 *
 * Props: { doId: string, pid: number }
 *   doId — the supervisor DO's durable object ID (for routing)
 *   pid  — the process ID (for stdout/stderr routing)
 *
 * Methods callable by facets via RPC:
 *   readFile(path) → string | null
 *   writeFile(path, content) → void
 *   stat(path) → { type, size, mtime, mode } | null
 *   readdir(path) → { name, type }[]
 *   exists(path) → boolean
 *   mkdir(path) → void
 *   unlink(path) → void
 *   fsOpen/fsRead/fsWrite/fsClose/readlink/symlink/rename/rmdir/fsRevision
 *   fsReadRange/fsWriteRange/fsTruncate (stateless ranged ops)
 *     → shared RuntimeFsBridge operations
 *   writeBatch(payload) → { inodes, chunks }  (bulk atomic write)
 *   stdout(data) → void  (pushed to WebSocket + ring buffer)
 *   stderr(data) → void
 *   reportExit(code, tail?) → void  (called from facet's finally block)
 *   prefetch(cwd, entryCode) → Record<string, string>
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import type { CacheTier, CacheKind } from '../_shared/cache-stats.js';
/**
 * Per-call cache-stat event surfaced from supervisor R2CacheClient to
 * the calling facet. Discriminated union so the facet can fold each
 * event into a structured-clone-safe wire format.
 *
 * cache-obs-2: lifted out of supervisor-rpc.ts and now part of the
 * RPC return shape (was drained-and-discarded in v1).
 */
export type SupervisorCacheStatEvent = {
    kind: 'hit';
    tier: CacheTier;
    cacheKind: CacheKind;
    bytes: number;
} | {
    kind: 'miss';
    tier: CacheTier;
    cacheKind: CacheKind;
};
export declare class SupervisorRPC extends WorkerEntrypoint {
    /**
     * Cached supervisor DO stub. WorkerEntrypoint instances live for one
     * facet invocation — caching inside the instance is correct per-facet
     * scoping with no cross-invocation leak.
     *
     * Before this cache every method (readFile, writeFile, stdout, ...)
     * called NIMBUS_SESSION.get(id) which mints a fresh RPC stub per call.
     * During npm install / git clone that multiplies to tens of thousands
     * of undisposed stubs per session, exhausting workerd's RPC queue
     * (queueState != ACTIVE fatal). See CRASH-INVESTIGATION-V2.md.
     */
    private _stubCache;
    /**
     * Get the supervisor DO stub for RPC routing.
     * Uses doId from ctx.props to find the correct NimbusSession instance.
     */
    private _getStub;
    private _call;
    readFile(path: string): Promise<string | null>;
    /**
     * Read a file as raw bytes. Used by the git network facet for binary
     * object/pack files where the text readFile would corrupt content.
     */
    readFileBytes(path: string): Promise<Uint8Array | null>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    stat(path: string): Promise<any>;
    lstat(path: string): Promise<any>;
    hasLegacySymlinkUnder(path: string): Promise<boolean>;
    utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    readdir(path: string): Promise<{
        name: string;
        type: string;
    }[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    readlink(path: string): Promise<string | null>;
    symlink(target: string, path: string): Promise<void>;
    fsRevision(path?: string): Promise<number>;
    fsOpen(path: string, flags: any): Promise<any>;
    fsRead(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
    fsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[]): Promise<number>;
    fsClose(handleId: number): Promise<void>;
    /**
     * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
     * server-side handle state, so they stay correct across supervisor
     * hibernation and never rewrite whole files for partial updates.
     */
    fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    fsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer): Promise<number>;
    fsTruncate(path: string, size: number): Promise<void>;
    /**
     * Bulk-write all inodes + chunks in ONE transactionSync on the supervisor.
     * Used by facets that buffer writes locally (git clone/fetch/pull).
     *
     * payload shape:
     *   {
     *     inodes: Array<{path, parentPath, isDir, size, mtime, mode, chunkCount}>,
     *     chunks: Array<{path, chunkId, data: Uint8Array}>,
     *     deletePaths?: string[]
     *   }
     */
    writeBatch(payload: any): Promise<{
        inodes: number;
        chunks: number;
    }>;
    /**
     * W7 — Streaming bulk-write with path-atomic, committed-prefix semantics.
     * The argument is a ReadableStream<Uint8Array> in the W7 wire-protocol
     * (see src/_shared/w7-frame.ts). Bypasses the 32 MiB structured-clone
     * cap entirely; the byte stream traverses the RPC boundary with
     * automatic flow control per Cloudflare RPC docs.
     *
     *   - Install of 5GB monorepo doesn't hit 32 MiB wall.
     *   - Peak heap reduction 48 MiB → 30 MiB on the facet side.
     *
     * The RPC frame itself does NOT pre-clone the stream — workerd
     * transfers the byte stream's underlying-source ownership to the
     * receiver. From the OOM-discriminator's perspective, payloadBytes
     * is unknown up-front (-1 sentinel); it is the supervisor's
     * decoder that observes the actual byte count.
     */
    writeBatchStream(stream: ReadableStream<Uint8Array>): Promise<WriteBatchStreamResult>;
    /**
     * Bulk-write npm registry cache entries (resolved packument metadata)
     * in ONE RPC. Used by the resolver-facet to flush a wave of resolved
     * packages back to the supervisor without per-entry round-trips.
     *
     * `entries` is an array of RegistryCacheEntry from src/npm-cache.ts:
     *   { name, version, tarballUrl, integrity, depsJson, exportsJson,
     *     main, moduleField, binJson, fetchedAt }
     *
     * Returns { written, failed } — partial writes are tolerated; cache
     * is best-effort (resolver correctness depends on the returned
     * ResolvedPackage[], not on cache hits).
     */
    putRegistryEntries(entries: any[]): Promise<{
        written: number;
        failed: number;
    }>;
    /**
     * Build a fresh R2CacheClient bound to this request's env. Cheap to
     * instantiate; does no async work. Called from each R2 RPC method to
     * avoid keeping the client in instance state (the WorkerEntrypoint
     * lifecycle is per-invocation and we want a clean closure each time).
     */
    private _r2;
    /**
     * Look up a tarball in the R2 cross-tenant cache. Returns
     * { bytes, events } where:
     *   - bytes: Uint8Array on hit, null on miss/oversize/no-binding
     *   - events: L2/L3 hit/miss tuples captured during this lookup
     *
     * cache-obs-2: return-shape change from `Uint8Array | null` to
     * `{ bytes, events }`. Facets propagate events into their result
     * for installer.ts to fold into the DO singleton (mirroring the
     * recordR2RaceCounters pattern). Without this enrichment the
     * L2/L3 distinction is supervisor-side knowledge only.
     *
     * The caller is responsible for integrity-verifying bytes before
     * unpacking — same posture as the network-fetch path. The events
     * list is structured-clone-safe (plain objects + strings + numbers).
     */
    getCachedTarball(name: string, version: string): Promise<{
        bytes: Uint8Array | null;
        events: SupervisorCacheStatEvent[];
    }>;
    /**
     * Store a tarball in the R2 cross-tenant cache. Best-effort: on R2
     * write failure, returns false but the install pipeline continues
     * unaffected. Caller passes the bytes already verified against the
     * resolver's integrity hash.
     */
    putCachedTarball(name: string, version: string, bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
    /**
     * Look up a packument in the R2 cross-tenant cache. Returns
     * { json, ageMs, expired } or null on miss / missing binding.
     *
     * Caller MUST honour the `expired` flag: only treat as a hot-path
     * hit when expired === false. Stale data is returned only for
     * stale-while-error fallback semantics.
     */
    /**
     * Look up a packument in the R2 cross-tenant cache. Returns
     * { cached, events } where:
     *   - cached: { json, ageMs, expired } on hit, null on miss/no-binding
     *   - events: L2/L3 hit/miss tuples captured during this lookup
     *
     * cache-obs-2: return-shape change from
     *   `{json, ageMs, expired} | null` to
     *   `{ cached: {json,ageMs,expired} | null, events: ... }`.
     *
     * Caller MUST honour the `cached.expired` flag the same as v1
     * (only treat as hot-path hit when expired === false). Events are
     * recorded regardless of expiration — an expired L2 hit is still
     * recorded as 'hit' at the L2 tier; the staleness is a separate axis.
     */
    getCachedPackument(name: string): Promise<{
        cached: {
            json: string;
            ageMs: number;
            expired: boolean;
        } | null;
        events: SupervisorCacheStatEvent[];
    }>;
    /**
     * Store a packument in the R2 cross-tenant cache with a TTL stamp.
     * Best-effort. Returns true on success.
     */
    putCachedPackument(name: string, json: string): Promise<boolean>;
    /**
     * Admin: purge a single tarball from R2. Used in incident response.
     */
    purgeCachedTarball(name: string, version: string): Promise<boolean>;
    /**
     * Admin: purge a single packument from R2.
     */
    purgeCachedPackument(name: string): Promise<boolean>;
    stdout(data: string): Promise<void>;
    stderr(data: string): Promise<void>;
    /**
     * Report process exit to the supervisor. Called from the facet's own
     * `finally` block after I/O has drained. The supervisor uses this to
     * stamp the log buffer and, for non-zero exits, emit a terminal dump.
     *
     * `tail` is an optional trailing stderr string — useful when the facet
     * has error state it couldn't stream in-band (rare; main path drains
     * via __pendingIO first).
     */
    reportExit(code: number, tail?: string): Promise<void>;
    prefetch(cwd: string, entryCode: string): Promise<Record<string, string>>;
    registerPort(port: number): Promise<void>;
    unregisterPort(port: number): Promise<void>;
    /**
     * Route an in-session loopback HTTP request (a facet's fetch to
     * 127.0.0.1/localhost:<port>) to the facet that owns <port> via the session
     * port registry — the same routing the shell curl/node loopback uses. Lets a
     * facet reach another facet's server in-session (e.g. `opencode attach` →
     * `opencode serve`). Returns the target's Response, streamed over RPC.
     *
     * NOT routed through `_call`: that disposes the RPC resource after mapping,
     * which would close a streaming Response body (SSE). We return the RPC promise
     * directly so the body streams to the caller for the response's lifetime —
     * exactly how PortRegistry.routeRequest returns the facet's Response as-is.
     */
    routeLoopback(port: number, request: Request): Promise<Response>;
    transform(code: string, loader: string): Promise<{
        code: string;
        map: string;
    } | null>;
    cpSpawn(req: any): Promise<{
        childPid: number;
    }>;
    cpStdinWrite(childPid: number, data: string): Promise<{
        ok: boolean;
    }>;
    cpStdinEnd(childPid: number): Promise<void>;
    cpReadStdin(childPid: number, waitMs: number): Promise<{
        data: string;
        ended: boolean;
        resize?: {
            columns: number;
            rows: number;
        };
        signal?: string;
    }>;
    cpReadOutput(childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number): Promise<{
        chunks: {
            seq: number;
            data: string;
        }[];
        closed: boolean;
        maxSeq: number;
    }>;
    cpDrainOutput(childPid: number): Promise<{
        stdout: string;
        stderr: string;
        stdoutClosed: boolean;
        stderrClosed: boolean;
    }>;
    cpKill(childPid: number, signal: string): Promise<boolean>;
    cpWait(childPid: number, waitMs: number): Promise<{
        done: boolean;
        exitCode: number | null;
        signal: string | null;
    }>;
    /**
     * child-process isolation gap #1: dispatch a single cp.spawn request inline using
     * the existing pure-builtin / facet-direct logic, returning final
     * stdout/stderr/exitCode (NOT streamed via hooks). Called from
     * spawn-facet.ts:runSpawnInIsolate inside a fresh Worker Loader
     * isolate to delegate the actual command execution back to the
     * supervisor while keeping the dispatch envelope in a fresh isolate.
     */
    cpDispatchInline(req: any, kind: string): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
}
//# sourceMappingURL=supervisor-rpc.d.ts.map