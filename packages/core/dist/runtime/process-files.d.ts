/**
 * ProcessFiles: what binds the session's namespace to its processes.
 *
 * The namespace is a CompositeVFS rooted at the session's SQLite
 * filesystem, with `/proc` (ProcVFS) and `/dev` (DevVFS) mounted, and
 * whatever an embedder mounts. ProcessFiles owns the per-process state on
 * top of it: a descriptor scope per pid, retirement (`releaseProcess` →
 * ESTALE for later binds), append-writer capabilities, host leases, and the
 * mount listing df/mount/`/proc/mounts` read. Each bound bridge routes a
 * path the composite resolves to a mount other than `/` through the
 * composite, and everything on SQLite through the engine, which keeps its
 * receipts, leases and descriptors.
 *
 * It implements the process-binding contract (NimbusFilesystemAuthority),
 * which every consumer (supervisor RPC, facets, runners) already speaks.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { CompositeVFS } from '../vfs/composite.js';
import { ProcVFS } from '../vfs/proc-vfs.js';
import { type NimbusFilesystemAuthority, type NimbusFilesystemBinding, type NimbusHostFilesystemLease, type NimbusMountEntry, type RuntimeFsBridge, type VfsCred } from './os-contracts.js';
/** The session's namespace and the processes bound to it. */
export declare class ProcessFiles implements NimbusFilesystemAuthority {
    readonly engine: SqliteVFS;
    readonly namespace: string;
    /** The mount table: SQLite at `/`, `/proc`, `/dev`, and the embedder's. */
    readonly vfs: CompositeVFS;
    /** `/proc`: the host registers generated files here (`mounts` is ProcessFiles'). */
    readonly proc: ProcVFS;
    private readonly processes;
    private readonly retired;
    /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
    private readonly mountedInos;
    private readonly mountedIno;
    constructor(engine: SqliteVFS);
    bind({ pid, cred, signal }: NimbusFilesystemBinding): RuntimeFsBridge;
    openHost(cred: Readonly<VfsCred>, options?: {
        signal?: AbortSignal;
    }): NimbusHostFilesystemLease;
    /** Host work over a credentialed lease released when the work settles. */
    withHost<T>(cred: Readonly<VfsCred>, use: (fs: RuntimeFsBridge) => Promise<T>): Promise<T>;
    releaseProcess(pid: number): Promise<void>;
    activateAppendWriter(pid: number, writerId: string): Promise<void>;
    revokeAppendWriter(pid: number, writerId: string): Promise<void>;
    revokeAppendWriters(pid: number): Promise<void>;
    revokeAppendWritersThrough(maxPid: number): Promise<void>;
    /** The mounts `cred` sees, root first: what df, mount and `/proc/mounts` list. */
    mounts(cred: Readonly<VfsCred>): readonly NimbusMountEntry[];
    private closeScope;
    private view;
}
//# sourceMappingURL=process-files.d.ts.map