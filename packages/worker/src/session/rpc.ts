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

import { enc, dec } from '../_shared/bytes.js';
import { normalizeTerminalNewlines } from '../_shared/terminal.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';
import { getInnerDoClass } from '../facets/inner-do-registry.js';
import { NpmCache } from '../npm/cache.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { SqliteRuntimeFsBridge } from '../runtime/sqlite-runtime-fs-bridge.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { NimbusLoaderPool } from '../loaders/loader-pool.js';
import {
  recordFailure, getLastRpcFrame, getLastFacetId,
} from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import type { RuntimeOpenFlags } from '../runtime/os-contracts.js';
import type { BatchInodeEntry, WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
import { z } from 'zod/v4';

// `RpcHost` is intentionally `any`-shaped: extracting an exact subset
// would require enumerating ~25 fields/methods AND the protected ctx,
// which DEFECT-D1 forbids on a public interface. Per plan §IX
// recommendation 1, the class delegators cast `this as any` at the
// boundary; runtime impact is zero (TS-only).
type RpcHost = any;

const WriteBatchInodeSchema: z.ZodType<BatchInodeEntry> = z.object({
  path: z.string(),
  parentPath: z.string(),
  kind: z.enum(['file', 'directory', 'symlink']).optional(),
  isDir: z.boolean(),
  size: z.number(),
  atime: z.number().optional(),
  mtime: z.number(),
  mode: z.number(),
  chunkCount: z.number(),
});

const WriteBatchChunkSchema = z.object({
  path: z.string(),
  chunkId: z.number(),
  data: z.unknown(),
}).passthrough();

const WriteBatchPayloadSchema = z.object({
  inodes: z.array(WriteBatchInodeSchema).default([]),
  chunks: z.array(WriteBatchChunkSchema).default([]),
  deletePaths: z.array(z.string()).optional(),
}).passthrough();

function runtimeFs(self: RpcHost): SqliteRuntimeFsBridge {
  self.ensureSqliteFs();
  if (!self.runtimeFsBridge) {
    self.runtimeFsBridge = new SqliteRuntimeFsBridge(self.sqliteFs!);
  }
  return self.runtimeFsBridge;
}

export async function _rpcReadFile(self: RpcHost, path: string): Promise<string | null> {
    const bytes = await runtimeFs(self).readFile(path);
    return bytes ? dec.decode(bytes) : null;
}

  /**
   * Read a file as raw bytes (Uint8Array). Used by git network facet for
   * binary .git/objects/** and packfile reads, where TextDecoder/TextEncoder
   * round-tripping through readFile (string) would corrupt bytes.
   */
export async function _rpcReadFileBytes(self: RpcHost, path: string): Promise<Uint8Array | null> {
    return runtimeFs(self).readFile(path);
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
      try {
        const resHeaderList: [string, string][] = [];
        res.headers.forEach((v: string, k: string) => { resHeaderList.push([k, v]); });
        const resBody = await res.arrayBuffer();
        return {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaderList,
          body: resBody,
        };
      } finally {
        disposeRpcResource(res);
      }
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
    // binary-fs wave: SqliteVFS.writeFile already accepts string | Uint8Array
    // (sqlite-vfs.ts:937), so we forward the content shape unchanged. RPC
    // structured-clone preserves Uint8Array across the boundary; structured-
    // clone doesn't accept Buffer subclass instances, so fs.writeFileSync on
    // a Buffer flows through node-shims.ts:writeFileSync which stores it as
    // a plain Uint8Array on the cell — the shape that arrives here.
    await runtimeFs(self).writeFile(path, content);
}

export async function _rpcStat(self: RpcHost, path: string): Promise<any> {
    return runtimeFs(self).stat(path);
}

export async function _rpcLstat(self: RpcHost, path: string): Promise<any> {
  return runtimeFs(self).stat(path, { followSymlinks: false });
}

export async function _rpcHasLegacySymlinkUnder(self: RpcHost, path: string): Promise<boolean> {
  self.ensureSqliteFs();
  return getSymlinkRegistry(self.sqliteFs!).hasAtOrBelow(path);
}

export async function _rpcUtimes(self: RpcHost, path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    await runtimeFs(self).utimes(path, atimeMs, mtimeMs);
}

export async function _rpcReaddir(self: RpcHost, path: string): Promise<{ name: string; type: string }[]> {
    return runtimeFs(self).readdir(path);
}

export async function _rpcExists(self: RpcHost, path: string): Promise<boolean> {
    return (await runtimeFs(self).stat(path)) !== null;
}

export async function _rpcMkdir(self: RpcHost, path: string): Promise<void> {
    await runtimeFs(self).mkdir(path, { recursive: true });
}

export async function _rpcRmdir(self: RpcHost, path: string): Promise<void> {
    await runtimeFs(self).rmdir(path);
}

export async function _rpcRename(self: RpcHost, from: string, to: string): Promise<void> {
    await runtimeFs(self).rename(from, to);
}

export async function _rpcReadlink(self: RpcHost, path: string): Promise<string | null> {
    return runtimeFs(self).readlink(path);
}

export async function _rpcSymlink(self: RpcHost, target: string, path: string): Promise<void> {
    await runtimeFs(self).symlink(target, path);
}

const FsRangeOffsetSchema = z.number().int().min(0).finite();

const FsReadRangeArgsSchema = z.object({
  path: z.string(),
  offset: FsRangeOffsetSchema,
  length: FsRangeOffsetSchema,
});

const FsWriteRangeArgsSchema = z.object({
  path: z.string(),
  offset: FsRangeOffsetSchema,
});

const FsTruncateArgsSchema = z.object({
  path: z.string(),
  size: FsRangeOffsetSchema,
});

export async function _rpcFsRevision(self: RpcHost, path?: string): Promise<number> {
    return runtimeFs(self).revision(typeof path === 'string' ? path : undefined);
}

export async function _rpcFsReadRange(
  self: RpcHost,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array | null> {
    const args = FsReadRangeArgsSchema.parse({ path, offset, length });
    return runtimeFs(self).readRange(args.path, args.offset, args.length);
}

export async function _rpcFsWriteRange(
  self: RpcHost,
  path: string,
  offset: number,
  bytes: Uint8Array | ArrayBuffer | number[],
): Promise<number> {
    const args = FsWriteRangeArgsSchema.parse({ path, offset });
    return runtimeFs(self).writeRange(args.path, args.offset, normalizeWriteBatchChunkData(bytes));
}

export async function _rpcFsTruncate(self: RpcHost, path: string, size: number): Promise<void> {
    const args = FsTruncateArgsSchema.parse({ path, size });
    await runtimeFs(self).truncate(args.path, args.size);
}

export async function _rpcFsOpen(self: RpcHost, path: string, flags: RuntimeOpenFlags): Promise<any> {
    return runtimeFs(self).open(path, flags || {});
}

export async function _rpcFsRead(
  self: RpcHost,
  handleId: number,
  offset: number | null,
  length: number,
): Promise<Uint8Array> {
    return runtimeFs(self).read(handleId, offset, length);
}

export async function _rpcFsWrite(
  self: RpcHost,
  handleId: number,
  offset: number | null,
  bytes: Uint8Array | ArrayBuffer | number[],
): Promise<number> {
    let data: Uint8Array;
    if (bytes instanceof Uint8Array) data = bytes;
    else if (bytes instanceof ArrayBuffer) data = new Uint8Array(bytes);
    else data = new Uint8Array(bytes || []);
    return runtimeFs(self).write(handleId, offset, data);
}

export async function _rpcFsClose(self: RpcHost, handleId: number): Promise<void> {
    await runtimeFs(self).close(handleId);
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
    await runtimeFs(self).unlink(path);
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
export async function _rpcWriteBatch(self: RpcHost, payload: unknown): Promise<{ inodes: number; chunks: number }> {
    self.ensureSqliteFs();
    const parsed = WriteBatchPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('writeBatch payload failed validation');
    const { inodes, chunks: rawChunks, deletePaths } = parsed.data;

    // Normalize chunk data — RPC may deliver Uint8Array, ArrayBuffer, or { type: 'Buffer', data: [...] }
    const chunks = rawChunks.map((c) => ({
      path: c.path,
      chunkId: c.chunkId,
      data: normalizeWriteBatchChunkData(c.data),
    }));

    return self.sqliteFs!.writeBatch({
      inodes,
      chunks,
      deletePaths,
    });
}

function normalizeWriteBatchChunkData(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    const data = Reflect.get(value, 'data');
    if (Array.isArray(data)) return new Uint8Array(data);
  }
  return new Uint8Array(0);
}

  /**
   * W7 — Streaming bulk-write entry point. Receives a
   * ReadableStream<Uint8Array> in the W7 v3 wire format (see
   * src/_shared/w7-frame.ts) and hands the raw pull-controlled stream to
   * SqliteVFS.writeStream().
   *
   * Bypasses the 32 MiB structured-clone cap that constrained the
   * legacy writeBatch path — workerd flow-controls the byte stream
   * end-to-end.
   *
   * Unlike strict writeBatch, the stream contract is path-atomic with a
   * committed prefix: every reported path is complete, but earlier publish
   * groups remain durable when a later group fails. The typed result carries
   * the exact durable progress.
   */
export async function _rpcWriteBatchStream(self: RpcHost, 
    stream: ReadableStream<Uint8Array>,
    mutationOwner?: string,
  ): Promise<WriteBatchStreamResult> {
    self.ensureSqliteFs();
    // [P0a — COORDINATOR-OVERLOAD]
    //
    // core WASI (semaphore here): rejected. Parking peer-side awaits in a
    // user-space queue extended each peer's _rpcFanoutExecute round-trip
    // time, which made workerd cancel the peer→coordinator PARENT RPC
    // with the same overload error (observed in production 7c3f1b25:
    // "[batch-fanout] aborted: ExecutionError: Durable Object is
    // overloaded"). The semaphore moved the queue-age problem one layer
    // up — same symptom, worse blast radius (whole-batch abort instead
    // of per-package fail).
    //
    // filesystem WASI (shared flush + adaptive shard cap, no semaphore): the
    // producer-side fix. The peer-side install-batch-facet now shares
    // ONE inode/chunk accumulator across all packages in a peer's
    // shard (src/npm/install-batch-facet.ts), so 39 packages → ~3-5
    // RPCs to coordinator instead of 39+. Combined with shard cap of 8
    // (src/npm/installer.ts), 620 deps → 8 peers × ~3 flushes = ~24
    // total writeBatchStream RPCs at the coordinator (vs 620+ pre-fix).
    // Workerd's input-gate queue depth on the coordinator stays well
    // under the queue-age threshold without any user-space semaphore.
    const decodeDrainStartedAt = performance.now();
    return self.sqliteFs!.writeStream(stream, {
      decodeDrainStartedAt,
      mutationOwner,
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

/**
 * Post-reset semantics: a pid at or below the current generation's pid floor
 * belongs to a facet spawned by a PREVIOUS DO instance (see PID_GEN_STRIDE).
 * The in-memory process state that owned it — table entry, input store, shell
 * association — died with that instance, so the coherent contract is a clean,
 * attributed death: refuse its output, kill its stdin pump, and mark/broadcast
 * an honest exit so a surviving process-terminal tab shows what happened
 * instead of a silent half-alive display.
 */
function isPriorGenerationPid(self: RpcHost, pid: number): boolean {
  return pid > 0 && pid <= self.processes.pidBase;
}

export const PRIOR_GENERATION_EXIT_REASON = 'process lost: instance reset';

export async function _rpcStdout(self: RpcHost, pid: number, data: string): Promise<void> {
    // Prior-generation straggler (facet outlived a DO instance reset): drop —
    // its output must not merge into this generation's logs or shell.
    if (isPriorGenerationPid(self, pid)) return;
    // Always buffer raw data (keeps ANSI for replay). Terminal paint only
    // if someone is listening — detached sessions shouldn't silently lose
    // output. Skip pid=0 (the supervisor-rpc fallback when no props.pid
    // was threaded) to avoid polluting a sentinel slot with output from
    // un-traceable facets.
    try {
      if (pid > 0) self.processes.appendOutput(pid, 'stdout', data);
      if (self.terminal && shouldMirrorProcessOutputToShell(self, pid)) {
        self.terminal.write(normalizeTerminalNewlines(data));
      }
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
    if (isPriorGenerationPid(self, pid)) return;
    try {
      if (pid > 0) self.processes.appendOutput(pid, 'stderr', data);
      // Terminal gets red wrapping; the ring buffer keeps it raw so the
      // stream tag can drive color decisions at replay time.
      if (self.terminal && shouldMirrorProcessOutputToShell(self, pid)) {
        self.terminal.write(`\x1b[31m${normalizeTerminalNewlines(data)}\x1b[0m`);
      }
    } catch (e: any) {
      if (self.nimbusDebug && self.terminal) {
        try { self.terminal.write(`\x1b[33m[rpc-error] _rpcStderr(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`); } catch {}
      }
    }
}

function shouldMirrorProcessOutputToShell(self: RpcHost, pid: number): boolean {
  if (pid <= 0) return true;
  const entry = self.processes.get(pid);
  // No table entry: either a reaped process's late flush or a facet that
  // outlived an instance reset. Neither owns the user's shell anymore — the
  // output still lands in the log ring above, never on the shell WS (an
  // attached-TTY straggler would otherwise spray alternate-screen ANSI over
  // the prompt).
  if (!entry) return false;
  return entry.attachedTty !== true;
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
    // Prior-generation straggler unwinding after an instance reset: this
    // instance never owned the pid, so skip the table/lifecycle plumbing and
    // record ONLY the honest exit — the log store broadcast reaches any
    // surviving process-terminal tab still attached to the old pid.
    if (isPriorGenerationPid(self, pid)) {
      self.processes.markExit(pid, code, PRIOR_GENERATION_EXIT_REASON);
      return;
    }
    try { self.processes.closeInput(pid); } catch {}
    if (tail) self.processes.appendOutput(pid, 'stderr', tail);
    // Guard against double-reporting: if we've already recorded exit
    // (e.g. from an external kill path) don't dump twice.
    if (self.processes.getExit(pid)) return;
    self.processes.markExit(pid, code);
    try { self.facetManager?.noteProcessReportedExit?.(pid, code); } catch {
      try { self.processes.exit(pid, code); } catch {}
    }
    // Structured exit notification for the tabs UI. Idempotent on the
    // client — subscribeExit fires once, and the shell-exec finalizer
    // also emits, so we dedupe on pid there. Include the command (when
    // available via ProcessTable) so the UI can surface a tab for pids
    // whose spawn event was suppressed (e.g. `node -e` short evals).
    const cmdFromTable = self.processes.get(pid)?.command;
    notifyTerminalEvent(self.terminal, { type: 'exit', pid, code, command: cmdFromTable });

    // SHELL-FOLLOWUPS-5 (2026-05-11): only dump on non-zero exit.
    //
    // Pre-fix Fix-4 policy was "dump whenever the ring buffer has
    // bytes, regardless of code" (intent: catch the
    // clean-but-silent failure where stderr traceback was buffered
    // but user wasn't watching). Real-world cost: every successful
    // `node -e`, `python -c`, etc. printed stdout once live, then
    // again as a post-exit dump — double-print on the happy path.
    //
    // New policy:
    //   - Non-zero exit AND non-empty buffer → dump (failure context)
    //   - Zero exit → no dump (live stream already showed it)
    //
    // Reconnect-replay path is preserved by the `logs <pid>` shell
    // command + `/api/processes/<pid>/logs` endpoint, neither of
    // which depends on the inline dump.
    //
    // NOTE: _emitShellExecDone (below) carries an identical gate;
    // both paths must agree because either may fire first depending
    // on facet vs. shell-finalizer ordering.
    if (code !== 0 && self.processes.logSize(pid) > 0) {
      self._emitExitDump(pid, code);
    }

    // Fix 5: verbose exit trace gated on NIMBUS_DEBUG=1. Facets already
    // get a spawn banner via FacetManager.onSpawn; this closes the loop.
    if (self.nimbusDebug && self.terminal) {
      const entry = self.processes.get(pid);
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
    const entry = self.processes.get(pid);
    const cmd = entry?.command || `pid ${pid}`;
    const chunks = self.processes.tailLogs(pid, { lines: 30 });
    const sep = '─'.repeat(60);
    const color = code === 0 ? '\x1b[2;33m' : '\x1b[31m'; // yellow-dim for clean-silent
    self.terminal.write(
      `\r\n${color}${sep}\r\n` +
      `Process ${pid} (${cmd}) exited with code ${code}\r\n` +
      `${sep}\x1b[0m\r\n`,
    );
    for (const c of chunks) {
      const terminalData = normalizeTerminalNewlines(c.data);
      const painted = c.stream === 'stderr' ? `\x1b[31m${terminalData}\x1b[0m` : terminalData;
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
   * Called with the already-marked pid (processes.exit + processes.markExit
   * ran in shellExecuteTracked's finally).
   */
export function _emitShellExecDone(self: RpcHost, pid: number, cmd: string, code: number, durationMs: number): void {
    const bufSize = self.processes.logSize(pid);
    // SHELL-FOLLOWUPS-5 (2026-05-11): only dump on non-zero exit.
    //
    // Pre-fix policy was "dump regardless of code when buffer non-empty"
    // (Fix 4 from W3.5 era, intent: catch clean-but-silent failure
    // where user couldn't see live output e.g. across reconnect).
    //
    // Real-world cost: for every successful `node -e`, `python -c`,
    // `npx X --version`, etc., user saw output once live + once
    // again in the post-exit dump. Annoying double-print for the
    // common-case interactive session.
    //
    // New policy:
    //   - Non-zero exit AND non-empty buffer → dump (failure context)
    //   - Zero exit → no dump (live stream already showed it)
    //
    // Reconnect-replay path is preserved by the `logs <pid>` shell
    // command + `/api/processes/<pid>/logs` endpoint, neither of
    // which depends on the inline dump.
    const shouldDump = bufSize > 0 && code !== 0;

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
    if (self.processes.getExit(pid)) return;
    try { self.processes.closeInput(pid); } catch {}
    if (reason) {
      self.processes.appendOutput(pid, 'stderr', `[process killed: ${reason}]\n`);
    }
    self.processes.markExit(pid, code, reason);
    const cmdFromTable = self.processes.get(pid)?.command;
    notifyTerminalEvent(self.terminal, { type: 'exit', pid, code, reason, command: cmdFromTable });
    if (self.terminal && self.processes.logSize(pid) > 0) {
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
 * W1: orphan-pid predicate exposed for the alarm dispatcher. A pid is
 * "orphaned" if the process table has no record of it — either reap()
 * already removed it, or it never fully registered. Long-running
 * facets that hang and get GC'd fall into this category.
 */
export function _logJanitorOrphanCheck(self: RpcHost): (pid: number) => boolean {
  return (pid: number) => !self.processes.get(pid);
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
    if (self.processes.hasInput(childPid)) {
      return self.processes.writeInput(childPid, data);
    }
    const fpm = self._ensureFacetProcessManager();
    return fpm.stdinWrite(childPid, data);
}

export async function _rpcCpStdinEnd(self: RpcHost, childPid: number): Promise<void> {
    if (self.processes.hasInput(childPid)) {
      self.processes.endInput(childPid);
      return;
    }
    const fpm = self._ensureFacetProcessManager();
    fpm.stdinEnd(childPid);
}

export async function _rpcCpReadStdin(self: RpcHost, childPid: number, waitMs: number) {
    // Prior-generation straggler: its ProcessInputStore died with the old
    // instance. Deliver a kill so the facet's stdin pump unwinds immediately
    // with explicit semantics (__ProcessExit(137) → reportExit → the honest
    // prior-generation exit mark above) instead of polling a void.
    if (isPriorGenerationPid(self, childPid)) {
      return { signal: 'SIGKILL', ended: true };
    }
    if (self.processes.hasInput(childPid)) {
      return self.processes.readInput(childPid, waitMs);
    }
    const fpm = self._ensureFacetProcessManager();
    return fpm.cpReadStdin(childPid, waitMs);
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
 * child-process isolation gap #1: dispatch a single cp.spawn request inline using the
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

  /** RPC: Stat a path. Returns file metadata or null. */
export function vfsStat(self: RpcHost, path: string): { type: string; size: number; atime: number; ctime: number; mtime: number; mode: number } | null {
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
 * RPC: peer-DO execute leg of NimbusFanoutPool's peer-DO fanout topology.
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

// ── Cache-observability stats forward (cache metrics support) ──────
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
