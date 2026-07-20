/**
 * nimbus-session.ts — NimbusSession Durable Object (v2.0).
 *
 * The supervisor DO that owns the VFS, shell, and all commands.
 * `node` execution is delegated to dynamic workers via LOADER.load().
 * IPC between facets and the supervisor flows through SupervisorRPC.
 */
import { Kernel, Shell } from '../substrate/lifo/index.js';
import { DurableObject as CloudflareDurableObject } from 'cloudflare:workers';
import { SqliteVFS, type WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { FacetManager } from '../facets/manager.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { SqliteRuntimeFsBridge } from '../runtime/sqlite-runtime-fs-bridge.js';
import type { WsHibernationConfigResult } from './hibernation.js';
import { PortRegistry } from '../runtime/port-registry.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { ViteDevServer } from '../facets/vite-dev-server.js';
import { CirrusReal } from '../facets/cirrus-real.js';
import { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import { NpmInstaller } from '../npm/installer.js';
import { type TryEnableReplicasResult as _W12EnableResult } from '../replica/routing.js';
import * as _programmatic from './programmatic.js';
export { filterWranglerFlags, detectBundlerBin, checkNodeModulesGuard, detectUnsupportedWranglerConfig, renderNoDevServerHtml, BUNDLER_BIN_PREFIXES, NIMBUS_UNSUPPORTED_BINS, WRANGLER_IGNORED_FLAGS, WRANGLER_IGNORED_FLAGS_WITH_VALUE, WRANGLER_UNSUPPORTED_CONFIG_FIELDS, } from './helpers.js';
export { detectCloudflareWorkersProject } from '../runtime/project-detect.js';
/**
 * Render the welcome MOTD banner with column-counted padding so every
 * line lands the right ║ on the same column regardless of how many
 * non-ASCII characters (em-dash, middle-dot) the content contains.
 *
 * Width model: each "row" is built by left-aligning content into a
 * fixed inner-width slot, then bracketed by ║ and padded with spaces.
 * Codepoint count is used as the column count. This is correct for
 * all characters in the current banner — box-drawing (U+2500-U+257F),
 * em-dash (U+2014), and middle-dot (U+00B7) are all defined as
 * 1-cell-wide in the Unicode East Asian Width table (`Na`/`A`/`N`).
 *
 * Why this exists: pre-fix, the banner used hand-counted padding
 * literals. Adding/removing a single character (e.g. version bumping
 * from "v2.0" to "v2.0.0") shifted line 2 by one column, breaking
 * the right boundary. See user-debug-transcript.txt lines 1-5.
 */
export declare function renderMotdBanner(version: string): string;
export declare function renderWelcomeMarkdown(version: string): string;
export declare class NimbusSession extends CloudflareDurableObject {
    sqliteFs: SqliteVFS | null;
    runtimeFsBridges: Map<number, SqliteRuntimeFsBridge> | null;
    kernel: Kernel | null;
    shell: Shell | null;
    shellProcessPid: number | null;
    terminal: WebSocketTerminal | null;
    facetManager: FacetManager | null;
    /** W8: child_process broker. Lazy — only constructed when first cp* RPC arrives. */
    facetProcessManager: any;
    esbuildService: EsbuildService | null;
    viteDevServer: ViteDevServer | null;
    /**
     * runtime primitive support (P5): PID + port the default-Cirrus vite shim is
     * registered under. Cleared on `vite stop`. See
     * `runtime/long-running-handle.ts` and the vite handler in
     * `session/init.ts`.
     */
    _viteShimPid: number | null;
    _viteShimPort: number | null;
    /**
     * Opt-in real-vite mode (Phase 0 spike). Activated when the user sets
     * NIMBUS_REAL_VITE=1 in the shell env or `nimbusDevServer: 'real'` in
     * vite.config.ts. Runs real Vite in a dynamic-worker facet, bypassing
     * the in-process Cirrus shim. Coexists with viteDevServer — only one
     * is live per session.
     */
    cirrusReal: CirrusReal | null;
    /**
     * Map of HMR WebSocket (server-side) → clientId. Populated when the
     * browser's @vite/client opens a connection at /preview/__nimbus_hmr;
     * consumed by the message+close handlers on the WS itself.
     * Non-hibernatable (we use server.accept(), not ctx.acceptWebSocket).
     */
    _cirrusHmrWsClients: Map<WebSocket, string> | null;
    /** file-tree-watch (2026-05-15): per-WS fs-watch subscriptions.
     *  Lazily created on first fs-watch-subscribe by src/session/fs-watch.ts;
     *  cleaned up unconditionally in src/session/ws.ts on wsClose / wsError.
     *  Optional (undefined) until first subscribe so sessions that never
     *  open the file tree carry no watch state. */
    _fsWatchSubs?: Map<WebSocket, import('./fs-watch.js').FsWatchSub[]>;
    nimbusWrangler: NimbusWrangler | null;
    npmInstaller: NpmInstaller | null;
    /** Singleton fetch proxy entrypoint — created once, reused for all npm fetches. */
    fetchProxyEntrypoint: any;
    /**
     * The session's single process owner: PID authority, controlling-
     * terminal input, output rings, and exit records, behind one facade.
     * Every sibling module routes process operations through this field.
     */
    processes: SessionProcessSupervisor;
    portRegistry: PortRegistry;
    /** W1: idempotency flag for the alarm-driven log-janitor bootstrap.
     *  Replaces the pre-W1 `processLogsTimer` setTimeout handle (which
     *  prevented hibernation per CF DO docs). The alarm itself lives in
     *  DO storage at key `w1_next_alarm_reasons`. */
    _w1JanitorArmed: boolean;
    /** Destroyed-session tombstone (SESSION_DESTROYED_KEY), hydrated at boot.
     *  While set, log activity never re-arms the janitor alarm cycle. */
    _w1SessionDestroyed: boolean;
    /**
     * Result of `configureWsHibernation` at constructor time. Exposed via
     * `/api/_diag/memory` under `hib.autoResponseConfigured`,
     * `hib.timeoutSetMs` etc. `null` until the constructor's wiring runs
     * (which it does unconditionally — left null only on a defensive
     * catch-all).
     */
    _w9WsConfig: WsHibernationConfigResult | null;
    /**
     * Monotonic isolate generation counter. Each fresh isolate (cold start
     * or post-hibernation wake) increments this and persists to storage.
     * Lets `/api/_diag/memory` confirm whether a wake actually happened
     * between two probe calls.
     */
    _w9IsolateGen: number;
    /** True once we've persisted the bumped gen counter to storage. */
    _w9IsolateGenPersisted: boolean;
    /** SQL DDL — idempotent; run on first fetch. */
    _w9SchemaInit: boolean;
    /** Have we wired the persist adapter into ProcessLogStore yet? */
    _w9PersistWired: boolean;
    /**
     * Debounced flush state. Append marks the timer; the timer fires
     * after W9_FLUSH_DEBOUNCE_MS and calls `processes.flushLogs()`. We
     * also flush eagerly when `dirtyChunks * pidCount` crosses a threshold
     * — but the debounce handles the steady-state case.
     *
     * S5: storage keys + the debounce constant moved to ./nimbus-session-keys.ts.
     */
    _w9FlushTimer: any;
    /**
     * Peak supervisor heap (rss + heapUsed) seen since process start. Updated
     * by `_diagSampleMemory()` on every call to `/api/_diag/memory`. Used to
     * confirm OOM hypotheses without re-running the failure: a peak that
     * grew toward 128 MB during pre-bundle is direct evidence the supervisor
     * isolate is the one being killed. Survives the lifetime of THIS isolate
     * only — a DO reboot resets it to 0, which is itself a useful signal
     * (peak == 0 immediately after the banner re-printed = the killed
     * isolate took its peak with it).
     */
    _diagPeakRss: number;
    _diagPeakHeapUsed: number;
    _diagPeakAt: number;
    _diagSampleCount: number;
    /**
     * Fix 5: toggled by env NIMBUS_DEBUG=1 (checked each call; cheap enough).
     * When true: spawn banners and exit traces are unconditional (not just
     * long-running facets), RPC envelope errors are surfaced to the terminal
     * with a [rpc-error] prefix, and the exit trace includes duration_ms.
     *
     * The flag is derived from `this.env.NIMBUS_DEBUG` — the binding comes
     * from wrangler's var declaration or a test harness.
     */
    get nimbusDebug(): boolean;
    /**
     * Result of `tryEnableReplicas(this.ctx)` at constructor time. Surfaced
     * via `/api/_diag/memory.replica` so operators can confirm whether the
     * runtime accepted the SPEC API. Stays `null` if the constructor's
     * call ran before this assignment (defensive — should never happen).
     */
    _w12EnableResult: _W12EnableResult | null;
    /**
     * Public URL prefix this DO is mounted at (e.g. `/s/nimble-otter-4271`).
     * Set from the `X-Nimbus-Base` request header on the first forwarded
     * request and persisted so it survives hibernation. Empty string means
     * "unknown" (e.g. direct DO stub call from legacy callers) — in that
     * case ViteDevServer falls back to the bare `/preview` default.
     *
     * NOTE: this is the SESSION prefix, not the vite preview prefix. The
     * full vite basePath is `sessionBasePath + '/preview'`.
     */
    sessionBasePath: string;
    /** Have we attempted to hydrate sessionBasePath from storage yet? */
    sessionBasePathHydrated: boolean;
    /**
     * Has the "wrangler is aliased to nimbus-wrangler" banner been shown
     * this session? Reset on WebSocket close/reopen so a reconnecting user
     * sees it once per terminal attach. Purely cosmetic; no persistence.
     */
    wranglerAliasBannerShown: boolean;
    constructor(ctx: DurableObjectState, env: any);
    _w9WireProcessLogPersist(): void;
    _w9EnsureSchema(): void;
    _w9ScheduleFlush(): void;
    /**
     * W1: multi-reason alarm handler. Routes via a `w1_next_alarm_reasons`
     * storage map managed by `scheduleAlarm` (see ./hibernation.ts).
     * Dispatches every pending reason whose deadline has passed, then
     * re-arms `ctx.storage.setAlarm` at the earliest remaining deadline.
     * Today's reasons: 'w9-flush' (process-log SQL drain) and
     * 'log-janitor' (dropOlderThan sweep). The janitor body needs an
     * orphan-pid predicate so we close over the process supervisor here.
     */
    alarm(): Promise<void>;
    /** W9: increment + persist isolate-gen counter once per fresh isolate. */
    _w9MaybeBumpIsolateGen(): Promise<void>;
    /**
     * Convenience: the full URL prefix for the Vite dev server inside this
     * session (e.g. `/s/nimble-otter-4271/preview`). Falls back to the
     * historical default when sessionBasePath is unknown so legacy callers
     * and unit tests keep working.
     */
    get viteBasePath(): string;
    /**
     * Lazily hydrate sessionBasePath from storage, then overwrite with the
     * current request's `X-Nimbus-Base` header if present. Call at the top
     * of `_handleFetch` before any HTML rendering or ViteDevServer spawn.
     *
     * We always trust the most recent header over storage, because a DO
     * instance is always pinned to one session ID (via idFromName) but the
     * URL prefix COULD change across deploys (e.g. if we ever rename `/s/`).
     */
    hydrateSessionBasePath(request: Request): Promise<void>;
    /**
     * Consume a single-use attach bootstrap token id (`jti`) — set-if-absent.
     * Returns false when the jti was already consumed (replayed attach URL).
     * Atomic per DO semantics: input gates stay closed across the storage
     * get/put, so two concurrent exchanges cannot both observe "absent".
     */
    _rpcConsumeAttachBootstrap(jti: string): Promise<boolean>;
    _rpcReadFile(path: string, pid?: number): Promise<string | null>;
    _rpcReadFileBytes(path: string, pid?: number): Promise<Uint8Array | null>;
    _rpcInnerDoFetch(req: any): Promise<any>;
    _rpcWriteFile(path: string, content: string | Uint8Array, pid?: number): Promise<void>;
    _rpcStat(path: string, pid?: number): Promise<any>;
    _rpcLstat(path: string, pid?: number): Promise<any>;
    _rpcHasLegacySymlinkUnder(path: string, pid?: number): Promise<boolean>;
    _rpcUtimes(path: string, atimeMs: number, mtimeMs: number, pid?: number): Promise<void>;
    _rpcChmod(path: string, mode: number, pid?: number): Promise<void>;
    _rpcAccess(path: string, mode: number, pid?: number): Promise<void>;
    _rpcChown(path: string, uid: number, gid: number, pid?: number, options?: {
        followSymlinks?: boolean;
    }): Promise<void>;
    _rpcSetUmask(mask: number, pid?: number): Promise<number>;
    _rpcReaddir(path: string, pid?: number): Promise<{
        name: string;
        type: string;
    }[]>;
    _rpcExists(path: string, pid?: number): Promise<boolean>;
    _rpcMkdir(path: string, pid?: number): Promise<void>;
    _rpcRmdir(path: string, pid?: number): Promise<void>;
    _rpcRename(from: string, to: string, pid?: number): Promise<void>;
    _rpcReadlink(path: string, pid?: number): Promise<string | null>;
    _rpcSymlink(target: string, path: string, pid?: number): Promise<void>;
    _rpcFsRevision(path?: string, pid?: number): Promise<number>;
    _rpcFsOpen(path: string, flags: any, pid?: number): Promise<any>;
    _rpcFsRead(handleId: number, offset: number | null, length: number, pid?: number): Promise<Uint8Array>;
    _rpcFsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[], pid?: number): Promise<number>;
    _rpcFsClose(handleId: number, pid?: number): Promise<void>;
    _rpcFsReadRange(path: string, offset: number, length: number, pid?: number): Promise<Uint8Array | null>;
    _rpcFsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer | number[], pid?: number): Promise<number>;
    _rpcFsTruncate(path: string, size: number, pid?: number): Promise<void>;
    _rpcHmrRelay(clientId: string | null, msg: string): Promise<void>;
    _rpcUnlink(path: string, pid?: number): Promise<void>;
    _rpcWriteBatch(payload: any, pid?: number): Promise<{
        inodes: number;
        chunks: number;
    }>;
    _rpcWriteBatchStream(stream: ReadableStream<Uint8Array>, mutationOwner?: string, pid?: number): Promise<WriteBatchStreamResult>;
    _rpcPutRegistryEntries(entries: any[]): Promise<{
        written: number;
        failed: number;
    }>;
    _rpcRecordCacheStats(events: any[]): Promise<void>;
    _rpcStdout(pid: number, data: string): Promise<void>;
    _rpcStderr(pid: number, data: string): Promise<void>;
    _rpcReportExit(pid: number, code: number, tail: string): Promise<void>;
    _emitExitDump(pid: number, code: number): void;
    _emitShellExecDone(pid: number, cmd: string, code: number, durationMs: number): void;
    _reportExternalExit(pid: number, code: number, reason: string): void;
    _rpcPrefetch(cwd: string, entryCode: string): Promise<Record<string, string>>;
    _rpcRegisterPort(pid: number, port: number): Promise<void>;
    _rpcUnregisterPort(port: number): Promise<void>;
    _rpcRouteLoopback(port: number, request: Request): Promise<Response>;
    _rpcTransform(code: string, loader: string): Promise<{
        code: string;
        map: string;
    } | null>;
    _rpcFanoutExecute(fnSource: string, args: unknown[], poolOpts?: {
        tag?: string;
        timeoutMs?: number;
        preamble?: string;
        wasmModules?: Record<string, ArrayBuffer>;
        extraBindings?: Record<string, unknown>;
        omitSupervisor?: boolean;
    }): Promise<{
        results: unknown[];
    }>;
    _rpcCpSpawn(req: any): Promise<{
        childPid: number;
    }>;
    _rpcCpStdinWrite(childPid: number, data: string): Promise<{
        ok: boolean;
    }>;
    _rpcCpStdinEnd(childPid: number): Promise<void>;
    _rpcCpReadStdin(childPid: number, waitMs: number): Promise<any>;
    _rpcCpReadOutput(childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number): Promise<any>;
    _rpcCpDrainOutput(childPid: number): Promise<any>;
    _rpcCpKill(childPid: number, signal: string): Promise<boolean>;
    _rpcCpWait(childPid: number, waitMs: number): Promise<any>;
    _rpcCpDispatchInline(req: any, kind: string): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    _rpcReady(options?: _programmatic.ProgrammaticReadyOptions): Promise<{
        ok: true;
        preinstalled: string[];
    }>;
    /** perf(boot): cold placement + constructor probe. First access runs the
     *  DO constructor (placement + blockConcurrencyWhile storage I/O) but this
     *  method does NOT run initSession, so measuring its `rpcMs` against a
     *  full `ready` isolates the platform DO-placement floor from the
     *  initSession build cost. */
    _rpcBootProbe(): Promise<{
        ok: true;
    }>;
    _rpcExec(command: string, options?: _programmatic.ProgrammaticExecOptions): Promise<_programmatic.ProgrammaticExecResult>;
    _rpcStartProcess(command: string, options?: _programmatic.ProgrammaticExecOptions): Promise<_programmatic.ProgrammaticStartResult>;
    _rpcRunCode(code: string, options?: _programmatic.ProgrammaticExecOptions & {
        language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
        install?: 'never' | 'ifMissing';
    }): Promise<_programmatic.ProgrammaticExecResult>;
    _rpcInstallRuntime(spec: string, options?: {
        force?: boolean;
    }): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary>;
    _rpcEnsureRuntimes(specs: string[], options?: {
        force?: boolean;
    }): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary[]>;
    _rpcListRuntimes(): Promise<{
        installed: import("../runtime/package-manager.js").RuntimeSummary[];
        available: {
            name: string;
            abi: import("../runtime/os-contracts.js").RuntimePackageAbi;
            defaultVersion: string;
            versions: Array<{
                version: string;
                sizeBytes: number;
                license: string;
            }>;
        }[];
    }>;
    _rpcListProcesses(): Promise<_programmatic.SerializedProcess[]>;
    _rpcKillProcess(pid: number): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcWriteProcessInput(pid: number, data: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcEndProcessInput(pid: number): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcResizeProcess(pid: number, size: {
        columns: number;
        rows: number;
    }): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcSignalProcess(pid: number, signal: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcProcessLogs(pid: number, options?: {
        cursor?: number;
        lines?: number;
        bytes?: number;
    }): Promise<{
        pid: number;
        chunks: import("../runtime/process-logs.js").SequencedLogChunk[];
        text: string;
        cursor: number;
        truncated: boolean;
        exit: import("../runtime/process-logs.js").ProcessExitInfo | null;
    }>;
    _rpcListPorts(): Promise<_programmatic.SerializedPort[]>;
    _rpcExposePort(port: number): Promise<{
        port: number;
        listening: boolean;
        pid: number | null;
        registeredAt: number | null;
    }>;
    _rpcUnexposePort(port: number): Promise<{
        port: number;
        ok: boolean;
    }>;
    _rpcDeleteFile(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    _rpcDestroy(options?: _programmatic.ProgrammaticDestroyOptions): Promise<_programmatic.ProgrammaticDestroyResult>;
    vfsReadFile(path: string): ArrayBuffer | null;
    vfsReadFileString(path: string): string | null;
    vfsStat(path: string): {
        type: string;
        size: number;
        atime: number;
        ctime: number;
        mtime: number;
        mode: number;
    } | null;
    vfsExists(path: string): boolean;
    vfsReaddir(path: string): {
        name: string;
        type: string;
    }[];
    vfsWriteFile(path: string, data: ArrayBuffer): void;
    fetch(request: Request): Promise<Response>;
    _handleFetch(request: Request): Promise<Response>;
    /**
     * Read process.memoryUsage() if nodejs_compat exposes it. Returns null
     * on environments where the binding is absent (older compat dates,
     * non-Workers test harnesses). Never throws — heap probes must be
     * fault-tolerant so a probe that fails in prod doesn't take the
     * request handler down with it.
     */
    getReplicaState(): {
        state: string;
        error: string | null;
        isReplica: boolean;
        bookmark: string | null;
        suspended: boolean;
    };
    _diagReadNodeMem(): {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    } | null;
    _diagReadPerfMem(): {
        jsHeapSizeLimit: number;
        totalJSHeapSize: number;
        usedJSHeapSize: number;
    } | null;
    _diagSampleMemory(): void;
    ensureSqliteFs(): void;
    /** Track when we last persisted to avoid redundant writes. */
    _w5LastPersistAt: number;
    /** Track ring size at last persist; skip write if unchanged. */
    _w5LastPersistRingSize: number;
    /** B'.4 — live initSession phase. Surfaced via
     *  /api/_diag/session.phase. null pre-first-init. */
    _b4Phase: import('../observability/oom-discriminator.js').SessionState | null;
    /** B'.5 — count of warm-rejoin /ws upgrades. Increments each
     *  time the join path is taken (Phase B skipped). 0 means no
     *  warm rejoins yet. Surfaced via /api/_diag/session.warmJoinCount. */
    _b4WarmJoinCount: number;
    _w5RehydrateRingFromStorage(): Promise<void>;
    /** Snapshot + persist OOM ring. Delegator → ./nimbus-session-diag.ts (S10). */
    _w5PersistRing(): Promise<void> | null;
    ensureFacetManager(): void;
    /**
     * W8: lazily construct the FacetProcessManager when the first cp* RPC
     * arrives. Wired with adapters that bridge the Nimbus shell command
     * registry to the FacetProcessManager's CommandRegistryLike contract.
     */
    _ensureFacetProcessManager(): any;
    /**
     * Set the shell command registry for the W8 broker to dispatch
     * resolved commands. Called from the shell-init path right after
     * `registerUnixCommands(registry, sqliteFs)`.
     */
    _cpRegistry: any;
    _setCpRegistry(r: any): void;
    /**
     * Get or create the singleton fetch proxy entrypoint.
     * ONE dynamic worker is created via LOADER.load() and reused for ALL npm
     * fetch calls across the lifetime of this DO instance. This prevents
     * ephemeral port exhaustion from creating a new worker per fetch.
     */
    ensureFetchProxy(log?: (msg: string) => void): any | null;
    /**
     * Build a FetchFn that routes through the singleton proxy entrypoint.
     * All concurrent fetches share ONE worker — no port exhaustion.
     */
    buildFetchFn(log?: (msg: string) => void): ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    ensureNpmInstaller(onProgress?: (msg: string) => void): void;
    /**
     * Read an environment flag with default-on semantics. Mirrors the
     * shouldUseFacetPool / shouldUseFacetResolver / shouldUseBatchFacet
     * gates inside NpmInstaller — kept here as a private helper so the
     * lazy-proxy decision uses identical semantics without leaking that
     * private API across modules.
     */
    _envFlagDefaultOn(name: string): boolean;
    initSession(ws: WebSocket): void;
    seedFilesystem(): void;
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean): Promise<void>;
    webSocketError(ws: WebSocket, error?: any): Promise<void>;
    /** W9: synchronous flush on close. Delegator → ./nimbus-session-hib.ts (S4). */
    _w9FlushOnClose(): void;
    /** W5: bridge _w5PersistRing → ctx.waitUntil. Delegator → ./nimbus-session-ws.ts (S7). */
    _w5SafePersistRing(): void;
}
export { NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub, } from './bindings.js';
//# sourceMappingURL=nimbus-session.d.ts.map