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
import { type ProgramPlacement } from './program-start.js';
import type { SqliteVFS, VfsExportChunk, VfsExportPage } from '../vfs/sqlite-vfs.js';
import { WaveIngest } from './wave-ingest.js';
import { Hydrator, type HydratorOptions } from './hydration.js';
import { Delegations, type DelegationRevoked } from './delegations.js';
import type { OutputGate } from './output-gate.js';
import type { FacetImage } from './facet-host.js';
import { CompositeVFS } from '../vfs/composite.js';
import { ProcVFS } from '../vfs/proc-vfs.js';
import type { VFS, VfsCopyOptions, VfsDirent, VfsRemoval, VfsStat } from '../vfs/vfs.js';
import { type NimbusFilesystemAuthority, type NimbusFilesystemBinding, type NimbusHostFilesystemLease, type NimbusMountEntry, type RuntimeFsBridge, type RuntimeOpenFlags, type RuntimeSynchronousFs, type RuntimeVfsDirEntry, type RuntimeVfsStat, type VfsCred } from './os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
/** The session's namespace and the processes bound to it. */
export declare class ProcessFiles implements NimbusFilesystemAuthority {
    readonly engine: SqliteVFS;
    readonly namespace: string;
    /** The mount table: SQLite at `/`, `/proc`, `/dev`, and the embedder's. */
    readonly vfs: CompositeVFS;
    /** `/proc`: the host registers generated files here (`mounts` is ProcessFiles'). */
    readonly proc: ProcVFS;
    private readonly processes;
    private readonly namespaces;
    private readonly retired;
    /** Per process: what ends its ordinary bindings at its release, whatever keeps its scope open after. */
    private readonly bound;
    /** Per process whose log is draining: its one recovery, and the release it defers until the drain ends. */
    private readonly recoveries;
    /** Per process: where its listings of the mounts beyond SQLite stand (MountListing). */
    private readonly listings;
    /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
    /** N17: the lazy-import hydration job, when the embedder supplies a fetch. */
    readonly hydrator: Hydrator | null;
    /** Subtrees delegated to processes (Delegations): each recalled through its holder's bridge. */
    readonly delegations: Delegations;
    /** Bytes one buffered mount handle holds before EFBIG (VFS-PF-001). */
    private readonly bufferedWriteBytes;
    /**
     * Every wave's ingestion, whoever streams it (a process's binding, or a
     * command holding the engine): its records placed by this namespace's
     * mutation lookup, those it places on a mount applied there by its own
     * operations (wave-router.ts).
     */
    readonly waves: WaveIngest;
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
     * a change feed (CompositeFeed.walk, MOUNT_LIST_NAME_LIMIT), there or once
     * a mount above them goes. Kept for the names on a mount an embedder made
     * (any but the root and those whose trees are fixed: the kernel's /dev and
     * /proc), and `names` asked only when the process's credential sees one,
     * so a launch computes nothing for a namespace of SQLite and the kernel's.
     * Adds to what was named.
     */
    nameLaunch({ pid, cred }: NimbusFilesystemBinding, names: () => Iterable<string>): void;
    /** Where `pid`'s listings of the mounts beyond SQLite stand (made when `create`), or undefined. */
    private listingOf;
    private createListing;
    bind({ pid, cred, signal, attribute }: NimbusFilesystemBinding): RuntimeFsBridge;
    recovery(pid: number, cred: Readonly<VfsCred>): NimbusHostFilesystemLease;
    /** `pid`'s descriptor scope, made on its first binding. */
    private scopeOf;
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
     * exactly as a process's syscalls do. `landed`: its reads read what has
     * landed (VFS.as), asking no delegation's holder — a listing that runs on
     * every change (the editor's file tree). One per credential and option for
     * the session.
     */
    namespaceFs(cred: Readonly<VfsCred>, options?: {
        landed?: boolean;
    }): NamespaceFs;
    /** Host work over a credentialed lease released when the work settles. */
    withHost<T>(cred: Readonly<VfsCred>, use: (fs: RuntimeFsBridge) => Promise<T>): Promise<T>;
    /**
     * What holds a process's output back: the publication of every commit of
     * its that another reader's recall holds (SqliteVFS.publishedFor). None
     * held, nothing waits.
     */
    readonly outputGate: Required<OutputGate>;
    /** Whether the session's process output waits at `outputGate` (holdOutput). */
    private outputHeld;
    /** The processes whose waves answer at their commit (continueAtCommit), until one escapes the gate. */
    private readonly continuing;
    /**
     * Released `pid` writes nothing more: the set its calls were made by
     * (Delegations.holdsOf), by which the engine holds what it wrote for its
     * publication, goes once that is published. Until then the output its end
     * leaves still waits for it, whenever that is let out.
     */
    private retireWriter;
    /**
     * From now on whatever `processes` lets out for a process (its log, pipes,
     * terminal and exit, the supervisor ops that leave the session, its ports'
     * answers: SessionProcessSupervisor.releaseOutput) waits at `outputGate`
     * for what it wrote to be published.
     */
    holdOutput(processes: {
        setOutputGate(gate: OutputGate | null): void;
    }): void;
    /**
     * Process `pid`'s waves answer at their commit from now on, ahead of
     * their publication: the writer continues, and whatever it makes visible
     * waits for the publication instead. Only for a process whose every way
     * out does: what the session lets out for it at `outputGate` (holdOutput),
     * what leaves by its runtime's own network at that runtime's boundary
     * (RuntimeFsBridge.published, the node shims'), and a raw socket it opens
     * ending this (`escaped`).
     */
    continueAtCommit(pid: number): void;
    /** Process `pid` has ended (exited, killed, its host lost): see Delegations.endReads. */
    processEnded(pid: number): void;
    releaseProcess(pid: number): Promise<void>;
    /** `pid`'s scope closed for good, its descriptors' last closes flushing, and its grants given up. */
    private closeProcess;
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
    placeProgram(cred: Readonly<VfsCred>, cwd: string): ProgramPlacement | Promise<ProgramPlacement>;
    mounts(cred: Readonly<VfsCred>): readonly NimbusMountEntry[];
    /**
     * Closes `scope` for good: every descriptor (each last close flushing),
     * its subscriptions, and the scope itself (EBADF from then on, for every
     * bridge on it). A flush that fails (an aborted binding's, a mount's
     * refusal) loses its bytes and is reported after the scope is closed.
     */
    /** Every subscription of `scope` stopped, whichever of them fails to. */
    private stopSubscriptions;
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
export declare const F_OK = 0;
export declare const X_OK = 1;
export declare const W_OK = 2;
export declare const R_OK = 4;
/**
 * A process's namespace as a `VFS` over its bound bridge, plus the process
 * syscalls a `VFS` has no word for (access, realpath, append). Absent is
 * null from `stat`; every failure is a `VfsError`.
 */
/** A bridge's calls as a view that can wait makes them (ProcessView): each a promise, made again after a recall. */
type RecallingBridge = {
    [K in keyof RuntimeFsBridge]: NonNullable<RuntimeFsBridge[K]> extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
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
    /** `maxBytes`: only a regular file of at most that many bytes, read whole; a larger one or a device is EFBIG, unread (RuntimeReadFileOptions). */
    readFile(path: string, options?: {
        maxBytes?: number;
    }): Promise<Uint8Array>;
    /**
     * Text is written as UTF-8, as a process's write(2) of a string would.
     * `mode` applies only if this creates the file, and at creation
     * (open(O_CREAT|O_TRUNC, mode), then the bytes): an existing file keeps its
     * mode, and a new one is never visible at another mode.
     */
    writeFile(path: string, data: Uint8Array | string, options?: {
        mode?: number;
        exclusive?: boolean;
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
    /** rm -r's complete namespace report, including partial removal and vanished children. */
    removeRecursive(path: string, options?: {
        keepVanishedAncestors?: boolean;
    }): Promise<VfsRemoval>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    /** Where the link at `path`, reading `link`, leads in this namespace (RuntimeFsBridge.linkLeadsTo), for a caller following it itself. */
    linkLeadsTo(path: string, link: string): Promise<string | null>;
    chmod(path: string, mode: number): Promise<void>;
    /** chown(2): a null side keeps what the file has (chown -1), in the same change. `follow: false` is lchown(2), a link's own. */
    chown(path: string, uid: number | null, gid: number | null, options?: {
        follow?: boolean;
    }): Promise<void>;
    /** utimensat(2), each time an FsTime; `follow: false` sets a link's own times. */
    utimes(path: string, atime: FsTime, mtime: FsTime, options?: {
        follow?: boolean;
    }): Promise<void>;
    /** cp: a file (a link named as the source followed), or with `recursive` a tree, onto a name that is not there. */
    copy(from: string, to: string, options?: VfsCopyOptions): Promise<number>;
    /** Create the file if absent, and set its times to now (touch). */
    touch(path: string): Promise<void>;
    /**
     * The file's bytes read around the session's content cache, re-checked for
     * a change mid-read: one whole-file read, so one coherent copy on every
     * backend, held once, and the caller's own: the read's buffer, never copied
     * again here. `maxBytes` as readFile's.
     */
    readFileUncached(path: string, options?: {
        maxBytes?: number;
        contentKey?: string;
    }): Promise<Uint8Array>;
    /** The file's content key (RuntimeFsBridge.contentKey): equal keys, equal bytes; ENOTSUP where the filesystem keeps none. */
    contentKey(path: string): Promise<string>;
    /** `path` as a wasm image a facet loads, read through this view when the host builds the facet (openFacetImage). */
    image(path: string): Promise<FacetImage>;
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
    /**
     * Every entry strictly under directory `path` with its lstat, in path
     * order (which is a git index's order): one paged scan of the filesystem
     * (`list`, which recalls each delegation an lstat of an entry would)
     * instead of a listing per directory and a stat per entry. A directory a
     * walk by name would answer differently is marked `byName`, for the
     * caller to ask by name: one on a mount whose names the scan does not
     * list (`unlisted`), or one the caller may not read and search
     * (`unreadable`), whose readdir is refused. A subtree changed between the
     * first page and the last is refused EAGAIN, its pages not one tree: by
     * its revision, or where it keeps none (a mount under it: 0), by every
     * page's being of the filesystem's same revision. Between pages the thread is given up for a turn: a page of SCAN_PAGE
     * entries is one bounded slice of the session's thread.
     */
    scan(path: string): AsyncGenerator<ScannedEntry>;
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    access(path: string, mode: number): Promise<void>;
    realpath(path: string): Promise<string>;
    /**
     * An open file description of this process on `path` (open(2)): its reads
     * and writes are the file the open found, whatever the name names after,
     * at its own position, until it is closed.
     */
    open(path: string, flags: RuntimeOpenFlags): Promise<ProcessFile>;
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    appendFile(path: string, content: Uint8Array | string): Promise<void>;
}
/** A process's open file description (ProcessView.open), by its descriptor; every failure is a `VfsError`. */
export declare class ProcessFile {
    #private;
    private readonly fs;
    readonly path: string;
    private readonly handle;
    /** Its file as the open found it. */
    readonly stat: ProcessStat;
    /** Opened to write: what it wrote is synced before it closes (withOpenFiles). */
    readonly writes: boolean;
    constructor(fs: RecallingBridge, path: string, handle: number, 
    /** Its file as the open found it. */
    stat: ProcessStat, 
    /** Opened to write: what it wrote is synced before it closes (withOpenFiles). */
    writes: boolean);
    /** Up to `length` bytes at `offset`, or (null) at its position, which then moves: none only at the end (readToEnd). */
    read(length: number, offset?: number | null): Promise<Uint8Array>;
    /** All of `bytes`, at `offset` or (null) at its position (its end, opened to append), which then moves. */
    write(bytes: Uint8Array, offset?: number | null): Promise<void>;
    /** ftruncate(2): the file this description holds, whatever its name names now. */
    truncate(size: number): Promise<void>;
    /** What the filesystem still holds for its file, written (fsync): a write it could not make fails here. */
    sync(): Promise<void>;
    /** Whether it is closed: nothing is read, written or synced through it after. */
    get closed(): boolean;
    /** Closed once, whoever closes it first: a later close does nothing. */
    close(): Promise<void>;
}
/**
 * `file`'s bytes from `from`, `size` at a time, to a read that answers none
 * (its end: a read may answer fewer bytes than it asks and the file go on),
 * or until `limit` bytes.
 */
export declare function readToEnd(file: ProcessFile, size: number, { from, limit }?: {
    from?: number;
    limit?: number;
}): AsyncGenerator<Uint8Array>;
/** How withOpenFiles' `use` opens a description it holds. */
export type OpenFile = (path: string, flags: RuntimeOpenFlags) => Promise<ProcessFile>;
/**
 * `use`, with every description it opens through `open` closed when it ends,
 * however it ends: one opened to write synced first, then closed whether the
 * sync succeeded or not; one `use` closed itself is left as it is. What a
 * sync or a close fails with is told to `failed`, and the rest are closed all
 * the same, also when `failed` throws.
 */
export declare function withOpenFiles<T>(view: ProcessView, use: (open: OpenFile) => Promise<T>, failed: (file: ProcessFile, error: unknown) => Promise<void>): Promise<T>;
/**
 * `path` as a wasm image a facet loads, read as `cred` through a host view
 * of its own at every load: for a facet that outlives the view it was opened
 * from (a shell's bash, a git that leaves its facet warm, a REPL).
 */
export declare function hostImage(authority: NimbusFilesystemAuthority, cred: Readonly<VfsCred>, path: string): Promise<FacetImage>;
/** An entry of ProcessView.scan: its path under the scanned directory, its lstat, and whether its entries must be asked by name. */
export interface ScannedEntry {
    path: string;
    stat: ProcessStat;
    byName: boolean;
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
    utimes(path: string, atime: FsTime, mtime: FsTime, options?: {
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
export {};
//# sourceMappingURL=process-files.d.ts.map