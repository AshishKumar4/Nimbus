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

  async writeFile(path: string, content: string): Promise<void> {
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
    return this._getStub()._rpcWriteBatch(payload);
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
    return this._getStub()._rpcPutRegistryEntries(entries);
  }

  /**
   * Return raw esbuild-wasm bytes as an ArrayBuffer.
   *
   * The production pre-bundle path no longer uses this RPC — bytes
   * are shipped via NimbusFacetPool's `wasmModules` option which
   * registers them in the LOADER `modules` map for workerd to
   * compile at facet startup. Kept for compatibility / future
   * non-pool consumers.
   */
  async getEsbuildWasm(): Promise<ArrayBuffer> {
    return this._getStub()._rpcGetEsbuildWasm();
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
}

/**
 * @deprecated Legacy fetch-based RPC handler. Kept as a fallback for
 * call paths that pre-date the ctx.exports-driven SupervisorRPC class.
 * No live caller is known; the warning emitted on entry lets prod logs
 * confirm full-deadness before this function is removed in a follow-up
 * cleanup phase.
 *
 * Called from the DO's fetch() handler for POST /api/supervisor-rpc.
 */
export async function handleSupervisorRpc(
  request: Request,
  ctx: { vfs: any; processTable: any; portRegistry: any; terminal: any; processLogs?: any },
): Promise<Response> {
  // ARC-A-P3: Quarantined. Same observation pattern as _rpcPrefetch in
  // nimbus-session.ts — log on entry so prod confirms zero callers before
  // we remove this fallback path. Body shape (method/pid/args) is logged
  // without contents to avoid leaking caller data.
  try {
    const body = await request.json() as any;
    const { method, pid, args } = body;
    console.warn(
      '[nimbus] ARC-A-P3-QUARANTINE: handleSupervisorRpc hit — legacy fallback still in use',
      { method, pid, hasArgs: args !== undefined && args !== null },
    );
    switch (method) {
      case 'writeStdout': {
        const d = String(args?.data ?? '');
        const p = Number(pid);
        if (p > 0) ctx.processLogs?.append(p, 'stdout', d);
        if (ctx.terminal) ctx.terminal.write(d);
        return Response.json({ ok: true });
      }
      case 'writeStderr': {
        const d = String(args?.data ?? '');
        const p = Number(pid);
        if (p > 0) ctx.processLogs?.append(p, 'stderr', d);
        if (ctx.terminal) ctx.terminal.write(`\x1b[31m${d}\x1b[0m`);
        return Response.json({ ok: true });
      }
      case 'reportExit': {
        const code = Number(args?.code ?? 0);
        const tail = String(args?.tail ?? '');
        const p = Number(pid);
        if (p > 0) {
          if (tail) ctx.processLogs?.append(p, 'stderr', tail);
          ctx.processLogs?.markExit?.(p, code);
        }
        return Response.json({ ok: true });
      }
      case 'vfsReadFile': { const p = String(args?.path ?? '').replace(/^\/+/, ''); try { return Response.json({ ok: true, data: ctx.vfs.readFileString(p) }); } catch { return Response.json({ ok: false, data: null }); } }
      case 'vfsStat': { const p = String(args?.path ?? '').replace(/^\/+/, ''); try { return Response.json({ ok: true, stat: ctx.vfs.stat(p) }); } catch { return Response.json({ ok: false, stat: null }); } }
      case 'vfsExists': { const p = String(args?.path ?? '').replace(/^\/+/, ''); return Response.json({ ok: true, exists: ctx.vfs.exists(p) }); }
      case 'vfsReaddir': { const p = String(args?.path ?? '').replace(/^\/+/, ''); try { return Response.json({ ok: true, entries: ctx.vfs.readdir(p) }); } catch { return Response.json({ ok: true, entries: [] }); } }
      case 'vfsWriteFile': { const p = String(args?.path ?? '').replace(/^\/+/, ''); const parts = p.split('/'); for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (d && !ctx.vfs.exists(d)) ctx.vfs.mkdir(d, { recursive: true }); } ctx.vfs.writeFile(p, String(args?.content ?? '')); return Response.json({ ok: true }); }
      default: return Response.json({ error: `Unknown RPC method: ${method}` }, { status: 400 });
    }
  } catch (e: any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
