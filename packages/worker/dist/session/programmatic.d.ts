import { type MinShellRegistry } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import type { ProcessLogReadOptions } from '@nimbus-sh/core/runtime/process-logs.js';
import { type TerminalLike } from '../runtime/process-logs-api.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { ComposedFacetManager } from '../facets/compose.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type SessionReadyOptions, type SessionExecOptions, type SessionRunCodeOptions, type SessionDestroyOptions, type SessionDestroyResult, type SessionStartResult, type SessionProcess, type SessionPort, type SessionExposedApp, type SessionApp, type SessionAppTarget, type SessionExposeOptions, type SessionDurableAppOptions, type SessionTerminalSize, type SessionRuntimeInstallOptions, type SessionResult } from '@nimbus-sh/core/runtime/session-protocol.js';
import { type PortVisibility } from './port-capability.js';
import type { LongRunningWorkerSpawnOptions, ResidentAppSummary, ResidentIdentity, SpawnedWorker } from '../facets/manager.js';
import { type GenerationContext } from '@nimbus-sh/fabric/generation.js';
import { type TimerHost } from '@nimbus-sh/fabric/timers.js';
import { type NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { type ExecOutput, type ExecStream } from '@nimbus-sh/core/runtime/exec-stream.js';
import type { RuntimeManager } from '@nimbus-sh/core/runtime/runtime-manager.js';
export interface ProgrammaticShell {
    getEnv(): Record<string, string>;
}
type ProgrammaticContext = DurableObjectState;
interface ProgrammaticFacetManager {
    kill(pid: number): boolean;
    hasResidentProcess(pid: number): boolean;
    removeDurableApp(owner: string): Promise<boolean>;
    residentIdentity(pid: number): Promise<ResidentIdentity | null>;
    listResidentApps(): Promise<ResidentAppSummary[]>;
    spawnWorker(workerCode: string, command: string, cwd: string, opts?: LongRunningWorkerSpawnOptions): Promise<SpawnedWorker>;
}
interface ProgrammaticViteServer {
    isRunning: boolean;
    stop(): void;
}
interface ProgrammaticCirrusServer {
    isRunning: boolean;
    stop(ctx: ProgrammaticContext): void;
}
export interface ProgrammaticHost extends TimerHost {
    readonly runtimeManager: RuntimeManager;
    ensureRuntimeReady(): Promise<void>;
    _w1SessionDestroyed: boolean;
    /** The log-janitor deadline this instance armed (hibernation.ts armLogJanitor), or null. */
    _w1JanitorAt: number | null;
    env: RuntimeCatalogEnv;
    ctx: ProgrammaticContext;
    /**
     * Whose shells every call runs in, one of its own or a named one (see
     * `withShellState`). Composed over this host's `processes`.
     */
    readonly runtimeWorkspace: NimbusWorkspace | null;
    shell: ProgrammaticShell | null;
    shellProcessPid: number | null;
    sqliteFs: SqliteVFS | null;
    processes: SessionProcessSupervisor;
    portRegistry: PortRegistry;
    facetManagerComposed: ComposedFacetManager | null;
    facetManager: ProgrammaticFacetManager | null;
    viteDevServer: ProgrammaticViteServer | null;
    cirrusReal: ProgrammaticCirrusServer | null;
    _cpRegistry: MinShellRegistry | null;
    /** Named shells this object's storage held before they were the workspace's, once adopted. See `withShellState`. */
    _storedShellsAdopted?: Promise<void>;
    _viteShimPid: number | null;
    _viteShimPort: number | null;
    _cirrusHmrWsClients?: {
        clear(): void;
    } | null;
    terminal?: (TerminalLike & {
        write(text: string): void;
        close(): void;
    }) | null;
    kernel?: unknown;
    facetProcessManager?: unknown;
    esbuildService?: unknown;
    /** The session's esbuild facet pool; torn down with the installer and dev server. */
    bundlePool?: {
        dispose(): void;
    } | null;
    nimbusWrangler?: unknown;
    npmInstaller?: unknown;
    _supervisorOps?: {
        forget(pid: number): void;
    } | null;
    sessionBasePath?: string;
    sessionBasePathHydrated?: boolean;
    /** The origin the session was last reached at — what a path-form URL is built on. */
    sessionOrigin?: string;
    wranglerAliasBannerShown?: boolean;
    _b4Phase?: string | null;
    _w9PersistWired?: boolean;
    _w9FlushTimer?: ReturnType<typeof setTimeout> | null;
    _w9SchemaInit?: boolean;
    _w9WireProcessLogPersist?(): void;
    ensureSqliteFs(): void;
    ensureFacetManager(): ComposedFacetManager;
}
export declare function ensureProgrammaticReady(self: ProgrammaticHost, options?: SessionReadyOptions): Promise<SessionResult<'ready'>>;
/** Buffered exec: the exec stream collected into strings by the caller of this function. */
export declare function rpcExec(self: ProgrammaticHost, command: string, options?: SessionExecOptions): Promise<ExecOutput>;
/**
 * Run a command and hand back its output as it is written. Resolves once the
 * command has started (after any earlier call on the same named shell);
 * validation and readiness failures reject here, not on the stream.
 */
export declare function rpcExecStream(self: ProgrammaticHost, command: string, options?: SessionExecOptions): Promise<ExecStream>;
/**
 * Start a command in the background and return its handle immediately.
 *
 * The command runs for as long as it needs to: the session holds its work
 * open through `ctx.waitUntil`, the same contract a long-running facet uses.
 * Status, incremental output, and termination are read back through the
 * process surface (`listProcesses`, `processLogs`, `killProcess`).
 */
export declare function rpcStartProcess(self: ProgrammaticHost, command: string, options?: SessionExecOptions): Promise<SessionStartResult>;
export declare function rpcRunCode(self: ProgrammaticHost, code: string, options?: SessionRunCodeOptions): Promise<ExecOutput>;
export declare function rpcInstallRuntime(self: ProgrammaticHost, spec: string, options?: SessionRuntimeInstallOptions): Promise<{
    spec: string;
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export declare function rpcEnsureRuntimes(self: ProgrammaticHost, specs: string[], options?: SessionRuntimeInstallOptions): Promise<{
    spec: string;
    exitCode: number;
    stdout: string;
    stderr: string;
}[]>;
export declare function rpcListRuntimes(self: ProgrammaticHost): Promise<SessionResult<'listRuntimes'>>;
export declare function rpcListProcesses(self: ProgrammaticHost): Promise<SessionProcess[]>;
export declare function rpcKillProcess(self: ProgrammaticHost, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcWriteProcessInput(self: ProgrammaticHost, pid: number, data: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcEndProcessInput(self: ProgrammaticHost, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcResizeProcess(self: ProgrammaticHost, pid: number, size: SessionTerminalSize): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcSignalProcess(self: ProgrammaticHost, pid: number, signal: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcProcessLogs(self: ProgrammaticHost, pid: number, options?: ProcessLogReadOptions): Promise<{
    pid: number;
    chunks: {
        seq: number;
        ts: number;
        stream: "stdout" | "stderr";
        data: string;
        binary?: boolean | undefined;
    }[];
    text: string;
    cursor: number;
    truncated: boolean;
    exit: {
        code: number;
        at: number;
        reason?: string | undefined;
    } | null;
}>;
export declare function rpcListPorts(self: ProgrammaticHost): Promise<SessionPort[]>;
/**
 * Browser-facing URL for an application, built inside the session: the
 * host form when the deployment carries a preview suffix (name first, port
 * otherwise; the public bearer form when public and a capability exists),
 * else the path form on the origin the session was last reached at. Null
 * when the session has never been reached over HTTP and has no suffix —
 * an embedder builds its own from the port and capability in that case.
 */
export declare function appUrl(self: ProgrammaticHost, app: {
    port: number;
    name?: string | null;
    capability?: string | null;
    visibility?: PortVisibility;
}): string | null;
/**
 * The port-centric surface, kept for every caller that has a port and
 * nothing else — a dev server or a process outside the
 * resident lifecycle. When the port's occupant carries an identity the
 * exposure is the same lazy reservation `apps.expose` makes; when it does
 * not, this compatibility path writes the row port-only, as before. One implementation:
 * `applyExposure` below.
 */
export declare function rpcExposePort(self: ProgrammaticHost, port: number, options?: SessionExposeOptions): Promise<{
    execId?: string;
    port: number;
    listening: boolean;
    pid: number | null;
    registeredAt: number | null;
    capability: string | null;
    visibility: "scoped" | "public";
    owner: string | null;
    name: string | null;
}>;
/**
 * The identity-centric surface: the target names a running application —
 * by port, by pid, or by name — and the exposure is what makes it durable
 * under its identity: the port is reserved for the owner lazily, the
 * capability minted when public and bound in the directory, the name
 * stored on the reservation. Returns the address the caller can reach.
 */
export declare function rpcExposeApp(self: ProgrammaticHost, target: SessionAppTarget, options?: SessionExposeOptions): Promise<SessionExposedApp>;
/**
 * Mint a new capability for the application and rebind the directory:
 * every URL built on the old one stops resolving. The registry adopts the
 * new value at once if the port is live, so the new URL answers without
 * waiting for a restore.
 */
export declare function rpcRotateLink(self: ProgrammaticHost, target: SessionAppTarget): Promise<SessionExposedApp>;
/** Every stamped identity, with the URL each is reachable at. */
export declare function rpcListApps(self: ProgrammaticHost): Promise<SessionApp[]>;
/**
 * End an application: kill its live pids, release the reservation, purge
 * its journal rows, free the durable slot and its storage, unbind the
 * directory — `removeDurableApp`, addressed by any target.
 */
export declare function rpcRemoveApp(self: ProgrammaticHost, target: SessionAppTarget): Promise<{
    removed: boolean;
    owner: string;
    port: number | null;
}>;
/**
 * The embedder's durable-application seam: reserve (or re-answer) the port
 * `owner` holds, minting the capability the application's public URL is
 * built on — minted HERE, stored on the reservation, so a URL handed out
 * before the application has ever booted is the one its eventual binding
 * re-adopts, and the one a reset re-adopts again. Answers the port, the
 * capability, and the record's visibility.
 */
export declare function rpcEnsureDurableApp(self: ProgrammaticHost, input: SessionDurableAppOptions): Promise<{
    port: number;
    capability: string | null;
    visibility: PortVisibility;
}>;
export declare function rpcUnexposePort(self: ProgrammaticHost, port: number): Promise<{
    port: number;
    ok: boolean;
}>;
/**
 * End a durable application's contract. The reservation's port is read first
 * so the caller learns which durable address was released; the manager then
 * kills every launch the owner claims, purges its journal rows, releases the
 * port, and frees the durable slot. `removed` is false only when no durable
 * application held that owner at all.
 */
export declare function rpcRemoveDurableApp(self: ProgrammaticHost, owner: string): Promise<{
    owner: string;
    removed: boolean;
    port: number | null;
}>;
/**
 * `spawnWorker` for a colocated embedder holding the DO stub: boot the
 * embedder's own Worker-class program — its main module, inline modules and
 * content-addressed text/wasm modules — as one of this session's resident
 * processes, and answer with the pid, the runner's boot payload and the
 * process's facet (`fetch`/`connect`, bound to the resident handle; no
 * release — `killProcess(pid)` ends it). Deliberately absent from the remote
 * HTTP dispatcher: the facet is a live handle, and a remote token holder is
 * not the embedder.
 */
export declare function rpcSpawnWorker(self: ProgrammaticHost, workerCode: string, command: string, cwd: string, opts?: LongRunningWorkerSpawnOptions): Promise<SpawnedWorker>;
/**
 * `files.delete`. Absent a `cred` this acts as CRED_KERNEL — what it has
 * always done, and the embedder's trusted surface: only a caller holding the
 * DO binding reaches it. A `cred` binds the removal to that identity instead,
 * the same view `SqliteVFS.as(cred)` gives in-process.
 */
export declare function rpcDeleteFile(self: ProgrammaticHost, path: string, options?: {
    recursive?: boolean;
}, cred?: VfsCred): Promise<void>;
export declare function rpcDestroy(self: ProgrammaticHost, options?: SessionDestroyOptions): Promise<SessionDestroyResult>;
/**
 * A session's process supervisor: the one way one is made, so each is
 * wired to raise the persisted generation when its pids reach the next
 * stride (pids never repeat across incarnations). It mints no pid before
 * reserveSessionProcesses gives it its range.
 */
export declare function sessionProcesses(ctx: GenerationContext): SessionProcessSupervisor;
/**
 * Give `processes` (made by sessionProcesses) this incarnation's pid range:
 * its generation durably reserved first (adoptGeneration: persisted past
 * every one before it, and past every pid this context minted), then its
 * pids start past that. The one way a live supervisor gets its range: at
 * boot and at a destroy's recreate.
 */
export declare function reserveSessionProcesses(ctx: GenerationContext, processes: SessionProcessSupervisor): Promise<SessionProcessSupervisor>;
export {};
//# sourceMappingURL=programmatic.d.ts.map