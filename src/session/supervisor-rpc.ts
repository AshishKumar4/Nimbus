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
import {
  r2TarballHit, r2TarballMiss, r2PackumentHit, r2PackumentMiss,
  r2TarballPutOk, r2TarballPutFail, r2PackumentPutOk, r2PackumentPutFail,
} from '../observability/diag-counters.js';
// cache-observability wave: per-tier hit/miss counters.
//
// CRITICAL — SupervisorRPC is a WorkerEntrypoint (loopback service
// binding). It runs in a SEPARATE isolate from the DO it services, so
// bumping a module-scoped singleton here does NOT update the DO's
// /api/_diag/cache surface. We accumulate per-RPC and forward the
// batch back to the DO via _rpcRecordCacheStats at the end of each
// handler. Same pattern as recordR2RaceCounters / install-batch-facet.
import type { CacheTier, CacheKind } from '../_shared/cache-stats.js';

type _CacheStatEvent =
  | { kind: 'hit'; tier: CacheTier; cacheKind: CacheKind; bytes: number }
  | { kind: 'miss'; tier: CacheTier; cacheKind: CacheKind };

/**
 * Pending cache-stat events captured by the R2CacheClient instrumentation
 * inside this RPC call. Flushed via _rpcRecordCacheStats at the end of
 * the handler. The list is bounded by the number of L2/L3 lookups a
 * single get/put performs (≤4 per call: L2 read, L3 read, optional L2
 * writeback, optional L3 writeback).
 */
function _drainCacheEvents(client: any): _CacheStatEvent[] {
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

  // ── Filesystem RPC ────────────────────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    return this._getStub()._rpcReadFile(path);
  }

  /**
   * Read a file as raw bytes. Used by the git network facet for binary
   * object/pack files where the text readFile would corrupt content.
   */
  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this._getStub()._rpcReadFileBytes(path);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // binary-fs wave: accept Uint8Array natively. Pre-fix this RPC was
    // string-only, which forced node-shims.ts:writeFileSync to UTF-8-
    // decode every Uint8Array write — mangling bytes ≥ 0x80 to U+FFFD
    // and corrupting binary content. RPC structured-clone handles
    // Uint8Array transparently; downstream _rpcWriteFile also accepts
    // either shape. See /workspace/.seal-internal/2026-05-10-binary-fs/.
    return this._getStub()._rpcWriteFile(path, content);
  }

  async stat(path: string): Promise<any> {
    return this._getStub()._rpcStat(path);
  }

  async readdir(path: string): Promise<{ name: string; type: string }[]> {
    return this._getStub()._rpcReaddir(path);
  }

  async exists(path: string): Promise<boolean> {
    return this._getStub()._rpcExists(path);
  }

  async mkdir(path: string): Promise<void> {
    return this._getStub()._rpcMkdir(path);
  }

  async unlink(path: string): Promise<void> {
    return this._getStub()._rpcUnlink(path);
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
      return await this._getStub()._rpcWriteBatch(payload);
    } finally {
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
   * Acceptance per audit/sections/MASTER-ROADMAP.md §W7:
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
  ): Promise<{ inodes: number; chunks: number }> {
    // The streaming bytes flow with backpressure (W7_HIGHWATER_BYTES =
    // 256 KiB per active encoder per src/_shared/w7-frame.ts:53). The
    // supervisor-resident bound is the queue highwater, NOT the total
    // payload — the LastRpcFrame surfaces -1 to mark "stream"; the
    // RPC payload counter sees the bounded chunk-size estimate.
    const STREAM_RESIDENT_BYTES = 256 * 1024;
    setLastRpcFrame('writeBatchStream', -1);
    rpcPayloadStart(STREAM_RESIDENT_BYTES);
    try {
      return await this._getStub()._rpcWriteBatchStream(stream);
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
      return await this._getStub()._rpcPutRegistryEntries(entries);
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
  // no breakage. See audit/sections/W4-plan.md §8 risk #1.

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
   * Look up a tarball in the R2 cross-tenant cache. Returns the gzipped
   * tar bytes as Uint8Array, or null on miss / oversize / missing
   * binding. The caller (npm-install-batch-facet) is expected to
   * integrity-verify the bytes before unpacking — same posture as
   * the network-fetch path.
   *
   * Hit / miss counters are bumped on the supervisor side so
   * /api/_diag/memory surfaces accurate cross-install hit-rates.
   */
  async getCachedTarball(name: string, version: string): Promise<Uint8Array | null> {
    const r2 = this._r2();
    const bytes = await r2.getTarball(name, version);
    // Cache-observability wave: forward L2/L3 events the R2 client
    // accumulated during this call to the DO singleton.
    //
    // CRITICAL: do NOT `await` the forward. The supervisor DO is
    // ALREADY on the call stack (DO → SupervisorRPC → here), and
    // calling back into it synchronously triggers workerd's
    // recursion guard (Subrequest depth limit exceeded). Use
    // ctx.waitUntil so the RPC runs out-of-band — the DO singleton
    // updates lag by one call but the install pipeline is unblocked.
    //
    // First-class architectural alternative would be to accumulate
    // events facet-side (where the call ORIGINATES, not loopback)
    // and forward in the install-batch-facet's return value, mirror-
    // ing the recordR2RaceCounters pattern. That's a bigger refactor
    // gated on the next wave's scope.
    const events = _drainCacheEvents(r2);
    if (events.length > 0) {
      const stub = this._getStub();
      const fwd = stub._rpcRecordCacheStats(events).catch(() => { /* best-effort */ });
      try { (this.ctx as any).waitUntil?.(fwd); } catch { /* no ctx.waitUntil in this runtime */ }
    }
    if (bytes && bytes.length > 0 && bytes.length <= MAX_R2_TARBALL_BYTES) {
      r2TarballHit();
      return bytes;
    }
    r2TarballMiss();
    return null;
  }

  /**
   * Store a tarball in the R2 cross-tenant cache. Best-effort: on R2
   * write failure, returns false but the install pipeline continues
   * unaffected. Caller passes the bytes already verified against the
   * resolver's integrity hash.
   */
  async putCachedTarball(
    name: string,
    version: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<boolean> {
    // L4-hit signal: forward to DO singleton via ctx.waitUntil to
    // avoid the recursion-into-same-DO subrequest-depth issue (see
    // getCachedTarball above).
    const size = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
    {
      const stub = this._getStub();
      const fwd = stub._rpcRecordCacheStats([
        { kind: 'hit', tier: 'L4', cacheKind: 'tarball', bytes: size },
      ]).catch(() => { /* best-effort */ });
      try { (this.ctx as any).waitUntil?.(fwd); } catch { /* no ctx.waitUntil */ }
    }
    const r2 = this._r2();
    const ok = await r2.putTarball(name, version, bytes);
    if (ok) r2TarballPutOk();
    else r2TarballPutFail();
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
  async getCachedPackument(
    name: string,
  ): Promise<{ json: string; ageMs: number; expired: boolean } | null> {
    const r2 = this._r2();
    const cached = await r2.getPackument(name);
    // Forward L2/L3 events via ctx.waitUntil (out-of-band; avoids
    // recursion-into-same-DO subrequest-depth limit).
    const events = _drainCacheEvents(r2);
    if (events.length > 0) {
      const stub = this._getStub();
      const fwd = stub._rpcRecordCacheStats(events).catch(() => { /* best-effort */ });
      try { (this.ctx as any).waitUntil?.(fwd); } catch { /* no ctx.waitUntil */ }
    }
    if (cached && !cached.expired) {
      r2PackumentHit();
      return cached;
    }
    if (cached && cached.expired) {
      // Treat expired as a miss for hit-rate accounting; still return
      // the data so callers can use it for stale-while-error.
      r2PackumentMiss();
      return cached;
    }
    r2PackumentMiss();
    return null;
  }

  /**
   * Store a packument in the R2 cross-tenant cache with a TTL stamp.
   * Best-effort. Returns true on success.
   */
  async putCachedPackument(name: string, json: string): Promise<boolean> {
    // L4-hit signal: forward via ctx.waitUntil (out-of-band).
    {
      const stub = this._getStub();
      const fwd = stub._rpcRecordCacheStats([
        { kind: 'hit', tier: 'L4', cacheKind: 'packument', bytes: json.length },
      ]).catch(() => { /* best-effort */ });
      try { (this.ctx as any).waitUntil?.(fwd); } catch { /* no ctx.waitUntil */ }
    }
    const r2 = this._r2();
    const ok = await r2.putPackument(name, json);
    if (ok) r2PackumentPutOk();
    else r2PackumentPutFail();
    return ok;
  }

  /**
   * Admin: purge a single tarball from R2. Used in incident response.
   */
  async purgeCachedTarball(name: string, version: string): Promise<boolean> {
    const r2 = this._r2();
    return r2.deleteTarball(name, version);
  }

  /**
   * Admin: purge a single packument from R2.
   */
  async purgeCachedPackument(name: string): Promise<boolean> {
    const r2 = this._r2();
    return r2.deletePackument(name);
  }

  // ── Process I/O ───────────────────────────────────────────────────────

  async stdout(data: string): Promise<void> {
    return this._getStub()._rpcStdout((this.ctx as any).props?.pid || 0, data);
  }

  async stderr(data: string): Promise<void> {
    return this._getStub()._rpcStderr((this.ctx as any).props?.pid || 0, data);
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
    return this._getStub()._rpcReportExit(pid, code, tail || '');
  }

  // ── Prefetch ──────────────────────────────────────────────────────────

  async prefetch(cwd: string, entryCode: string): Promise<Record<string, string>> {
    return this._getStub()._rpcPrefetch(cwd, entryCode);
  }

  // ── Port registration ─────────────────────────────────────────────────

  async registerPort(port: number): Promise<void> {
    return this._getStub()._rpcRegisterPort((this.ctx as any).props?.pid || 0, port);
  }

  async unregisterPort(port: number): Promise<void> {
    return this._getStub()._rpcUnregisterPort(port);
  }

  // ── Esbuild transform ─────────────────────────────────────────────────

  async transform(code: string, loader: string): Promise<{ code: string; map: string } | null> {
    return this._getStub()._rpcTransform(code, loader);
  }

  // ── child_process [W8 Phase 1] ────────────────────────────────────────
  //
  // The parent facet's `child_process.spawn` shim (node-shims.ts) calls
  // these methods. They delegate to NimbusSession._rpcCp* methods which
  // route through the shared FacetProcessManager.
  //
  // Contract documented in audit/sections/W8-plan.md §2 / §8.5.

  async cpSpawn(req: any): Promise<{ childPid: number }> {
    return this._getStub()._rpcCpSpawn(req);
  }

  async cpStdinWrite(childPid: number, data: string): Promise<{ ok: boolean }> {
    return this._getStub()._rpcCpStdinWrite(childPid, data);
  }

  async cpStdinEnd(childPid: number): Promise<void> {
    return this._getStub()._rpcCpStdinEnd(childPid);
  }

  async cpReadOutput(
    childPid: number,
    fd: 1 | 2,
    sinceSeq: number,
    waitMs: number,
  ): Promise<{ chunks: { seq: number; data: string }[]; closed: boolean; maxSeq: number }> {
    return this._getStub()._rpcCpReadOutput(childPid, fd, sinceSeq, waitMs);
  }

  async cpDrainOutput(childPid: number): Promise<{ stdout: string; stderr: string; stdoutClosed: boolean; stderrClosed: boolean }> {
    return this._getStub()._rpcCpDrainOutput(childPid);
  }

  async cpKill(childPid: number, signal: string): Promise<boolean> {
    return this._getStub()._rpcCpKill(childPid, signal);
  }

  async cpWait(childPid: number, waitMs: number): Promise<{ done: boolean; exitCode: number | null; signal: string | null }> {
    return this._getStub()._rpcCpWait(childPid, waitMs);
  }

  /**
   * arch-gaps gap #1: dispatch a single cp.spawn request inline using
   * the existing pure-builtin / facet-direct logic, returning final
   * stdout/stderr/exitCode (NOT streamed via hooks). Called from
   * spawn-facet.ts:runSpawnInIsolate inside a fresh Worker Loader
   * isolate to delegate the actual command execution back to the
   * supervisor while keeping the dispatch envelope in a fresh isolate.
   */
  async cpDispatchInline(req: any, kind: string): Promise<{
    exitCode: number; stdout: string; stderr: string;
  }> {
    return this._getStub()._rpcCpDispatchInline(req, kind);
  }
}


