/**
 * supervisor-rpc.ts — WorkerEntrypoint for facet → supervisor IPC.
 *
 * Exported from index.ts. Facets receive `env.SUPERVISOR` service binding
 * pointing to this class via ctx.exports loopback binding.
 *
 * Props: { doId: string, pid: number, writerId: string }
 *   doId — the supervisor DO's durable object ID (for routing)
 *   pid  — the process ID (for stdout/stderr routing)
 *   writerId — the active append-writer incarnation for this process
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
 *   fsReadRange/fsWriteRange/fsAppend/fsAppendAck/fsTruncate
 *     → shared RuntimeFsBridge operations
 *   fsReadBatch(requests) → per-range results  (many reads, one round trip)
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
import type { PackumentReadThrough } from '../npm/r2-cache.js';
import { useRpcResource } from '../_shared/rpc-dispose.js';
import type { VfsAcquireResult } from '../runtime/os-contracts.js';
import type { WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import type { FsReadBatchEntry, FsReadBatchRequest } from './rpc.js';
import { W7_MAX_RECORD_BYTES } from '../_shared/w7-frame.js';
// cache metrics support: per-tier hit/miss counters.
//
// CRITICAL — SupervisorRPC is a WorkerEntrypoint (loopback service
// binding). It runs in a SEPARATE isolate from the DO it services, so
// bumping a module-scoped singleton here does NOT update the DO's
// /api/_diag/cache surface. We accumulate per-RPC and forward the
// batch back to the DO via _rpcRecordCacheStats at the end of each
// handler. Same pattern as recordR2RaceCounters / install-batch-facet.
import type { CacheTier, CacheKind } from '../_shared/cache-stats.js';

/**
 * Per-call cache-stat event surfaced from supervisor R2CacheClient to
 * the calling facet. Discriminated union so the facet can fold each
 * event into a structured-clone-safe wire format.
 *
 * cache-obs-2: lifted out of supervisor-rpc.ts and now part of the
 * RPC return shape (was drained-and-discarded in v1).
 */
export type SupervisorCacheStatEvent =
  | { kind: 'hit'; tier: CacheTier; cacheKind: CacheKind; bytes: number }
  | { kind: 'miss'; tier: CacheTier; cacheKind: CacheKind };

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
function _drainCacheEvents(client: any): SupervisorCacheStatEvent[] {
  const drained = (client && Array.isArray(client._cacheEvents)) ? client._cacheEvents : [];
  if (client && Array.isArray(client._cacheEvents)) client._cacheEvents = [];
  return drained;
}

/**
 * W5 Lever 5: estimate the byte-cost of a writeBatch payload so the
 * /api/_diag/memory.rpc.lastFrame.payloadBytes field is meaningful.
 * Counts chunk data bytes + per-inode header overhead. Fast (no copy).
 */
function _estimateWriteBatchBytes(payload: any): number {
  if (!payload) return 0;
  let n = 0;
  const chunks = payload.chunks ?? [];
  for (const c of chunks) {
    n += (c?.data?.length ?? c?.data?.byteLength ?? 0);
  }
  const inodes = payload.inodes ?? [];
  for (const i of inodes) n += 80 + (i?.path?.length ?? 0);
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
  private _stubCache: any = null;

  /**
   * Get the supervisor DO stub for RPC routing.
   * Uses doId from ctx.props to find the correct NimbusSession instance.
   */
  private _getStub(): any {
    if (this._stubCache) return this._stubCache;
    const doId = (this.ctx as any).props?.doId;
    if (!doId) throw new Error('SupervisorRPC: missing doId in props');
    const id = (this.env as any).NIMBUS_SESSION.idFromString(doId);
    this._stubCache = (this.env as any).NIMBUS_SESSION.get(id);
    return this._stubCache;
  }

  private _call<T>(promise: Promise<T>): Promise<T> {
    return useRpcResource(promise, (value) => value);
  }

  private _pid(): number {
    const pid = (this.ctx as any).props?.pid;
    if (!Number.isInteger(pid) || typeof pid !== 'number' || pid <= 0) {
      throw new Error('SupervisorRPC: missing or invalid process pid in props');
    }
    return pid;
  }

  private _writerId(): string {
    const writerId = (this.ctx as any).props?.writerId;
    if (typeof writerId !== 'string' || writerId.length === 0) {
      throw new Error('SupervisorRPC: missing VFS writer incarnation');
    }
    return writerId;
  }

  // ── Filesystem RPC ────────────────────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    return this._call(this._getStub()._rpcReadFile(path, this._pid()));
  }

  /**
   * Read a file as raw bytes. Used by the git network facet for binary
   * object/pack files where the text readFile would corrupt content.
   */
  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this._call(this._getStub()._rpcReadFileBytes(path, this._pid()));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<number> {
    // binary-fs wave: accept Uint8Array natively. Pre-fix this RPC was
    // string-only, which forced node-shims.ts:writeFileSync to UTF-8-
    // decode every Uint8Array write — mangling bytes ≥ 0x80 to U+FFFD
    // and corrupting binary content. RPC structured-clone handles
    // Uint8Array transparently; downstream _rpcWriteFile also accepts
    return this._call(this._getStub()._rpcWriteFile(path, content, this._pid()));
  }

  async stat(path: string): Promise<any> {
    return this._call(this._getStub()._rpcStat(path, this._pid()));
  }

  async lstat(path: string): Promise<any> {
    return this._call(this._getStub()._rpcLstat(path, this._pid()));
  }

  async hasLegacySymlinkUnder(path: string): Promise<boolean> {
    return this._call(this._getStub()._rpcHasLegacySymlinkUnder(path, this._pid()));
  }

  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    return this._call(this._getStub()._rpcUtimes(path, atimeMs, mtimeMs, this._pid()));
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this._call(this._getStub()._rpcChmod(path, mode, this._pid()));
  }

  async access(path: string, mode: number): Promise<void> {
    return this._call(this._getStub()._rpcAccess(path, mode, this._pid()));
  }

  async chown(
    path: string,
    uid: number,
    gid: number,
    options?: { followSymlinks?: boolean },
  ): Promise<void> {
    return this._call(this._getStub()._rpcChown(path, uid, gid, this._pid(), options));
  }

  async setUmask(mask: number): Promise<number> {
    return this._call(this._getStub()._rpcSetUmask(mask, this._pid()));
  }

  async readdir(path: string): Promise<{ name: string; type: string }[]> {
    return this._call(this._getStub()._rpcReaddir(path, this._pid()));
  }

  async exists(path: string): Promise<boolean> {
    return this._call(this._getStub()._rpcExists(path, this._pid()));
  }

  async mkdir(path: string): Promise<void> {
    return this._call(this._getStub()._rpcMkdir(path, this._pid()));
  }

  async rmdir(path: string): Promise<void> {
    return this._call(this._getStub()._rpcRmdir(path, this._pid()));
  }

  async rename(from: string, to: string): Promise<void> {
    return this._call(this._getStub()._rpcRename(from, to, this._pid()));
  }

  async unlink(path: string): Promise<void> {
    return this._call(this._getStub()._rpcUnlink(path, this._pid()));
  }

  async readlink(path: string): Promise<string | null> {
    return this._call(this._getStub()._rpcReadlink(path, this._pid()));
  }

  async symlink(target: string, path: string): Promise<void> {
    return this._call(this._getStub()._rpcSymlink(target, path, this._pid()));
  }

  /**
   * ACQUIRE: the paths mutated since the facet's cursor, plus a fresh
   * cursor. The facet drops those cells from its resident set before
   * running further user code.
   *
   * A separate call rather than a field stamped onto every RPC reply:
   * SupervisorRPC runs in a different isolate from the DO that owns the
   * revision clock, so stamping here would cost its own round trip anyway,
   * and enveloping the existing returns would break `useRpcResource`
   * disposal, which targets the returned value.
   */
  async fsAcquire(epoch: string | null, cursor: number): Promise<VfsAcquireResult> {
    return this._call(this._getStub()._rpcFsAcquire(epoch, cursor, this._pid()));
  }

  async fsRevision(path?: string): Promise<number> {
    return this._call(this._getStub()._rpcFsRevision(path, this._pid()));
  }

  /**
   * WebSocket relay. A facet does not open its own sockets: the supervisor
   * terminates them and hands frames back through `wsPoll`, so an inbound
   * frame is a supervisor reply and the facet's frame handler can take the
   * same ACQUIRE every other supervisor-delivered resumption takes. Without
   * it a third party wakes the facet at a time of its own choosing and the
   * facet's next synchronous read serves bytes the authority has replaced.
   */
  async wsOpen(url: string, protocols: string[]): Promise<{ id: number; protocol: string }> {
    return this._call(this._getStub()._rpcWsOpen(url, protocols, this._pid()));
  }

  async wsPoll(id: number, waitMs: number): Promise<unknown[]> {
    return this._call(this._getStub()._rpcWsPoll(id, waitMs, this._pid()));
  }

  async wsSend(id: number, text: string | null, bytes: Uint8Array | null): Promise<void> {
    return this._call(this._getStub()._rpcWsSend(id, text, bytes, this._pid()));
  }

  async wsClose(id: number, code?: number, reason?: string): Promise<void> {
    return this._call(this._getStub()._rpcWsClose(id, code, reason, this._pid()));
  }

  async fsOpen(path: string, flags: any): Promise<any> {
    return this._call(this._getStub()._rpcFsOpen(path, flags, this._pid()));
  }

  async fsRead(handleId: number, offset: number | null, length: number): Promise<Uint8Array> {
    return this._call(this._getStub()._rpcFsRead(handleId, offset, length, this._pid()));
  }

  async fsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[]): Promise<number> {
    return this._call(this._getStub()._rpcFsWrite(handleId, offset, bytes, this._pid()));
  }

  async fsClose(handleId: number): Promise<void> {
    return this._call(this._getStub()._rpcFsClose(handleId, this._pid()));
  }

  /**
   * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
   * server-side handle state, so they stay correct across supervisor
   * hibernation and never rewrite whole files for partial updates.
   */
  async fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return this._call(this._getStub()._rpcFsReadRange(path, offset, length, this._pid()));
  }

  /**
   * The same read with the session's content cache bypassed, for a boot spec's
   * by-path members. They are read once, in slices, straight into a module map;
   * caching one evicts the user's hot working set and pins tens of MiB in the
   * session's heap for the rest of its life.
   */
  async fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return this._call(this._getStub()._rpcFsReadRangeUncached(path, offset, length, this._pid()));
  }

  /**
   * Read many ranges in ONE round trip — the read-side counterpart to
   * writeBatchStream, and for the same reason: a per-item round trip is the
   * whole cost of a filesystem workload, not the storage lookup behind it.
   * A file the caller knows is small is one entry; a large one is a run of
   * entries over the same path.
   *
   * Entries come back positionally, each carrying exactly what the
   * equivalent fsReadRange would have returned. The batch is bounded by
   * FS_READ_BATCH_PATH_LIMIT paths and FS_READ_BATCH_REQUEST_BYTES of
   * requested range, and the supervisor rejects anything past either — never
   * a short result, which a caller could mistake for a short file.
   */
  async fsReadBatch(requests: FsReadBatchRequest[]): Promise<FsReadBatchEntry[]> {
    // The requested total is the batch's payload ceiling: every entry
    // returns at most the range asked for. Counting it keeps the
    // supervisor's heap estimate honest for the duration of the await, the
    // same accounting writeBatch does for its inbound payload.
    const payloadBytes = requests.reduce((total, request) => total + request.length, 0);
    setLastRpcFrame('fsReadBatch', payloadBytes);
    rpcPayloadStart(payloadBytes);
    try {
      return await this._call(this._getStub()._rpcFsReadBatch(requests, this._pid()));
    } finally {
      rpcPayloadEnd(payloadBytes);
    }
  }

  async fsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer): Promise<number> {
    return this._call(this._getStub()._rpcFsWriteRange(path, offset, bytes, this._pid()));
  }

  async fsAppend(
    path: string,
    moduleId: string,
    operationId: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<number> {
    return this._call(
      this._getStub()._rpcFsAppend(
        path,
        this._writerId(),
        moduleId,
        operationId,
        bytes,
        this._pid(),
      ),
    );
  }

  async fsAppendAck(moduleId: string, operationId: string): Promise<void> {
    return this._call(
      this._getStub()._rpcFsAppendAck(this._writerId(), moduleId, operationId, this._pid()),
    );
  }

  async fsTruncate(path: string, size: number): Promise<void> {
    return this._call(this._getStub()._rpcFsTruncate(path, size, this._pid()));
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
  async writeBatch(payload: any): Promise<{ inodes: number; chunks: number }> {
    // W5 Lever 5: record the frame on entry so /api/_diag/memory has
    // last-known-RPC context if the supervisor crashes mid-RPC.
    // Phase 2 A'.2: bump the in-flight RPC payload counter so the
    // supervisor's heap estimate accounts for the bytes claimed by
    // this RPC for the duration of the await.
    const payloadBytes = _estimateWriteBatchBytes(payload);
    setLastRpcFrame('writeBatch', payloadBytes);
    rpcPayloadStart(payloadBytes);
    try {
      return await this._call(this._getStub()._rpcWriteBatch(payload, this._pid()));
    } finally {
      rpcPayloadEnd(payloadBytes);
    }
  }

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
  async writeBatchStream(
    stream: ReadableStream<Uint8Array>,
  ): Promise<WriteBatchStreamResult> {
    // The encoder emits one bounded v2 record per pull. This wrapper-isolate
    // estimate covers that record; the receiving VFS separately reports and
    // enforces its shared 8 MiB retained-payload credit.
    const STREAM_RESIDENT_BYTES = W7_MAX_RECORD_BYTES;
    setLastRpcFrame('writeBatchStream', -1);
    rpcPayloadStart(STREAM_RESIDENT_BYTES);
    try {
      const mutationOwner = (this.ctx as any).props?.mutationOwner;
      return await this._call(this._getStub()._rpcWriteBatchStream(
        stream,
        typeof mutationOwner === 'string' ? mutationOwner : undefined,
        this._pid(),
      ));
    } finally {
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
  async putRegistryEntries(entries: any[]): Promise<{ written: number; failed: number }> {
    // Phase 2 A'.2: track the inbound array's resident byte cost.
    // Each registry entry is ~500 B (deps + integrity + tarballUrl);
    // a wave of 100 entries is ~50 KiB. Bounded; counted in
    // streamingBuffersBytes for visibility.
    const REGISTRY_ENTRY_BYTES = 512;
    const payloadBytes = (Array.isArray(entries) ? entries.length : 0) * REGISTRY_ENTRY_BYTES;
    rpcPayloadStart(payloadBytes);
    try {
      return await this._call(this._getStub()._rpcPutRegistryEntries(entries));
    } finally {
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
  private _r2(): R2CacheClient {
    const tar = (this.env as any)?.NPM_TARBALL_CACHE ?? null;
    const pkm = (this.env as any)?.NPM_PACKUMENT_CACHE ?? null;
    return new R2CacheClient(tar, pkm);
  }

  /**
   * Look up a tarball in the R2 cross-tenant cache by its content
   * address (the resolved npm integrity string). Returns
   * { bytes, events } where:
   *   - bytes: Uint8Array on hit, null on miss/oversize/no-binding
   *   - events: L2/L3 hit/miss tuples captured during this lookup
   *
   * Facets propagate events into their result for installer.ts to fold
   * into the DO singleton (mirroring the recordR2RaceCounters pattern).
   * Without this enrichment the L2/L3 distinction is supervisor-side
   * knowledge only. The events list is structured-clone-safe (plain
   * objects + strings + numbers).
   *
   * Returned bytes have already been re-hashed against `integrity` by
   * R2CacheClient — the cross-tenant bucket is untrusted storage, so
   * verification happens at the storage boundary and nowhere else.
   */
  async getCachedTarball(
    integrity: string,
  ): Promise<{ bytes: Uint8Array | null; events: SupervisorCacheStatEvent[] }> {
    const r2 = this._r2();
    const bytes = await r2.getTarball(integrity);
    const events = _drainCacheEvents(r2);
    if (bytes && bytes.length > 0 && bytes.length <= MAX_R2_TARBALL_BYTES) {
      return { bytes, events };
    }
    return { bytes: null, events };
  }

  /**
   * Store a tarball in the R2 cross-tenant cache under its content
   * address. Best-effort: on R2 write failure, returns false but the
   * install pipeline continues unaffected. Bytes that do not hash to
   * `integrity` are rejected by R2CacheClient.
   */
  async putCachedTarball(
    integrity: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<boolean> {
    // L4 hits are captured FACET-SIDE in cache-obs-2 — the facet did
    // the registry fetch, so it can push the L4 event directly into
    // its own cacheStatEvents list before calling putCachedTarball.
    // This RPC remains a one-way write (returns bool); the L4 event
    // does NOT flow through this return path.
    const r2 = this._r2();
    return r2.putTarball(integrity, bytes);
  }

  /**
   * Resolve one package's corgi packument: cross-tenant cache read, and
   * on a miss the registry fetch plus the cache fill.
   *
   * Fetch and fill live inside R2CacheClient, not in the resolve facet,
   * and that is a security boundary rather than a layering preference.
   * The packument bucket is shared by every tenant and a packument
   * dictates the tarball URL and integrity digest for everyone who reads
   * it, so a caller-supplied `put` would be a cross-tenant
   * code-execution primitive for anyone holding a supervisor stub. No
   * such RPC exists: the only bytes that reach `pc/<name>.json` are the
   * ones registry.npmjs.org served for that exact name.
   */
  async getPackument(
    name: string,
    options?: { retries?: number; timeoutMs?: number },
  ): Promise<PackumentReadThrough & { events: SupervisorCacheStatEvent[] }> {
    const r2 = this._r2();
    const result = await r2.readThroughPackument(name, options);
    return { ...result, events: _drainCacheEvents(r2) };
  }

  // ── Process I/O ───────────────────────────────────────────────────────

  async stdout(data: string): Promise<void> {
    return this._call(this._getStub()._rpcStdout((this.ctx as any).props?.pid || 0, data));
  }

  async stderr(data: string): Promise<void> {
    return this._call(this._getStub()._rpcStderr((this.ctx as any).props?.pid || 0, data));
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
  async reportExit(code: number, tail?: string): Promise<void> {
    const pid = (this.ctx as any).props?.pid || 0;
    return this._call(this._getStub()._rpcReportExit(pid, code, tail || ''));
  }

  // ── Prefetch ──────────────────────────────────────────────────────────

  async prefetch(cwd: string, entryCode: string): Promise<Record<string, string>> {
    return this._call(this._getStub()._rpcPrefetch(cwd, entryCode));
  }

  // ── Port registration ─────────────────────────────────────────────────

  async registerPort(port: number): Promise<void> {
    return this._call(this._getStub()._rpcRegisterPort((this.ctx as any).props?.pid || 0, port));
  }

  async unregisterPort(port: number): Promise<void> {
    return this._call(this._getStub()._rpcUnregisterPort(port));
  }

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
  async routeLoopback(port: number, request: Request): Promise<Response> {
    return this._getStub()._rpcRouteLoopback(port, request);
  }

  // ── Esbuild transform ─────────────────────────────────────────────────

  async transform(code: string, loader: string): Promise<{ code: string; map: string } | null> {
    return this._call(this._getStub()._rpcTransform(code, loader));
  }

  // ── child_process [W8 Phase 1] ────────────────────────────────────────
  //
  // The parent facet's `child_process.spawn` shim (node-shims.ts) calls
  // these methods. They delegate to NimbusSession._rpcCp* methods which
  // route through the shared FacetProcessManager.
  //

  async cpSpawn(req: any): Promise<{ childPid: number }> {
    return this._call(this._getStub()._rpcCpSpawn({ ...req, parentPid: this._pid() }));
  }

  async cpStdinWrite(childPid: number, data: string): Promise<{ ok: boolean }> {
    return this._call(this._getStub()._rpcCpStdinWrite(childPid, data));
  }

  async cpStdinEnd(childPid: number): Promise<void> {
    return this._call(this._getStub()._rpcCpStdinEnd(childPid));
  }

  async cpReadStdin(childPid: number, waitMs: number): Promise<{
    data: string;
    ended: boolean;
    resize?: { columns: number; rows: number };
    signal?: string;
  }> {
    return this._call(this._getStub()._rpcCpReadStdin(childPid, waitMs));
  }

  async cpReadOutput(
    childPid: number,
    fd: 1 | 2,
    sinceSeq: number,
    waitMs: number,
  ): Promise<{ chunks: { seq: number; data: string }[]; closed: boolean; maxSeq: number }> {
    return this._call(this._getStub()._rpcCpReadOutput(childPid, fd, sinceSeq, waitMs));
  }

  async cpDrainOutput(childPid: number): Promise<{ stdout: string; stderr: string; stdoutClosed: boolean; stderrClosed: boolean }> {
    return this._call(this._getStub()._rpcCpDrainOutput(childPid));
  }

  async cpKill(childPid: number, signal: string): Promise<boolean> {
    return this._call(this._getStub()._rpcCpKill(childPid, signal));
  }

  async cpWait(childPid: number, waitMs: number): Promise<{ done: boolean; exitCode: number | null; signal: string | null }> {
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
  async cpDispatchInline(req: any, kind: string): Promise<{
    exitCode: number; stdout: string; stderr: string;
  }> {
    return this._call(this._getStub()._rpcCpDispatchInline(req, kind));
  }
}
