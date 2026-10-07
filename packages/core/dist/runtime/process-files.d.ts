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
import type { SqliteVFS, VfsExportChunk, VfsExportPage } from '../vfs/sqlite-vfs.js';
import { Hydrator, type HydratorOptions } from './hydration.js';
import { Delegations, type DelegationRevoked } from './delegations.js';
import { CompositeVFS } from '../vfs/composite.js';
import { ProcVFS } from '../vfs/proc-vfs.js';
import type { VFS, VfsDirent, VfsRemoval, VfsStat } from '../vfs/vfs.js';
import { type NimbusFilesystemAuthority, type NimbusFilesystemBinding, type NimbusHostFilesystemLease, type NimbusMountEntry, type RuntimeFsBridge, type RuntimeSynchronousFs, type RuntimeVfsDirEntry, type RuntimeVfsStat, type VfsCred } from './os-contracts.js';
/** The session's namespace and the processes bound to it. */
export declare class ProcessFiles implements NimbusFilesystemAuthority {
    readonly engine: SqliteVFS;
    readonly namespace: string;
    /** The mount table: SQLite at `/`, `/proc`, `/dev`, and the embedder's. */
    readonly vfs: CompositeVFS;
    /** `/proc`: the host registers generated files here (`mounts` is ProcessFiles'). */
    readonly proc: ProcVFS;
    private readonly processes;
    /** Each scope's descriptors on asynchronous mounts: a process's, whichever bridge it binds per call. */
    private readonly awaitedDescriptors;
    private readonly namespaces;
    private readonly retired;
    /** Per process: where its listings of the mounts beyond SQLite stand (MountListing). */
    private readonly listings;
    /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
    /** N17: the lazy-import hydration job, when the embedder supplies a fetch. */
    readonly hydrator: Hydrator | null;
    /** Subtrees delegated to processes (Delegations): each recalled through its holder's bridge. */
    readonly delegations: Delegations;
    /** Bytes one buffered mount handle holds before EFBIG (VFS-PF-001). */
    private readonly bufferedWriteBytes;
    constructor(engine: SqliteVFS, options?: {
        hydration?: HydratorOptions;
        bufferedWriteBytes?: number;
        /** Told of a delegation's holder revoked for not answering a recall in time: the host stops it. */
        delegationRevoked?: (event: DelegationRevoked) => void;
        /** Told of a delegation's holder that ended still holding it (Delegations' orphaned): what it had not sent there is lost. */
        delegationOrphaned?: (event: {
            readonly pid: number;
            readonly root: string;
        }) => void;
        delegationRecallTimeoutMs?: number;
    });
    /**
     * An import page (N16); with `lazy` (N17) the chunks it lacks stay pending
     * and are queued for hydration, in the order the page names them.
     */
    importPage(dst: string, page: VfsExportPage, chunks?: Iterable<VfsExportChunk>, options?: {
        lazy?: boolean;
    }): {
        imported: number;
        want: string[];
        done: boolean;
        pending: string[];
    };
    /**
     * N17: a launch that reads synchronously (WASI) waits for the paths it
     * names (program, argv paths, a cwd inside an import) to be local, at most
     * the hydration deadline; EIO naming the first that is not, after it. A
     * launch naming nothing pending starts at once.
     */
    /** Resolves once `path`'s bytes are hydrated (at once, for a path with none pending). */
    hydrated(path: string): Promise<void>;
    gateLaunch(named: readonly string[]): Promise<void>;
    /**
     * What a process's launch names — its working directory, program and
     * arguments, the literal paths its code names, the files its module map
     * was read from — which is where its listing (`list`) walks mounts without
     * a change feed (CompositeFeed.walk, MOUNT_LIST_NAME_LIMIT). `names` is
     * asked only when the process's credential sees a mount beyond SQLite and
     * the kernel's, so a launch computes nothing for a namespace that is
     * SQLite alone. Adds to what was named.
     */
    nameLaunch({ pid, cred }: NimbusFilesystemBinding, names: () => Iterable<string>): void;
    /** Where `pid`'s listings of the mounts beyond SQLite stand (made when `create`), or undefined. */
    private listingOf;
    private createListing;
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
    /**
     * The namespace as `cred`, synchronously, for host code that reads user
     * paths in one turn (git, the build services, vite's file shim, agent
     * tools). Mounted paths route to their mount (a mount without a
     * synchronous face answers ENOTSUP) and SQLite paths go to the engine,
     * exactly as a process's syscalls do. One per credential for the session.
     */
    namespaceFs(cred: Readonly<VfsCred>): NamespaceFs;
    /** Host work over a credentialed lease released when the work settles. */
    withHost<T>(cred: Readonly<VfsCred>, use: (fs: RuntimeFsBridge) => Promise<T>): Promise<T>;
    releaseProcess(pid: number): Promise<void>;
    /** See NimbusFilesystemAuthority.rewindProcess. */
    rewindProcess(pid: number): Promise<void>;
    /**
     * The process died without closing its descriptors: nothing is flushed,
     * and what that loses is reported, the descriptors whose buffered writes
     * are gone. Later use of its descriptors is EBADF, as after a release.
     */
    killProcess(pid: number): {
        lost: number[];
    };
    /** The mounts `cred` sees, root first: what df, mount and `/proc/mounts` list. */
    mounts(cred: Readonly<VfsCred>): readonly NimbusMountEntry[];
    /**
     * Closes `scope` for good: every descriptor (each last close flushing),
     * its subscriptions, and the scope itself (EBADF from then on, for every
     * bridge on it). A flush that fails (an aborted binding's, a mount's
     * refusal) loses its bytes and is reported after the scope is closed.
     */
    private closeScope;
    private bridgeFor;
}
/** A command's view for a process binding, over any binding authority. */
export declare function bindProcessView(authority: NimbusFilesystemAuthority, binding: NimbusFilesystemBinding): ProcessView;
/** Host-side work through a credentialed view whose lease is released when the work settles. */
export declare function withHostView<T>(authority: NimbusFilesystemAuthority, cred: Readonly<VfsCred>, use: (view: ProcessView) => Promise<T>): Promise<T>;
/**
 * Where `path` is on `engine`, as `view` sees the namespace: its engine key
 * with every link resolved, or null when it is on a mount. A name not there
 * yet is placed by the nearest directory above it that is, where it would
 * be made. Host tools read and write a user's tree through `view`; they
 * take the engine's bulk paths (batched writes, pre-bundling, the dev
 * servers) only at this key, never at a lexical path a mount may shadow.
 */
export declare function engineKey(view: Pick<ProcessView, 'realpath' | 'stat'>, engine: Pick<SqliteVFS, 'deviceId'>, path: string): Promise<string | null>;
/** POSIX access(2) modes. */
export declare const F_OK = 0, X_OK = 1, W_OK = 2, R_OK = 4;
export declare class ProcessView implements VFS {
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    readonly process: RuntimeFsBridge;
    /** The bridge as this view calls it: each call made again once a delegation it meets is recalled. */
    private readonly fs;
    constructor(
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    process: RuntimeFsBridge);
    /** `run`, a bridge failure reported as Node's error for `syscall` on `path` (and `dest`). */
    private call;
    stat(path: string, options?: {
        follow?: boolean;
    }): Promise<ProcessStat | null>;
    /** Probes need only the bridge's type, not another converted stat object. */
    private probe;
    /** Whether anything is at `path` (links followed). */
    exists(path: string): Promise<boolean>;
    isFile(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    /** Whether `path` itself is a symbolic link. */
    isSymlink(path: string): Promise<boolean>;
    /** The file's bytes as UTF-8 text. */
    readFileString(path: string): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    /**
     * Text is written as UTF-8, as a process's write(2) of a string would.
     * `mode` applies only if this creates the file, and at creation
     * (open(O_CREAT|O_TRUNC, mode), then the bytes): an existing file keeps its
     * mode, and a new one is never visible at another mode.
     */
    writeFile(path: string, data: Uint8Array | string, options?: {
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
    /** writeFile of `size` bytes that arrive over time, published whole once they have (RuntimeFsBridge.writeFileFrom). */
    writeFileFrom(path: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    /**
     * rm -r: what went, by the roots removed, what is still there, and why.
     * The engine removes a tree in one step or refuses it whole, so its report
     * is the operand or the refusal.
     */
    removeRecursive(path: string): Promise<VfsRemoval>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    /** Where the link at `path`, reading `link`, leads in this namespace (RuntimeFsBridge.linkLeadsTo), for a caller following it itself. */
    linkLeadsTo(path: string, link: string): Promise<string | null>;
    chmod(path: string, mode: number): Promise<void>;
    /** chown(2): a null side keeps what the file has (chown -1). */
    chown(path: string, uid: number | null, gid: number | null): Promise<void>;
    /**
     * utimensat(2): null is now, undefined leaves that time (only those need
     * no more than write permission or ownership); an explicit time needs
     * ownership. `follow: false` sets a link's own times.
     */
    utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: {
        follow?: boolean;
    }): Promise<void>;
    /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
    copy(from: string, to: string, options?: {
        recursive?: boolean;
        preserve?: boolean;
    }): Promise<number>;
    /** Create the file if absent, and set its times to now (touch). */
    touch(path: string): Promise<void>;
    /** The file's bytes read around the session's content cache, re-checked for a change mid-read. */
    readFileUncached(path: string): Promise<Uint8Array>;
    /** {@link readFileUncached} as the ArrayBuffer a wasm module map takes, so a runtime image is held once. */
    readArrayBufferUncached(path: string): Promise<ArrayBuffer>;
    /**
     * rm: a file, or with `recursive` a tree, whole or not at all; `force`
     * makes a missing path no error.
     */
    remove(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    /** Each entry of a directory with its own stat (links not followed): ls -l, find, du. */
    readdirStat(path: string): Promise<Array<ProcessStat & {
        name: string;
    }>>;
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    access(path: string, mode: number): Promise<void>;
    realpath(path: string): Promise<string>;
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    appendFile(path: string, content: Uint8Array | string): Promise<void>;
}
/** A process's stat: everything stat(2) answers, which the bridge always has. */
export interface ProcessStat extends VfsStat {
    mode: number;
    uid: number;
    gid: number;
    atimeMs: number;
    ctimeMs: number;
    ino: number;
    nlink: number;
    dev: number;
}
/**
 * The namespace, synchronously, in the engine's call shape (the subset host
 * code uses): `stat` throws ENOENT when absent, paths may omit the leading
 * slash, and every failure carries its POSIX code.
 */
export declare class NamespaceFs {
    private readonly fs;
    readonly cred: VfsCred;
    constructor(fs: RuntimeSynchronousFs, cred: VfsCred);
    private probe;
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    isSymlink(path: string): boolean;
    stat(path: string): RuntimeVfsStat;
    lstat(path: string): RuntimeVfsStat;
    access(path: string, mode: number): void;
    readFile(path: string): Uint8Array;
    readFileString(path: string): string;
    readRange(path: string, offset: number, length: number): Uint8Array;
    /** `mode` applies only if this creates the file, at creation. */
    writeFile(path: string, content: string | Uint8Array, options?: {
        mode?: number;
    }): void;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    readdir(path: string): RuntimeVfsDirEntry[];
    unlink(path: string): void;
    rmdir(path: string): void;
    removeRecursive(path: string): void;
    rename(from: string, to: string): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    /** Where a path's links lead (links followed), or null for a cycle. */
    resolveSymlink(path: string): string | null;
    chmod(path: string, mode: number): void;
    chown(path: string, uid: number | null, gid: number | null): void;
    utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: {
        followSymlinks?: boolean;
    }): void;
    copyFile(from: string, to: string): void;
    acquireExclusiveMutation(path: string, options?: {
        includeMissingAncestors?: boolean;
    }): {
        root: string;
        owner: string;
    };
    releaseExclusiveMutation(owner: string): void;
}
//# sourceMappingURL=process-files.d.ts.map