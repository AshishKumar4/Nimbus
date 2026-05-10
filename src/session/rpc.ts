/**
 * session/rpc.ts — Supervisor RPC + W8 child_process + legacy VFS impls.
 *
 * Why free-functions instead of class methods:
 * the DO RPC fabric calls these by name, so the supervisor's class
 * MUST keep the method names as delegators (otherwise the fabric
 * looks them up and finds nothing). Putting the bodies in free
 * functions and having the class methods one-line-delegate keeps
 * the class file small AND lets these be unit-tested without a DO
 * harness (the `RpcHost` parameter is a narrow contract).
 *
 * Bodies for every `_rpc*`, `vfs*`, `_emit*`, and `_reportExternalExit`
 * method live here. The class retains the method NAMES as one-line
 * delegators in src/session/nimbus-session.ts.
 * 1-line delegators (per plan §IX.4 R1: DO RPC fabric uses name dispatch
 * via the stub).
 *
 * Per DEFECT-D1: ctx is taken via `(self as any).ctx` cast where needed
 * (rpcInnerDoFetch uses self.ctx.id and self.ctx.facets; rpcPutRegistryEntries
 * uses self.ctx.storage.sql). The InitHost-style escape applies because
 * these ~3 sites would each need ctx threaded through; cast at boundary
 * is acceptable per plan §IX recommendation 1.
 */

import { enc } from '../_shared/bytes.js';
import { getInnerDoClass } from '../facets/inner-do-registry.js';
import { NpmCache } from '../npm/cache.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { NimbusLoaderPool } from '../loaders/loader-pool.js';
import {
  recordFailure, getLastRpcFrame, getLastFacetId,
} from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';

// `RpcHost` is intentionally `any`-shaped: extracting an exact subset
// would require enumerating ~25 fields/methods AND the protected ctx,
// which DEFECT-D1 forbids on a public interface. Per plan §IX
// recommendation 1, the class delegators cast `this as any` at the
// boundary; runtime impact is zero (TS-only).
type RpcHost = any;

export async function _rpcReadFile(self: RpcHost, path: string): Promise<string | null> {
    self.ensureSqliteFs();
    try {
      return self.sqliteFs!.readFileString(path.replace(/^\/+/, ''));
    } catch { return null; }
}

  /**
   * Read a file as raw bytes (Uint8Array). Used by git network facet for
   * binary .git/objects/** and packfile reads, where TextDecoder/TextEncoder
   * round-tripping through readFile (string) would corrupt bytes.
   */
export async function _rpcReadFileBytes(self: RpcHost, path: string): Promise<Uint8Array | null> {
    self.ensureSqliteFs();
    try {
      return self.sqliteFs!.readFile(path.replace(/^\/+/, ''));
    } catch { return null; }
}

  /**
   * Phase-3 inner-DO fetch dispatcher. Called by NimbusDOStub.fetch()
   * from the inner Worker via the env.NIMBUS_SESSION loopback. We
   * resolve the inner DO class from the module-level registry (keyed
   * by <thisDoId>:<bindingName>), use ctx.facets.get with the inner's
   * id string as the facet id, and forward the serialized Request.
   *
   * All steps run in THIS RPC method's context, so no cross-request
   * I/O boundaries are crossed — the ctx.facets stub and its fetch()
   * are both created here.
   */
export async function _rpcInnerDoFetch(self: RpcHost, req: {
    bindingName: string;
    id: string;
    method: string;
    url: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
  }): Promise<{
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
  }> {
    const cls = getInnerDoClass(self.ctx.id.toString(), req.bindingName);
    if (!cls) {
      const body = enc.encode(
        `Nimbus: inner DO binding '${req.bindingName}' has no registered class (supervisor=${self.ctx.id.toString()})`,
      );
      return {
        status: 502,
        statusText: 'Bad Gateway',
        headers: [['Content-Type', 'text/plain']],
        body: body.buffer as ArrayBuffer,
      };
    }
    const facetName = 'innerDO-' + req.bindingName + '-' + req.id;
    const facet = (self.ctx as any).facets.get(facetName, async () => ({
      class: cls,
      id: req.id, // FacetStartupOptions.id — inner DO sees this as its ctx.id
    }));
    try {
      // Reconstruct the Request in the current context.
      const headers = new Headers();
      for (const [k, v] of req.headers) headers.append(k, v);
      const r = new Request(req.url, {
        method: req.method,
        headers,
        body: req.body,
      });
      const res: Response = await facet.fetch(r);
      const resHeaderList: [string, string][] = [];
      res.headers.forEach((v: string, k: string) => { resHeaderList.push([k, v]); });
      const resBody = await res.arrayBuffer();
      return {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaderList,
        body: resBody,
      };
    } catch (e: any) {
      const body = enc.encode(
        `Nimbus inner DO error: ${e?.message || String(e)}`,
      );
      return {
        status: 500,
        statusText: 'Internal Server Error',
        headers: [['Content-Type', 'text/plain']],
        body: body.buffer as ArrayBuffer,
      };
    }
}

export async function _rpcWriteFile(self: RpcHost, path: string, content: string | Uint8Array): Promise<void> {
    self.ensureSqliteFs();
    const p = path.replace(/^\/+/, '');
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dir && !self.sqliteFs!.exists(dir)) self.sqliteFs!.mkdir(dir, { recursive: true });
    }
    // binary-fs wave: SqliteVFS.writeFile already accepts string | Uint8Array
    // (sqlite-vfs.ts:937), so we forward the content shape unchanged. RPC
    // structured-clone preserves Uint8Array across the boundary; structured-
    // clone doesn't accept Buffer subclass instances, so fs.writeFileSync on
    // a Buffer flows through node-shims.ts:writeFileSync which stores it as
    // a plain Uint8Array on the cell — the shape that arrives here.
    self.sqliteFs!.writeFile(p, content);
}

export async function _rpcStat(self: RpcHost, path: string): Promise<any> {
    self.ensureSqliteFs();
    try {
      return self.sqliteFs!.stat(path.replace(/^\/+/, ''));
    } catch { return null; }
}

export async function _rpcReaddir(self: RpcHost, path: string): Promise<{ name: string; type: string }[]> {
    self.ensureSqliteFs();
    try {
      return self.sqliteFs!.readdir(path.replace(/^\/+/, ''));
    } catch { return []; }
}

export async function _rpcExists(self: RpcHost, path: string): Promise<boolean> {
    self.ensureSqliteFs();
    return self.sqliteFs!.exists(path.replace(/^\/+/, ''));
}

export async function _rpcMkdir(self: RpcHost, path: string): Promise<void> {
    self.ensureSqliteFs();
    self.sqliteFs!.mkdir(path.replace(/^\/+/, ''), { recursive: true });
}

  /**
   * Called by CirrusHmrRPC.hmrSend. Runs in the DO's own context so
   * we can legally write to hibernatable WS sockets owned by this
   * DO. The HmrBridge holds the client→WS map; we delegate to it.
   */
export async function _rpcHmrRelay(self: RpcHost, clientId: string | null, msg: string): Promise<void> {
    if (!self.cirrusReal) return;
    self.cirrusReal.hmr.relayToBrowser(clientId, msg);
}

export async function _rpcUnlink(self: RpcHost, path: string): Promise<void> {
    self.ensureSqliteFs();
    try { self.sqliteFs!.unlink(path.replace(/^\/+/, '')); } catch {}
}

  /**
   * Bulk-write files and directories via one transactionSync().
   * Called from facets that accumulate writes locally (git clone/fetch/pull,
   * potentially others) to avoid thousands of individual writeFile RPCs.
   *
   * payload: {
   *   inodes: BatchInodeEntry[],
   *   chunks: { path, chunkId, data: Uint8Array | ArrayBuffer }[],
   *   deletePaths?: string[]
   * }
   */
export async function _rpcWriteBatch(self: RpcHost, payload: any): Promise<{ inodes: number; chunks: number }> {
    self.ensureSqliteFs();
    const inodes = Array.isArray(payload?.inodes) ? payload.inodes : [];
    const rawChunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
    const deletePaths = Array.isArray(payload?.deletePaths) ? payload.deletePaths : undefined;

    // Normalize chunk data — RPC may deliver Uint8Array, ArrayBuffer, or { type: 'Buffer', data: [...] }
    const chunks = rawChunks.map((c: any) => {
      let data: Uint8Array;
      if (c.data instanceof Uint8Array) {
        data = c.data;
      } else if (c.data instanceof ArrayBuffer) {
        data = new Uint8Array(c.data);
      } else if (ArrayBuffer.isView(c.data)) {
        data = new Uint8Array((c.data as ArrayBufferView).buffer,
          (c.data as ArrayBufferView).byteOffset,
          (c.data as ArrayBufferView).byteLength);
      } else if (Array.isArray(c.data)) {
        data = new Uint8Array(c.data);
      } else if (c.data && typeof c.data === 'object' && Array.isArray(c.data.data)) {
        // Buffer JSON serialization fallback
        data = new Uint8Array(c.data.data);
      } else {
        data = new Uint8Array(0);
      }
      return { path: String(c.path), chunkId: Number(c.chunkId), data };
    });

    return self.sqliteFs!.writeBatch({
      inodes,
      chunks,
      deletePaths,
    });
}

  /**
   * W7 — Streaming bulk-write entry point. Receives a
   * ReadableStream<Uint8Array> in the W7 wire format (see
   * src/_shared/w7-frame.ts), decodes inode metadata + chunks lazily,
   * and feeds them into SqliteVFS.writeStream().
   *
   * Bypasses the 32 MiB structured-clone cap that constrained the
   * legacy writeBatch path — workerd flow-controls the byte stream
   * end-to-end.
   *
   * Atomicity guarantee mirrors writeBatch: either ALL inodes +
   * chunks land in SQLite or NONE do. SqliteVFS.writeStream defers
   * the actual transactionSync until the chunk iterator is fully
   * drained (v1 spool-then-commit), so a stream error mid-transit
   * aborts before any SQL state mutates.
   */
export async function _rpcWriteBatchStream(self: RpcHost, 
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ inodes: number; chunks: number }> {
    self.ensureSqliteFs();
    // [P0a — COORDINATOR-OVERLOAD]
    //
    // Wave-1 (semaphore here): rejected. Parking peer-side awaits in a
    // user-space queue extended each peer's _rpcFanoutExecute round-trip
    // time, which made workerd cancel the peer→coordinator PARENT RPC
    // with the same overload error (verified prod 7c3f1b25:
    // "[batch-fanout] aborted: ExecutionError: Durable Object is
    // overloaded"). The semaphore moved the queue-age problem one layer
    // up — same symptom, worse blast radius (whole-batch abort instead
    // of per-package fail).
    //
    // Wave-2 (shared flush + adaptive shard cap, no semaphore): the
    // producer-side fix. The peer-side install-batch-facet now shares
    // ONE inode/chunk accumulator across all packages in a peer's
    // shard (src/npm/install-batch-facet.ts), so 39 packages → ~3-5
    // RPCs to coordinator instead of 39+. Combined with shard cap of 8
    // (src/npm/installer.ts), 620 deps → 8 peers × ~3 flushes = ~24
    // total writeBatchStream RPCs at the coordinator (vs 620+ pre-fix).
    // Workerd's input-gate queue depth on the coordinator stays well
    // under the queue-age threshold without any user-space semaphore.
    const { decodeWriteBatchStream } = await import('../_shared/w7-frame.js');
    const decoded = await decodeWriteBatchStream(stream);
    return self.sqliteFs!.writeStream({
      inodes: decoded.inodes,
      chunkIter: decoded.chunkIter,
      deletePaths: decoded.deletePaths,
    });
}

  /**
   * Bulk-write npm registry cache entries in ONE RPC. Used by the
   * resolver-facet to flush a wave of resolved packages back to the
   * supervisor without per-entry round-trips.
   *
   * Payload is the array of RegistryCacheEntry shapes from src/npm-cache.ts.
   * Returns { written, failed } so the facet can surface partial-write
   * warnings to the install log.
   */
export async function _rpcPutRegistryEntries(self: RpcHost, entries: any[]): Promise<{ written: number; failed: number }> {
    self.ensureSqliteFs();
    const npmCache = new NpmCache(self.ctx.storage.sql);
    if (!Array.isArray(entries)) return { written: 0, failed: 0 };
    return npmCache.putRegistryEntries(entries);
}

export async function _rpcStdout(self: RpcHost, pid: number, data: string): Promise<void> {
    // Always buffer raw data (keeps ANSI for replay). Terminal paint only
    // if someone is listening — detached sessions shouldn't silently lose
    // output. Skip pid=0 (the supervisor-rpc fallback when no props.pid
    // was threaded) to avoid polluting a sentinel slot with output from
    // un-traceable facets.
    try {
      if (pid > 0) self.processLogs.append(pid, 'stdout', data);
      if (self.terminal) self.terminal.write(data);
    } catch (e: any) {
      // Fix 5: surface RPC envelope errors when NIMBUS_DEBUG=1. Silent
      // drops here are exactly what hides bugs; default-off so we don't
      // blow up terminals with normal-operation noise, but diagnosable on
      // demand.
      if (self.nimbusDebug && self.terminal) {
        try { self.terminal.write(`\x1b[33m[rpc-error] _rpcStdout(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`); } catch {}
      }
    }
}

export async function _rpcStderr(self: RpcHost, pid: number, data: string): Promise<void> {
    try {
      if (pid > 0) self.processLogs.append(pid, 'stderr', data);
      // Terminal gets red wrapping; the ring buffer keeps it raw so the
      // stream tag can drive color decisions at replay time.
      if (self.terminal) self.terminal.write(`\x1b[31m${data}\x1b[0m`);
    } catch (e: any) {
      if (self.nimbusDebug && self.terminal) {
        try { self.terminal.write(`\x1b[33m[rpc-error] _rpcStderr(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`); } catch {}
      }
    }
}

  /**
   * Called by facets from their `finally` block after I/O has drained.
   * Marks the log store so `logs` / `ps` can show the exit code, and
   * fires `_emitExitDump` if the process exited non-zero with buffered
   * output.
   *
   * Idempotent — double-call is a no-op (ProcessLogStore.markExit guards).
   */
export async function _rpcReportExit(self: RpcHost, pid: number, code: number, tail: string): Promise<void> {
    if (pid <= 0) return; // Ignore the pid-0 sentinel.
    if (tail) self.processLogs.append(pid, 'stderr', tail);
    // Guard against double-reporting: if we've already recorded exit
    // (e.g. from an external kill path) don't dump twice.
    if (self.processLogs.getExit(pid)) return;
    self.processLogs.markExit(pid, code);
    // Structured exit notification for the tabs UI. Idempotent on the
    // client — subscribeExit fires once, and the shell-exec finalizer
    // also emits, so we dedupe on pid there. Include the command (when
    // available via ProcessTable) so the UI can surface a tab for pids
    // whose spawn event was suppressed (e.g. `node -e` short evals).
    const cmdFromTable = self.processTable.get(pid)?.command;
    notifyTerminalEvent(self.terminal, { type: 'exit', pid, code, command: cmdFromTable });

    // Fix 4: dump whenever the ring buffer has bytes, regardless of code.
    // A facet that exits 0 but has a stderr traceback in the buffer is the
    // clean-but-silent case we're hunting. The replay surfaces it even if
    // the user's terminal was detached during the live stream.
    if (self.processLogs.size(pid) > 0) {
      self._emitExitDump(pid, code);
    }

    // Fix 5: verbose exit trace gated on NIMBUS_DEBUG=1. Facets already
    // get a spawn banner via FacetManager.onSpawn; this closes the loop.
    if (self.nimbusDebug && self.terminal) {
      const entry = self.processTable.get(pid);
      const cmd = entry?.command || `pid ${pid}`;
      const colorExit = code === 0 ? '\x1b[2m' : '\x1b[2;31m';
      self.terminal.write(
        `${colorExit}[facet exited: pid=${pid} code=${code} cmd="${cmd}"]\x1b[0m\r\n`,
      );
    }
}

  /**
   * Emit a formatted exit-dump banner + last 30 lines of output to the
   * terminal. Called from both the facet-reported exit path and the
   * external-kill path (timeout / abort).
   *
   * Race notes:
   *   - Terminal.write is buffered with a 5ms flush; concurrent writes
   *     from facet stdout still in flight interleave cleanly at flush
   *     time.
   *   - If no terminal is attached, the dump is simply skipped — the
   *     log buffer still has everything, so `logs <pid>` recovers it.
   */
export function _emitExitDump(self: RpcHost, pid: number, code: number): void {
    if (!self.terminal) return;
    const entry = self.processTable.get(pid);
    const cmd = entry?.command || `pid ${pid}`;
    const chunks = self.processLogs.tail(pid, { lines: 30 });
    const sep = '─'.repeat(60);
    const color = code === 0 ? '\x1b[2;33m' : '\x1b[31m'; // yellow-dim for clean-silent
    self.terminal.write(
      `\r\n${color}${sep}\r\n` +
      `Process ${pid} (${cmd}) exited with code ${code}\r\n` +
      `${sep}\x1b[0m\r\n`,
    );
    for (const c of chunks) {
      const painted = c.stream === 'stderr' ? `\x1b[31m${c.data}\x1b[0m` : c.data;
      self.terminal.write(painted);
    }
    self.terminal.write(`${color}${sep}\x1b[0m\r\n`);
}

  /**
   * Fix 3 + Fix 4 + Fix 5: finalizer for shellExecuteTracked.
   *
   * Runs after a tracked shell.execute finishes (any path). Chooses when
   * to emit the exit-dump banner and when to log the debug trace.
   *
   * Dump policy (Fix 4):
   *   - Non-zero exit AND any buffered output → always dump.
   *   - Zero exit AND buffered output has >0 bytes → dump anyway. Rationale:
   *     an npm run that returned "success" while the ring buffer still has
   *     a traceback is the exact "clean-but-silent failure" we're hunting.
   *     The replay is unique information the user didn't see live (e.g.
   *     because the terminal was reconnected after the fact).
   *   - Zero exit AND empty buffer → nothing to say. Skip.
   *
   * Trace policy (Fix 5):
   *   - NIMBUS_DEBUG=1: always print `[exited pid=N code=C duration=Xms]`.
   *   - Default: print only for non-zero OR long-running scripts (the
   *     cmd-start banner makes them expect an exit marker).
   *
   * Called with the already-marked pid (processTable.exit + processLogs.markExit
   * ran in shellExecuteTracked's finally).
   */
export function _emitShellExecDone(self: RpcHost, pid: number, cmd: string, code: number, durationMs: number): void {
    const bufSize = self.processLogs.size(pid);
    const shouldDump = bufSize > 0 && (code !== 0 || bufSize > 0);
    //                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    // Reads as redundant but is deliberate: Fix 4's intent is "non-empty
    // buffer → dump, regardless of code". Keeping the full expression so
    // the code self-documents WHY we're dumping on clean exits.

    if (shouldDump) {
      self._emitExitDump(pid, code);
    }

    if (self.terminal) {
      const traceAlways = self.nimbusDebug;
      const isLongRunning = /^(vite|wrangler|next|nuxt|astro|remix|dev|serve|start|watch)\b/.test(cmd);
      if (traceAlways || code !== 0 || isLongRunning) {
        const colorExit = code === 0 ? '\x1b[2m' : '\x1b[2;31m';
        self.terminal.write(
          `${colorExit}[shell exited: pid=${pid} code=${code} duration=${durationMs}ms]\x1b[0m\r\n`,
        );
      }
    }
}

  /**
   * External-exit path: invoked by FacetManager when a process is killed
   * outside the facet's own try/finally (timeout, explicit abort, or the
   * `kill` shell command). Appends a synthetic stderr line so the dump
   * has useful context, then runs the same dump machinery.
   */
export function _reportExternalExit(self: RpcHost, pid: number, code: number, reason: string): void {
    if (self.processLogs.getExit(pid)) return;
    if (reason) {
      self.processLogs.append(pid, 'stderr', `[process killed: ${reason}]\n`);
    }
    self.processLogs.markExit(pid, code, reason);
    const cmdFromTable = self.processTable.get(pid)?.command;
    notifyTerminalEvent(self.terminal, { type: 'exit', pid, code, reason, command: cmdFromTable });
    if (self.terminal && self.processLogs.size(pid) > 0) {
      self._emitExitDump(pid, code);
    }
    // W5 Lever 5: ring entry for every external exit with a non-zero
    // code. The FacetManager already records its own exits inline via
    // _w5RecordTermination — this catches the residual paths
    // (timeouts dispatched via the timeout-handler in FacetManager
    // call back through hooks.onExternalExit, which reaches here).
    // The ring is bounded; double-recording is harmless.
    if (code !== 0) {
      try {
        let cause = classifyError(reason);
        if (code === 124 && cause === 'unknown') cause = 'rpc_timeout';
        recordFailure({
          at: Date.now(),
          phase: 'facet',
          cause,
          rssEstimateBytes: self._diagPeakRss,
          heapUsedBytes: self._diagPeakHeapUsed,
          lruBytes: 0, inFlightBytes: 0,
          lastRpcFrame: getLastRpcFrame(),
          lastFacetId: getLastFacetId(),
          exitCode: code,
          pid,
          message: reason,
        });
      } catch { /* fail-soft */ }
    }
}

  /**
   * Kick off a janitor that sweeps expired exit records every 60 s.
   * Idempotent — safe to call repeatedly (guards on self.processLogsTimer).
   */
export function _ensureLogJanitor(self: RpcHost): void {
    if (self.processLogsTimer) return;
    const tick = () => {
      try {
        self.processLogs.dropOlderThan(
          undefined,
          // A pid is "orphaned" if the process table has no record of
          // it — either reap() already removed it, or it never fully
          // registered. Long-running facets that hang and get GC'd
          // fall into this category.
          (pid: number) => !self.processTable.get(pid),
        );
      } catch { /* best-effort */ }
      self.processLogsTimer = setTimeout(tick, 60_000);
    };
    self.processLogsTimer = setTimeout(tick, 60_000);
}

export async function _rpcPrefetch(self: RpcHost, cwd: string, entryCode: string): Promise<Record<string, string>> {
    // W2.6a: de-quarantined. require-resolver.ts is now the primary
    // content-bundle source for FacetManager.exec via buildPrefetchBundle.
    // This RPC entrypoint is retained for facet-side callers that may
    // want to refresh the bundle mid-execution; today only the
    // SupervisorRPC.prefetch surface exposes it externally.
    self.ensureSqliteFs();
    const { prefetchForRequire } = await import('../runtime/require-resolver.js');
    return prefetchForRequire(self.sqliteFs!, entryCode, cwd).bundle;
}

export async function _rpcRegisterPort(self: RpcHost, pid: number, port: number): Promise<void> {
    // Port registration stores the facet association
    // The actual facet stub is stored by FacetManager separately
    self.portRegistry.register(port, pid, null);
}

export async function _rpcUnregisterPort(self: RpcHost, port: number): Promise<void> {
    self.portRegistry.unregister(port);
}

export async function _rpcTransform(self: RpcHost, code: string, loader: string): Promise<{ code: string; map: string } | null> {
    if (!self.esbuildService) {
      self.ensureSqliteFs();
      self.esbuildService = new EsbuildService(self.sqliteFs!);
    }
    try {
      const result = await self.esbuildService.transform(code, {
        loader: loader as any || 'ts',
        format: 'esm',
        target: 'esnext',
        sourcemap: 'inline',
      });
      return { code: result.code, map: result.map };
    } catch (e: any) {
      return null;
    }
}

  // ── child_process RPC entrypoints [W8 Phase 1] ────────────────────────
  //
  // Delegate to the lazily-constructed FacetProcessManager. Defensive
  // ensureFacetProcessManager() handles cold-start cases where a child
  // facet calls cp* before the supervisor has initialized the broker
  // (e.g., immediately after DO hibernation wake-up).

export async function _rpcCpSpawn(self: RpcHost, req: any): Promise<{ childPid: number }> {
    const fpm = self._ensureFacetProcessManager();
    return fpm.spawn(req);
}

export async function _rpcCpStdinWrite(self: RpcHost, childPid: number, data: string): Promise<{ ok: boolean }> {
    const fpm = self._ensureFacetProcessManager();
    return fpm.stdinWrite(childPid, data);
}

export async function _rpcCpStdinEnd(self: RpcHost, childPid: number): Promise<void> {
    const fpm = self._ensureFacetProcessManager();
    fpm.stdinEnd(childPid);
}

export async function _rpcCpReadOutput(self: RpcHost, childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.readOutput(childPid, fd, sinceSeq, waitMs);
}

export async function _rpcCpDrainOutput(self: RpcHost, childPid: number) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.drainOutput(childPid);
}

export async function _rpcCpKill(self: RpcHost, childPid: number, signal: string): Promise<boolean> {
    const fpm = self._ensureFacetProcessManager();
    return fpm.kill(childPid, signal);
}

export async function _rpcCpWait(self: RpcHost, childPid: number, waitMs: number) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.wait(childPid, waitMs);
}

/**
 * arch-gaps gap #1: dispatch a single cp.spawn request inline using the
 * existing pure-builtin / facet-direct logic, returning final stdout/
 * stderr/exitCode rather than streaming via hooks. Called by
 * spawn-facet.ts:runSpawnInIsolate from inside a fresh Worker Loader
 * isolate (the per-spawn fresh-isolate envelope).
 *
 * The fpm exposes a `dispatchInline(req, kind)` that adapts the
 * existing _dispatch path (originally hook-based) into a string-result
 * shape. That adapter is responsible for ensuring stdout/stderr are
 * accumulated inline rather than streamed.
 */
export async function _rpcCpDispatchInline(
  self: RpcHost,
  req: any,
  kind: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fpm = self._ensureFacetProcessManager();
  return fpm.dispatchInline(req, kind);
}

  // ── Legacy VFS RPC Entrypoints (direct method calls) ──────────────────
  // Kept for backward compatibility with direct DO stub callers.

  /** RPC: Read a file from the VFS. Returns ArrayBuffer or null. */
export function vfsReadFile(self: RpcHost, path: string): ArrayBuffer | null {
    self.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      const data = self.sqliteFs!.readFile(stripped);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } catch {
      return null;
    }
}

  /** RPC: Read a file as string. Returns string or null. */
export function vfsReadFileString(self: RpcHost, path: string): string | null {
    self.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      return self.sqliteFs!.readFileString(stripped);
    } catch {
      return null;
    }
}

  /** RPC: Stat a path. Returns { type, size, mtime, mode } or null. */
export function vfsStat(self: RpcHost, path: string): { type: string; size: number; mtime: number; mode: number } | null {
    self.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      return self.sqliteFs!.stat(stripped);
    } catch {
      return null;
    }
}

  /** RPC: Check if path exists. */
export function vfsExists(self: RpcHost, path: string): boolean {
    self.ensureSqliteFs();
    const stripped = path.replace(/^\/+/, '');
    return self.sqliteFs!.exists(stripped);
}

  /** RPC: List directory contents. Returns array of { name, type }. */
export function vfsReaddir(self: RpcHost, path: string): { name: string; type: string }[] {
    self.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      return self.sqliteFs!.readdir(stripped);
    } catch {
      return [];
    }
}

  /** RPC: Write a file to the VFS. */
export function vfsWriteFile(self: RpcHost, path: string, data: ArrayBuffer): void {
    self.ensureSqliteFs();
    const stripped = path.replace(/^\/+/, '');
    self.sqliteFs!.writeFile(stripped, new Uint8Array(data));
}

/**
 * RPC: peer-DO execute leg of NimbusFanoutPool's POC B topology.
 *
 * Called by a coordinator NimbusSession DO via
 * `env.NIMBUS_SESSION.idFromName(siblingName).get()._rpcFanoutExecute(...)`.
 * THIS DO instance acts as a peer worker: it runs ONE NimbusLoaderPool
 * over its assigned shard and returns the per-task results.
 *
 * Cap-sidestep mechanic
 * ─────────────────────
 * The supervisor's `submitMany` makes N RPC calls to N peer DOs.
 * Each RPC is a stub.fetch / RPC method invocation, NOT an
 * `env.LOADER.get()` from the supervisor's own method context — so
 * those N calls don't count against the V8 4-loaders-per-method cap.
 * Inside this RPC handler, we run a SINGLE LoaderPool with concurrency
 * matching the shard size — and since the shard arrived via the peer
 * router (capped at MAX_PEER_FANOUT = 32 peers, so each shard is
 * ⌈totalTasks / 32⌉ wide), the in-DO pool stays well under 4.
 *
 * Failure model
 * ─────────────
 * Throws bubble back to the coordinator's RPC promise (rejects on
 * the supervisor side). The coordinator's `submitMany` Promise.all
 * surfaces the first reject; the install path treats it as a hard
 * failure (matching today's single-facet `pool.submit` posture).
 *
 * Bytes-isolation
 * ───────────────
 * The fnSource string is forwarded verbatim into a fresh
 * NimbusLoaderPool, which serializes it into the loader's worker
 * code. No supervisor-side eval. Same trust posture as every other
 * NimbusLoaderPool dispatch.
 */
export async function _rpcFanoutExecute(
  self: RpcHost,
  fnSource: string,
  args: unknown[],
  poolOpts: {
    tag?: string;
    timeoutMs?: number;
    preamble?: string;
    wasmModules?: Record<string, ArrayBuffer>;
    extraBindings?: Record<string, unknown>;
    omitSupervisor?: boolean;
    /**
     * INSTALL-HONESTY: full doId of the COORDINATOR (the DO that
     * called NimbusFanoutPool.submitMany). The peer's NimbusLoaderPool
     * uses this to mint a SUPERVISOR binding that routes back to the
     * coordinator instead of the peer (default behavior pre-fix).
     * Without this, install-batch's writeBatchStream calls from inside
     * a loader isolate land in the PEER's VFS, invisible to the user.
     */
    coordinatorDoId?: string;
  } = {},
): Promise<{ results: unknown[] }> {
  if (!Array.isArray(args)) {
    throw new TypeError('_rpcFanoutExecute: args must be an array');
  }
  if (args.length === 0) return { results: [] };

  // Concurrency = shard size, capped at 4 (the V8 in-DO ceiling).
  // Shard size on the coordinator side is at most ⌈totalTasks / N⌉
  // where N <= MAX_PEER_FANOUT (32) — for typical 50-pkg installs
  // with N=8 peers, that's 7 tasks per peer, capped to 4 here so
  // each peer DO stays safely below the cap.
  const concurrency = Math.min(args.length, 4);
  const pool = new NimbusLoaderPool(self.env, self.ctx, {
    concurrency,
    timeoutMs: poolOpts.timeoutMs,
    tag: poolOpts.tag ?? 'fanout-peer',
    preamble: poolOpts.preamble,
    wasmModules: poolOpts.wasmModules,
    extraBindings: poolOpts.extraBindings,
    omitSupervisor: poolOpts.omitSupervisor,
    // INSTALL-HONESTY: route SUPERVISOR.* back to the coordinator
    // (the user's session DO), not the peer DO. When undefined
    // (back-compat with non-fanout callers), NimbusLoaderPool falls
    // back to ctx.id.toString() — the legacy behavior, correct for
    // single-DO callers.
    supervisorDoIdOverride: poolOpts.coordinatorDoId,
  });
  try {
    // mapSource accepts the pre-serialized fnSource forwarded by the
    // coordinator (the function was already validated +
    // serialized via serializeFunction on the coordinator side).
    const results = await pool.mapSource(fnSource, args);
    return { results };
  } finally {
    try { pool.dispose(); } catch { /* best-effort */ }
  }
}

// ── Cache-observability stats forward (cache-observability wave) ──────
//
// SupervisorRPC handlers run in a SEPARATE isolate from the DO they
// service (loopback service-binding semantics). When they bump
// per-tier cache counters via src/_shared/cache-stats.ts, they bump
// the LOCAL singleton in the SupervisorRPC isolate. /api/_diag/cache
// reads the DO's singleton — different grid, no visibility.
//
// Fix: SupervisorRPC handlers forward the bump via this DO-side RPC.
// Pattern mirrors recordR2RaceCounters in installer.ts:1168 where the
// facet returns counters and the supervisor folds them into the DO
// singleton. Here the loopback boundary is the equivalent of the
// facet-supervisor boundary.
//
// One forward per (tier, kind, isHit, bytes) tuple. Batch via the
// `events` array so a single supervisor RPC handler can flush multiple
// bumps in one round-trip.

import { recordHit as _rpcRecordHit, recordMiss as _rpcRecordMiss, type CacheTier, type CacheKind } from '../_shared/cache-stats.js';

export type CacheStatEvent =
  | { kind: 'hit'; tier: CacheTier; cacheKind: CacheKind; bytes: number }
  | { kind: 'miss'; tier: CacheTier; cacheKind: CacheKind };

export async function _rpcRecordCacheStats(_self: RpcHost, events: CacheStatEvent[]): Promise<void> {
  // Defensive iteration — caller is in-house (supervisor-rpc.ts) but
  // a malformed event must NOT throw and break the install. Iterate
  // with type-narrowing; an unknown `kind` is silently skipped.
  for (const e of events) {
    if (e.kind === 'hit') {
      _rpcRecordHit(e.tier, e.cacheKind, e.bytes);
    } else if (e.kind === 'miss') {
      _rpcRecordMiss(e.tier, e.cacheKind);
    }
  }
}
