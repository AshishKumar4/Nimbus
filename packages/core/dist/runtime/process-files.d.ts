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
import type { VFS, VfsDirent, VfsRemoval, VfsStat } from '../vfs/vfs.js';
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
    /**
     * What a command sees: the namespace as `cred`, through this process's
     * bridge, so every mutation passes the lease check (EBUSY on another
     * owner's lease) and every path is routed as the process's own syscalls are.
     */
    view(binding: NimbusFilesystemBinding): ProcessView;
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
    private bridgeFor;
}
/** POSIX access(2) modes. */
export declare const F_OK = 0, X_OK = 1, W_OK = 2, R_OK = 4;
/**
 * A process's namespace as a `VFS` over its bound bridge, plus the process
 * syscalls a `VFS` has no word for (access, realpath, append). Absent is
 * null from `stat`; every failure is a `VfsError`.
 */
export declare class ProcessView implements VFS {
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    readonly process: RuntimeFsBridge;
    constructor(
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    process: RuntimeFsBridge);
    private call;
    stat(path: string, options?: {
        follow?: boolean;
    }): Promise<VfsStat | null>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
    }): Promise<void>;
    readdir(path: string): Promise<VfsDirent[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    /** A ranged read that neither consults nor fills the session's content cache. */
    readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array>;
    writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    /**
     * rm -r: what went, by the roots removed, what is still there, and why.
     * The engine removes a tree in one step or refuses it whole, so its report
     * is the operand or the refusal.
     */
    removeRecursive(path: string): Promise<VfsRemoval>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
    utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
    /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
    copy(from: string, to: string, options?: {
        recursive?: boolean;
        preserve?: boolean;
    }): Promise<number>;
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    access(path: string, mode: number): Promise<void>;
    realpath(path: string): Promise<string>;
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    appendFile(path: string, data: Uint8Array): Promise<void>;
}
//# sourceMappingURL=process-files.d.ts.map