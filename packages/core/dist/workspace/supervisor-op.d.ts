import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { type VfsCred } from '../runtime/os-contracts.js';
import { SqliteRuntimeFsBridge } from '../runtime/sqlite-runtime-fs-bridge.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
/**
 * Identity comes from the supervisor binding, never from facet arguments: a
 * process's `pid` is stamped by SupervisorRPC from its own props. A HOST call
 * — no pid — acts as the unprivileged session user unless it names a `cred`,
 * which only a caller already trusted with the filesystem can do: the SDK over
 * the DO binding, an embedder composing the workspace. A pid and a cred
 * together are refused, so a process can never widen its own identity.
 */
export interface SupervisorOpEnvelope {
    readonly op: SupervisorOpName;
    readonly args?: readonly unknown[];
    readonly pid?: number;
    /** A host call's credential. Meaningless — and refused — with a pid. */
    readonly cred?: VfsCred;
    readonly writerId?: string;
    readonly mutationOwner?: string;
    readonly stream?: ReadableStream<Uint8Array>;
}
export type SupervisorOpHandler = (envelope: SupervisorOpEnvelope, tools: SupervisorOpTools) => unknown;
export interface SupervisorOpDeps {
    readonly vfs: SqliteVFS;
    /** Absent a process table, operations use the unprivileged session user. */
    readonly processes?: SessionProcessSupervisor;
    readonly output?: (stream: 'stdout' | 'stderr', pid: number, data: string) => void;
    /**
     * The host's `_rpc*` surface for ops beyond the native set — an in-process
     * workspace's dispatch record, or the session itself for
     * `sessionSupervisorOps`. A native op never consults it.
     */
    readonly host?: SupervisorOpHost;
    /**
     * A pid-keyed bridge cache to serve the native ops from. Supplied by the
     * session so `supervisorBridge` hands callers the same bridges the handler
     * uses; in-process workspaces let the handler build its own.
     */
    readonly bridge?: SupervisorOpBridgeStore;
    readonly extend?: Partial<Record<SupervisorOpName, SupervisorOpHandler>>;
}
/**
 * One slot in an op's argument plan: a number takes `envelope.args[n]`, a
 * name takes the envelope's identity field (`pid`, `writerId`, `stream`,
 * `mutationOwner`). The envelope is always the shape — a host never
 * re-parses it.
 */
export type SupervisorOpArg = number | 'pid' | 'writerId' | 'stream' | 'mutationOwner';
export interface SupervisorOpRoute {
    /** The host method this op dispatches to. */
    readonly method: string;
    /** Positional plan for the host call — envelope fields, not raw args. */
    readonly args: readonly SupervisorOpArg[];
}
/**
 * The embedder's dispatch surface — the `_rpc*` methods SUPERVISOR_OP_ROUTES
 * names. The session satisfies it with its own class; an in-process
 * workspace supplies its host object.
 */
export interface SupervisorOpHost {
    readonly [method: string]: unknown;
}
/**
 * The canonical supervisor op set — every operation the supervisor RPC
 * serves. Three consumers key on these names:
 *
 *   - `sessionSupervisorOp` (worker): the DO's host — `extend` overrides for
 *     hosted accounting plus the non-filesystem ops it answers itself.
 *   - `createSupervisorOpHandler`: an in-process workspace — filesystem ops
 *     run against the VFS directly; every other op dispatches to
 *     `deps.host` through SUPERVISOR_OP_ROUTES, the embedder's `_rpc*`
 *     surface.
 *   - `supervisor-host-dispatch`: the test — derives every case's delegate
 *     and expected arguments from SUPERVISOR_OP_ROUTES, not a copied list.
 *
 * An op absent here is not served, on any host.
 */
export declare const SUPERVISOR_OPS: readonly ["readFile", "readFileBytes", "writeFile", "stat", "lstat", "hasLegacySymlinkUnder", "utimes", "chmod", "access", "chown", "setUmask", "readdir", "exists", "mkdir", "rmdir", "rename", "unlink", "readlink", "symlink", "fsAcquire", "fsRevision", "fsList", "wsOpen", "wsPoll", "wsSend", "wsClose", "fsOpen", "fsRead", "fsWrite", "fsClose", "fsReadRange", "fsReadRangeUncached", "fsReadBatch", "fsWriteRange", "fsAppend", "fsAppendAck", "fsTruncate", "writeBatch", "writeBatchStream", "putRegistryEntries", "stdout", "stderr", "prefetch", "registerPort", "unregisterPort", "reportExit", "routeLoopback", "transform", "cpSpawn", "cpStdinWrite", "cpStdinEnd", "cpReadStdin", "cpReadOutput", "cpDrainOutput", "cpKill", "cpWait", "cpDispatchInline"];
export type SupervisorOpName = (typeof SUPERVISOR_OPS)[number];
/**
 * What the shared handler hands a host override: the pid-keyed bridge and
 * the deps it was built with, so an override that wraps a filesystem op
 * (read-allocation accounting, stream-drain timing) reuses the same bridge
 * the default handler would have used instead of caching its own.
 */
export interface SupervisorOpTools {
    readonly bridge: (pid?: number, cred?: VfsCred) => SqliteRuntimeFsBridge;
    readonly vfs: SqliteVFS;
    readonly cred: (pid?: number, cred?: VfsCred) => VfsCred;
    readonly output?: (stream: 'stdout' | 'stderr', pid: number, data: string) => void;
}
/** The host-side argument plan per op — how an envelope becomes an _rpc* call. */
export declare const SUPERVISOR_OP_ROUTES: Readonly<Record<SupervisorOpName, SupervisorOpRoute>>;
/**
 * The ops `createSupervisorOpHandler` serves natively — one pid-keyed
 * filesystem bridge, plus the output stream. A session's `extend` overrides
 * never cover these by accident: `sessionSupervisorOps` builds its delegate
 * set from this name list, not a hand-copied table.
 */
export declare const SUPERVISOR_NATIVE_OPS: ReadonlySet<string>;
/** The pid-keyed bridge cache behind the native filesystem ops. */
export interface SupervisorOpBridgeStore {
    /**
     * The bridge for a pid (cached per pid; the host's under key 0), or — for
     * a host call naming a `cred` — a bridge bound to that credential and to
     * nothing else. Never cached: the host's shared bridge has its credential
     * swapped on every use, and two credentialed host calls interleaving
     * across an await would otherwise read as each other.
     */
    readonly bridge: (pid?: number, cred?: VfsCred) => SqliteRuntimeFsBridge;
    /** Drop a pid's bridge — a process exit ends its credential's validity. */
    readonly forget: (pid: number) => void;
}
/**
 * Exported so the session's `supervisorBridge` — used by RPC bodies the
 * envelope delegates back to (fsOpen, fsAppend, writeBatch, …) — is the
 * same cache the handler's native ops serve from, never a second one.
 */
export declare function createSupervisorBridgeStore(deps: Pick<SupervisorOpDeps, 'vfs' | 'processes'>): SupervisorOpBridgeStore;
/** One dispatch method lets any host serve its workspace to process facets. */
export declare function createSupervisorOpHandler(deps: SupervisorOpDeps): (envelope: SupervisorOpEnvelope) => Promise<unknown>;
//# sourceMappingURL=supervisor-op.d.ts.map