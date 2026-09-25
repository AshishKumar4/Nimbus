/**
 * One namespace over many filesystems.
 *
 *   const vfs = new CompositeVFS(sqlite);
 *   vfs.mount('/tmp', new MemoryVFS());
 *   vfs.mount('/pc', ({ cred }) => devices.for(cred.uid), { absentReason: () => 'no device connected' });
 *   const agent = vfs.as(agentCred);            // same table, that principal's view
 *
 * A path is normalized in this namespace first (so `/pc/../etc` is `/etc`),
 * then routed to the longest mount point that holds it; the backend sees the
 * rest, '/'-rooted. A mount point and every missing directory above it read as
 * directories. A source given as a function is asked on every call, with the
 * view's principal, so a device that disconnects mid-session, or a mount one
 * principal has and another does not, is always current.
 *
 * Refusals are POSIX's: a mount whose source answers null is ENXIO with the
 * stated reason (and stats as absent); a mount point cannot be removed or
 * renamed (EBUSY); a rename across mounts is EXDEV (callers copy, as mv does);
 * an operation the routed backend does not offer is ENOTSUP, except
 * removeRecursive, which is walked. Nothing is emulated where the emulation
 * would change what the operation means.
 */
import type { SyncVFS, VFS, VfsCasResult, VfsCred, VfsDirent, VfsMountDescription, VfsRevision, VfsStat, VfsUsage } from './vfs.js';
/**
 * Who a view acts as. The embedder's own view has no credential. `actor` names
 * a principal finer than its uid: two agents (or a node and its origin) that
 * share a credential but see different mounts.
 */
export interface Principal {
    readonly cred: VfsCred | null;
    readonly actor?: string;
}
/** A backend, or a function giving the backend for a principal at this instant (null: absent). */
export type VfsSource = VFS | ((principal: Principal) => VFS | null);
export interface MountOptions {
    /** Stated in every refusal while the source answers null. */
    absentReason?: (principal: Principal) => string;
    /** Mutations fail EROFS. */
    readOnly?: boolean;
}
export interface MountInfo {
    readonly point: string;
    readonly source: VfsSource;
    readonly options: Readonly<MountOptions>;
    /** df / mount: what the backend says, or a generic description. */
    describe(): VfsMountDescription;
    usage(): Promise<VfsUsage | null>;
}
interface Mount {
    point: string;
    source: VfsSource;
    options: MountOptions;
}
interface Table {
    mounts: Map<string, Mount>;
    /** Directory → names of mount points (or their missing ancestors) directly in it. */
    synthesized: Map<string, Set<string>>;
}
/** `/a/b`, from any spelling; `..` stops at the root. */
export declare function normalizePath(path: string): string;
export declare class CompositeVFS implements VFS {
    private readonly table;
    private readonly viewer;
    /** Backends seen as this view's principal (a backend's `as` view is made once per view). */
    private readonly viewed;
    private readonly views;
    private readonly syncView;
    constructor(root: VfsSource, options?: MountOptions);
    /** @internal a view over the same table. */
    constructor(root: VfsSource, options: MountOptions | undefined, shared: {
        table: Table;
        principal: Principal;
        views: Map<string, CompositeVFS>;
    });
    mount(point: string, source: VfsSource, options?: MountOptions): void;
    unmount(point: string): void;
    /** The mounts this view's principal has now, root first, in mount order. */
    mounts(): readonly MountInfo[];
    /** The mount point `path` is on ('/' for the root), whether or not its source is present. */
    mountOf(path: string): string;
    /** The same table as `cred` (and `actor`): sources are resolved for that principal. */
    as(cred: VfsCred, actor?: string): CompositeVFS;
    /** Who this view acts as. */
    get principal(): Principal;
    get sync(): SyncVFS;
    private resynthesize;
    private route;
    private backend;
    /** The shortest mount on `path` whose source answers null for this view (rule 1), or null. */
    private absentOn;
    private absent;
    /** ENXIO when `path` is absent for this view. */
    private present;
    /** Whether `point` is a mount this view reaches (rule 1). */
    private live;
    /** The operations the backend at `route` offers, synchronous or not. */
    private ops;
    /** The root, a live mount point, or a directory above one (rule 2): this namespace's, not a backend's. */
    private isStructural;
    private hasLiveBelow;
    private method;
    /**
     * `input` with every root link on it followed (the last only when
     * `follow`), normalized in this namespace. A mount point or a directory
     * above one is never a link (rule 2); a component inside a mount is left to
     * that backend. ELOOP past MAX_LINK_HOPS.
     */
    private resolve;
    /**
     * Whether the backend holds a directory that exists only above a mount
     * point (not a mount point) as something else, a link or a file. Then that
     * directory holds only its mount names (rule 2 applied to ancestors: a
     * mount covers everything under its path).
     */
    private coversNonDirectory;
    /** Whether `path` lies under such a covered directory (and is not itself a mount name there). */
    private shadowed;
    /** ENOENT when `path` is shadowed. */
    private reachable;
    private statAt;
    /** stat, with ENOENT/ENOTDIR from the backend read as "not there". */
    private softStat;
    private absentOrThrow;
    /** Mount points (and directories above live ones) directly in `dir` that this view reaches. */
    private liveNamesIn;
    private readdirAt;
    private emptyIfMissing;
    private onFile;
    private onMutation;
    private mkdirAt;
    private renameAt;
    private renameIn;
    /** rmdir, or on a backend without it, an emptiness check and unlink. */
    private rmdirAt;
    private removeAt;
    /** Depth-first removal with base operations; a failure names what went and what is left. */
    private walkRemove;
    stat(path: string, options?: {
        follow?: boolean;
    }): Promise<VfsStat | null>;
    readFile(path: string): Promise<Uint8Array>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
    }): Promise<void>;
    writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    readdir(path: string): Promise<VfsDirent[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    removeRecursive(path: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
    utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
    writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): Promise<VfsCasResult>;
    readFileAtRevision(path: string, revision: VfsRevision, range?: {
        offset: number;
        length: number;
    }): Promise<Uint8Array>;
    describe(): VfsMountDescription;
    private makeSync;
}
/**
 * Move a file between filesystems: the copy is confirmed before the source
 * goes, and a failure puts both sides back. Directories are refused before
 * any I/O. For callers that must move across mounts (mv does its own).
 */
export declare function moveAcross(vfs: VFS, from: string, to: string): Promise<void>;
export {};
//# sourceMappingURL=composite.d.ts.map