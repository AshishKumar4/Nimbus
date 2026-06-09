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
// W5: OOM discriminator — record last-known RPC frame on writeBatch entry
import { setLastRpcFrame } from '../observability/oom-discriminator.js';
// Phase 2 A'.2 — supervisor in-flight RPC payload byte tracking.
import { rpcPayloadStart, rpcPayloadEnd } from '../observability/diag-counters.js';
// W4: R2 cross-tenant npm cache (tarballs + packuments)
import { R2CacheClient, MAX_R2_TARBALL_BYTES } from '../npm/r2-cache.js';
import { r2TarballHit, r2TarballMiss, r2PackumentHit, r2PackumentMiss, r2TarballPutOk, r2TarballPutFail, r2PackumentPutOk, r2PackumentPutFail, } from '../observability/diag-counters.js';
import { useRpcResource } from '../_shared/rpc-dispose.js';
/**
 * Drain the per-call event list captured by R2CacheClient during this
 * SupervisorRPC call.
 *
 * cache-obs-2 (the v2 fold-side flip):
 *   We RETURN the drained events to the facet so they propagate via
 *   the install-batch-facet result -> installer.ts fold -> DO
 *   singleton path. No recursion (return-value flow, not subrequest).
 *
 * The R2CacheClient instance lives only for the duration of one RPC
 * call (constructed fresh in _r2()). Draining its event list at the
 * end of the call is the natural lifecycle boundary.
 */
function _drainCacheEvents(client) {
    const drained = (client && Array.isArray(client._cacheEvents)) ? client._cacheEvents : [];
    if (client && Array.isArray(client._cacheEvents))
        client._cacheEvents = [];
    return drained;
}
/**
 * W5 Lever 5: estimate the byte-cost of a writeBatch payload so the
 * /api/_diag/memory.rpc.lastFrame.payloadBytes field is meaningful.
 * Counts chunk data bytes + per-inode header overhead. Fast (no copy).
 */
function _estimateWriteBatchBytes(payload) {
    if (!payload)
        return 0;
    let n = 0;
    const chunks = payload.chunks ?? [];
    for (const c of chunks) {
        n += (c?.data?.length ?? c?.data?.byteLength ?? 0);
    }
    const inodes = payload.inodes ?? [];
    for (const i of inodes)
        n += 80 + (i?.path?.length ?? 0);
    return n;
}
export class SupervisorRPC extends WorkerEntrypoint {
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
    _stubCache = null;
    /**
     * Get the supervisor DO stub for RPC routing.
     * Uses doId from ctx.props to find the correct NimbusSession instance.
     */
    _getStub() {
        if (this._stubCache)
            return this._stubCache;
        const doId = this.ctx.props?.doId;
        if (!doId)
            throw new Error('SupervisorRPC: missing doId in props');
        const id = this.env.NIMBUS_SESSION.idFromString(doId);
        this._stubCache = this.env.NIMBUS_SESSION.get(id);
        return this._stubCache;
    }
    _call(promise) {
        return useRpcResource(promise, (value) => value);
    }
    // ── Filesystem RPC ────────────────────────────────────────────────────
    async readFile(path) {
        return this._call(this._getStub()._rpcReadFile(path));
    }
    /**
     * Read a file as raw bytes. Used by the git network facet for binary
     * object/pack files where the text readFile would corrupt content.
     */
    async readFileBytes(path) {
        return this._call(this._getStub()._rpcReadFileBytes(path));
    }
    async writeFile(path, content) {
        // binary-fs wave: accept Uint8Array natively. Pre-fix this RPC was
        // string-only, which forced node-shims.ts:writeFileSync to UTF-8-
        // decode every Uint8Array write — mangling bytes ≥ 0x80 to U+FFFD
        // and corrupting binary content. RPC structured-clone handles
        // Uint8Array transparently; downstream _rpcWriteFile also accepts
        return this._call(this._getStub()._rpcWriteFile(path, content));
    }
    async stat(path) {
        return this._call(this._getStub()._rpcStat(path));
    }
    async utimes(path, atimeMs, mtimeMs) {
        return this._call(this._getStub()._rpcUtimes(path, atimeMs, mtimeMs));
    }
    async readdir(path) {
        return this._call(this._getStub()._rpcReaddir(path));
    }
    async exists(path) {
        return this._call(this._getStub()._rpcExists(path));
    }
    async mkdir(path) {
        return this._call(this._getStub()._rpcMkdir(path));
    }
    async rmdir(path) {
        return this._call(this._getStub()._rpcRmdir(path));
    }
    async rename(from, to) {
        return this._call(this._getStub()._rpcRename(from, to));
    }
    async unlink(path) {
        return this._call(this._getStub()._rpcUnlink(path));
    }
    async readlink(path) {
        return this._call(this._getStub()._rpcReadlink(path));
    }
    async symlink(target, path) {
        return this._call(this._getStub()._rpcSymlink(target, path));
    }
    async fsRevision(path) {
        return this._call(this._getStub()._rpcFsRevision(path));
    }
    async fsOpen(path, flags) {
        return this._call(this._getStub()._rpcFsOpen(path, flags));
    }
    async fsRead(handleId, offset, length) {
        return this._call(this._getStub()._rpcFsRead(handleId, offset, length));
    }
    async fsWrite(handleId, offset, bytes) {
        return this._call(this._getStub()._rpcFsWrite(handleId, offset, bytes));
    }
    async fsClose(handleId) {
        return this._call(this._getStub()._rpcFsClose(handleId));
    }
    /**
     * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
     * server-side handle state, so they stay correct across supervisor
     * hibernation and never rewrite whole files for partial updates.
     */
    async fsReadRange(path, offset, length) {
        return this._call(this._getStub()._rpcFsReadRange(path, offset, length));
    }
    async fsWriteRange(path, offset, bytes) {
        return this._call(this._getStub()._rpcFsWriteRange(path, offset, bytes));
    }
    async fsTruncate(path, size) {
        return this._call(this._getStub()._rpcFsTruncate(path, size));
    }
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
    async writeBatch(payload) {
        // W5 Lever 5: record the frame on entry so /api/_diag/memory has
        // last-known-RPC context if the supervisor crashes mid-RPC.
        // Phase 2 A'.2: bump the in-flight RPC payload counter so the
        // supervisor's heap estimate accounts for the bytes claimed by
        // this RPC for the duration of the await.
        const payloadBytes = _estimateWriteBatchBytes(payload);
        setLastRpcFrame('writeBatch', payloadBytes);
        rpcPayloadStart(payloadBytes);
        try {
            return await this._call(this._getStub()._rpcWriteBatch(payload));
        }
        finally {
            rpcPayloadEnd(payloadBytes);
        }
    }
    /**
     * W7 — Streaming bulk-write. Same semantics as writeBatch() but the
     * argument is a ReadableStream<Uint8Array> in the W7 wire-protocol
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
    async writeBatchStream(stream) {
        // The streaming bytes flow with backpressure (W7_HIGHWATER_BYTES =
        // 256 KiB per active encoder per src/_shared/w7-frame.ts:53). The
        // supervisor-resident bound is the queue highwater, NOT the total
        // payload — the LastRpcFrame surfaces -1 to mark "stream"; the
        // RPC payload counter sees the bounded chunk-size estimate.
        const STREAM_RESIDENT_BYTES = 256 * 1024;
        setLastRpcFrame('writeBatchStream', -1);
        rpcPayloadStart(STREAM_RESIDENT_BYTES);
        try {
            return await this._call(this._getStub()._rpcWriteBatchStream(stream));
        }
        finally {
            rpcPayloadEnd(STREAM_RESIDENT_BYTES);
        }
    }
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
    async putRegistryEntries(entries) {
        // Phase 2 A'.2: track the inbound array's resident byte cost.
        // Each registry entry is ~500 B (deps + integrity + tarballUrl);
        // a wave of 100 entries is ~50 KiB. Bounded; counted in
        // streamingBuffersBytes for visibility.
        const REGISTRY_ENTRY_BYTES = 512;
        const payloadBytes = (Array.isArray(entries) ? entries.length : 0) * REGISTRY_ENTRY_BYTES;
        rpcPayloadStart(payloadBytes);
        try {
            return await this._call(this._getStub()._rpcPutRegistryEntries(entries));
        }
        finally {
            rpcPayloadEnd(payloadBytes);
        }
    }
    // ── R2-backed npm cache RPC [W4] ─────────────────────────────────────
    //
    // The R2 buckets are bindings on the SUPERVISOR worker (not the
    // facet). The facet only sees what we hang on its `env: { SUPERVISOR }`
    // injection (see src/facet-manager.ts:892 and similar). To expose R2
    // to the facet without pinning a binding stub through the LOADER, we
    // proxy reads/writes through these RPC methods.
    //
    // Counter increments live HERE (supervisor isolate, where diag-counters
    // is module-scoped). The facet itself never sees the counter module.
    //
    // Graceful-degrade: if NPM_TARBALL_CACHE / NPM_PACKUMENT_CACHE bindings
    // aren't configured (deploy without R2 buckets, or local dev), the
    // R2CacheClient falls through to null returns / no-op writes; the
    // facet sees null and uses its existing network-fetch path. No errors,
    /**
     * Build a fresh R2CacheClient bound to this request's env. Cheap to
     * instantiate; does no async work. Called from each R2 RPC method to
     * avoid keeping the client in instance state (the WorkerEntrypoint
     * lifecycle is per-invocation and we want a clean closure each time).
     */
    _r2() {
        const tar = this.env?.NPM_TARBALL_CACHE ?? null;
        const pkm = this.env?.NPM_PACKUMENT_CACHE ?? null;
        return new R2CacheClient(tar, pkm);
    }
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
    async getCachedTarball(name, version) {
        const r2 = this._r2();
        const bytes = await r2.getTarball(name, version);
        const events = _drainCacheEvents(r2);
        if (bytes && bytes.length > 0 && bytes.length <= MAX_R2_TARBALL_BYTES) {
            r2TarballHit();
            return { bytes, events };
        }
        r2TarballMiss();
        return { bytes: null, events };
    }
    /**
     * Store a tarball in the R2 cross-tenant cache. Best-effort: on R2
     * write failure, returns false but the install pipeline continues
     * unaffected. Caller passes the bytes already verified against the
     * resolver's integrity hash.
     */
    async putCachedTarball(name, version, bytes) {
        // L4 hits are captured FACET-SIDE in cache-obs-2 — the facet did
        // the registry fetch, so it can push the L4 event directly into
        // its own cacheStatEvents list before calling putCachedTarball.
        // This RPC remains a one-way write (returns bool); the L4 event
        // does NOT flow through this return path.
        const r2 = this._r2();
        const ok = await r2.putTarball(name, version, bytes);
        if (ok)
            r2TarballPutOk();
        else
            r2TarballPutFail();
        return ok;
    }
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
    async getCachedPackument(name) {
        const r2 = this._r2();
        const cached = await r2.getPackument(name);
        const events = _drainCacheEvents(r2);
        if (cached && !cached.expired) {
            r2PackumentHit();
            return { cached, events };
        }
        if (cached && cached.expired) {
            // Treat expired as a miss for hit-rate accounting; still return
            // the data so callers can use it for stale-while-error.
            r2PackumentMiss();
            return { cached, events };
        }
        r2PackumentMiss();
        return { cached: null, events };
    }
    /**
     * Store a packument in the R2 cross-tenant cache with a TTL stamp.
     * Best-effort. Returns true on success.
     */
    async putCachedPackument(name, json) {
        // L4 hit captured facet-side (the facet did the registry fetch).
        // This RPC is one-way write.
        const r2 = this._r2();
        const ok = await r2.putPackument(name, json);
        if (ok)
            r2PackumentPutOk();
        else
            r2PackumentPutFail();
        return ok;
    }
    /**
     * Admin: purge a single tarball from R2. Used in incident response.
     */
    async purgeCachedTarball(name, version) {
        const r2 = this._r2();
        return r2.deleteTarball(name, version);
    }
    /**
     * Admin: purge a single packument from R2.
     */
    async purgeCachedPackument(name) {
        const r2 = this._r2();
        return r2.deletePackument(name);
    }
    // ── Process I/O ───────────────────────────────────────────────────────
    async stdout(data) {
        return this._call(this._getStub()._rpcStdout(this.ctx.props?.pid || 0, data));
    }
    async stderr(data) {
        return this._call(this._getStub()._rpcStderr(this.ctx.props?.pid || 0, data));
    }
    /**
     * Report process exit to the supervisor. Called from the facet's own
     * `finally` block after I/O has drained. The supervisor uses this to
     * stamp the log buffer and, for non-zero exits, emit a terminal dump.
     *
     * `tail` is an optional trailing stderr string — useful when the facet
     * has error state it couldn't stream in-band (rare; main path drains
     * via __pendingIO first).
     */
    async reportExit(code, tail) {
        const pid = this.ctx.props?.pid || 0;
        return this._call(this._getStub()._rpcReportExit(pid, code, tail || ''));
    }
    // ── Prefetch ──────────────────────────────────────────────────────────
    async prefetch(cwd, entryCode) {
        return this._call(this._getStub()._rpcPrefetch(cwd, entryCode));
    }
    // ── Port registration ─────────────────────────────────────────────────
    async registerPort(port) {
        return this._call(this._getStub()._rpcRegisterPort(this.ctx.props?.pid || 0, port));
    }
    async unregisterPort(port) {
        return this._call(this._getStub()._rpcUnregisterPort(port));
    }
    // ── Esbuild transform ─────────────────────────────────────────────────
    async transform(code, loader) {
        return this._call(this._getStub()._rpcTransform(code, loader));
    }
    // ── child_process [W8 Phase 1] ────────────────────────────────────────
    //
    // The parent facet's `child_process.spawn` shim (node-shims.ts) calls
    // these methods. They delegate to NimbusSession._rpcCp* methods which
    // route through the shared FacetProcessManager.
    //
    async cpSpawn(req) {
        return this._call(this._getStub()._rpcCpSpawn(req));
    }
    async cpStdinWrite(childPid, data) {
        return this._call(this._getStub()._rpcCpStdinWrite(childPid, data));
    }
    async cpStdinEnd(childPid) {
        return this._call(this._getStub()._rpcCpStdinEnd(childPid));
    }
    async cpReadStdin(childPid, waitMs) {
        return this._call(this._getStub()._rpcCpReadStdin(childPid, waitMs));
    }
    async cpReadOutput(childPid, fd, sinceSeq, waitMs) {
        return this._call(this._getStub()._rpcCpReadOutput(childPid, fd, sinceSeq, waitMs));
    }
    async cpDrainOutput(childPid) {
        return this._call(this._getStub()._rpcCpDrainOutput(childPid));
    }
    async cpKill(childPid, signal) {
        return this._call(this._getStub()._rpcCpKill(childPid, signal));
    }
    async cpWait(childPid, waitMs) {
        return this._call(this._getStub()._rpcCpWait(childPid, waitMs));
    }
    /**
     * child-process isolation gap #1: dispatch a single cp.spawn request inline using
     * the existing pure-builtin / facet-direct logic, returning final
     * stdout/stderr/exitCode (NOT streamed via hooks). Called from
     * spawn-facet.ts:runSpawnInIsolate inside a fresh Worker Loader
     * isolate to delegate the actual command execution back to the
     * supervisor while keeping the dispatch envelope in a fresh isolate.
     */
    async cpDispatchInline(req, kind) {
        return this._call(this._getStub()._rpcCpDispatchInline(req, kind));
    }
}
