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
import type { Awaitable, Principal, SyncVFS, VFS, VfsCasResult, VfsCopyOptions, VfsCred, VfsDirent, VfsMountDescription, VfsRemoval, VfsRevision, VfsStat, VfsUsage, VfsViewOptions, VfsWriteObserver, VfsWriteWants } from './vfs.js';
import type { RuntimeVfsStat, VfsAcquireOptions, VfsInvalidatedPath, VfsListEntry } from '../runtime/os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import { type VfsEvent } from './events.js';
import { type VfsErrorCode } from './vfs-error.js';
import { compareUtf8 as comparePaths } from '@nimbus-sh/platform/utf8.js';
/**
 * Where a reader of a namespace's feed stands: the mount table as its
 * principal saw it, and each change feed's epoch and cursor.
 */
export interface FeedPosition<Epoch extends string | null = string> {
    readonly table: string;
    readonly feeds: Readonly<Record<string, {
        readonly epoch: Epoch;
        readonly cursor: number;
    }>>;
}
/** One answer of the feed: every path changed since the position, or a poison (relist). */
export interface FeedAnswer {
    readonly position: FeedPosition;
    readonly poison: boolean;
    readonly paths: VfsInvalidatedPath[];
}
/**
 * The names a principal sees on the mounts that keep no change feed, walked
 * through their readdir where a listing is told to look (`CompositeFeed.walk`):
 * listing entries in path order (`comparePaths`), absolute. A directory the
 * walk did not list carries `unlisted`, its mount point: what is under it is
 * not absent, only not named.
 */
export type MountWalk = readonly VfsListEntry[];
/**
 * The change feed of a principal's namespace (FormalModelsLane
 * `Vfs/CompositeFeed`): each backend's feed re-rooted under its mount point
 * and filtered to the paths the namespace routes to it, so a root row a
 * mount covers is never staged. A reader takes `position()`, then lists,
 * then asks `since` at every barrier. Entries carry their backend's `rev`.
 * A mount without a feed shows its point, and, when the listing is given a
 * `walk` of it, what the walk named.
 */
export interface CompositeFeed {
    position(): FeedPosition;
    since(position: FeedPosition<string | null>, options?: VfsAcquireOptions): FeedAnswer;
    list(after: string | null, limit: number, walked?: MountWalk): {
        entries: VfsListEntry[];
        next: string | null;
    };
    /**
     * What the mounts without a feed hold where `named` points into them, as
     * this principal: each such mount point that it can reach, and, on it, the
     * directory of each named path and every directory from the mount point
     * down to it (one level each), and each named directory whole, breadth
     * first. A directory is listed whole or not at all, only where the
     * principal may search it, and only while the names so far leave room
     * under `limit`. One readdir per directory listed, stats taken from the
     * listings; nothing is stat-ed per named path. On a mount whose backend
     * resolves its own paths, a directory whose parent could not be listed (a
     * device shows only what is under its user's consent) is stat-ed itself.
     */
    walk(named: Iterable<string>, limit: number): Promise<MountWalk>;
}
/** Path order as SQLite's index keeps it: by UTF-8 bytes (platform utf8.ts compareUtf8). */
export { comparePaths };
/**
 * A namespace entry's stat in the runtime contract's shape: its identity
 * (dev, ino) is the namespace's, and a mounted backend's entries carry no
 * SQLite revision.
 */
export declare function runtimeStatOf(stat: VfsStat): RuntimeVfsStat;
export type { Principal } from './vfs.js';
/** The namespace always offers recursive removal, walking a backend that does not, and copies across filesystems. */
export interface CompositeSyncVFS extends SyncVFS {
    removeRecursive(path: string, options?: {
        keepVanishedAncestors?: boolean;
    }): VfsRemoval;
    copy(from: string, to: string, options?: VfsCopyOptions): number;
}
/** A backend, or a function giving the backend for a principal at this instant (null: absent). */
export type VfsSource = VFS | ((principal: Principal) => VFS | null);
export interface MountOptions {
    /** Stated in every refusal while the source answers null. */
    absentReason?: (principal: Principal) => string;
    /** Mutations fail EROFS. */
    readOnly?: boolean;
    /**
     * The backend resolves a whole path itself, as a network filesystem's
     * server does (a device tunnel, a container, a Drive): every operation on
     * a path inside the mount is one call to the backend with the
     * mount-relative path. The namespace stats no component on the way (the
     * mounted root included), checks no parent, and reads no link inside the
     * mount. The backend follows its own links, in its own tree, and answers
     * for every component itself: ENOENT, ENOTDIR, EACCES on an ancestor it
     * will not show, or a parent it makes on write. It is handed the path below
     * the mount point as written, its `.`, `..` and trailing slash included,
     * for it to walk; a `..` that climbs past the mount's root leaves the
     * mount, taken lexically by the namespace. readlink
     * answers a link's text, as written; a walk over the namespace that
     * follows a link itself (a launch's staged view, a process's walks) asks
     * `linkLeadsTo` where it leads (an absolute target re-rooted at the mount
     * point, a relative one climbing no higher than it), so it lands where the
     * backend does.
     *
     * The namespace still owns everything up to and including the mount
     * point: root links that lead into it, ENXIO with `absentReason` while the
     * source answers null, the mount point as a directory (EBUSY, EISDIR, mkdir
     * -p a no-op), EROFS under `readOnly`, EXDEV across mounts, and any mount
     * nested inside it (the backend never sees a path into one, so the
     * directories on the way are looked up and searched here). Permissions inside the mount, its root's included, are
     * the backend's: a view's credential reaches it through its `as`. A walk
     * over the namespace (a process's synchronous bridge) asks
     * `resolvedByBackend` and hands such a path over whole too.
     */
    resolvesPaths?: boolean;
    /**
     * A recursive removal from above (rm -r of a directory holding the mount
     * point) enters the mount and removes what it holds, as Linux's rm -r
     * does. Without it, a removal keeps out of the mount, as GNU rm
     * --one-file-system does: the mount point and everything under it stay,
     * reported EBUSY, and the rest of the tree is removed. A mount is often
     * storage that is not the session's (another machine, a user's files).
     */
    removalCrosses?: boolean;
}
/** Options shared by `route` and `mutationRoute`. */
export interface VfsRouteOptions {
    readonly follow?: boolean;
    readonly creating?: boolean;
    /** Report the lookup's dependencies and stop point instead of rejecting a lookup refusal. */
    readonly report?: boolean;
}
/** Namespace link paths a lookup read on the way, in traversal order (the link itself, not its target). */
export interface VfsTraversal {
    readonly links: readonly string[];
}
export type VfsLookupRefusalCode = 'ENOENT' | 'ENOTDIR' | 'ELOOP' | 'ENXIO' | 'EACCES';
export interface VfsRouteRefusal extends VfsTraversal {
    readonly refusal: {
        readonly code: VfsLookupRefusalCode;
        readonly at: string;
    };
}
export interface VfsMutationRoute {
    readonly path: string;
    readonly point: string;
    readonly readOnly: boolean;
}
export type VfsRouteReport = (VfsRoute & VfsTraversal) | VfsRouteRefusal;
export type VfsMutationRouteReport = (VfsMutationRoute & VfsTraversal) | VfsRouteRefusal;
/** Where a path lands in a principal's namespace (CompositeVFS.route). */
export interface VfsRoute {
    /** The mount point ('/' for the root). */
    readonly point: string;
    /** The backend as the view's principal sees it; null while it is absent for that principal. */
    readonly source: VFS | null;
    /** The path the backend is handed: '/'-rooted, '/' at the mount point. */
    readonly path: string;
    /** Why the source is absent (MountOptions.absentReason), when it is. */
    readonly absentReason?: string;
}
/**
 * The name an open found (CompositeVFS.pin), for the open's decisions: each
 * operation is on that one name, where the open's lookup landed it, whatever
 * is mounted or linked there later.
 */
export interface PinnedName {
    /** The namespace's name for it. */
    readonly name: string;
    /** Its backend answers only by awaiting. */
    readonly awaits: boolean;
    /** The name itself, a link not followed. */
    lstat(): Awaitable<VfsStat | null>;
    /** What it leads to: a link the backend resolves itself (MountOptions.resolvesPaths) followed by that backend. */
    stat(): Awaitable<VfsStat | null>;
    /** The backend's own refusal of an open asking `mode` (VFS.access); a backend of one identity refuses none. */
    access(mode: number): Awaitable<void>;
    /** An empty file made at it (creat(2)): `admit` runs right before the backend is asked. */
    create(mode: number | undefined, admit?: () => void): Awaitable<void>;
    truncate(size: number, admit?: () => void): Awaitable<void>;
    /** Which file is there now (HeldFile.key), or null when nothing is: the key held writes to it are kept under. */
    key(): Awaitable<string | null>;
    /** What is there now, read whole (a file this process holds writes to, as its reads see it). */
    readAll(): Awaitable<Uint8Array>;
    /**
     * The file the open decided on (`ino`, its number as this name's stat
     * answers it), held with `rights` for a description: VFS.openFile where
     * the backend keeps open files, else by name. ESTALE when the file there
     * now, or the one the backend opened, is another: the open authorized that
     * one. Its identity and metadata are what it holds.
     */
    hold(rights: {
        read: boolean;
        write: boolean;
    }, ino: number): Awaitable<HeldFile>;
}
/**
 * A file a description holds (PinnedName.hold). On a backend that keeps
 * open files (VFS.openFile) its content operations reach that file wherever
 * it is named later; every other operation, and every one on a backend that
 * keeps none, goes by the name it was opened at, refused (ESTALE) once that
 * name holds another file (its backend's inode number changed) or none,
 * asked in a change's turn among the namespace's observed changes, right
 * before it (on a backend that awaits, that is a stat, then the change). A
 * backend that numbers no files cannot tell: there, the name is the file.
 * Its mutations are the opener's view's: refused on a read-only mount, asked
 * of the namespace's guard at its name, and observed (observeWrites) only
 * while the namespace shows that file at that name.
 */
export interface HeldFile {
    /** The namespace's name for it, when it was opened. */
    readonly name: string;
    /** Its backend answers only by awaiting. */
    readonly awaits: boolean;
    /** Which file it is: the same for every hold of it, through any name or view of its backend. */
    readonly key: string;
    /** `admit`, on each: its caller's admission, run right before the backend is asked, after every await (the view it was opened through asks nothing of its own). */
    stat(admit?: () => void): Awaitable<VfsStat>;
    read(offset: number, length: number, admit?: () => void): Awaitable<Uint8Array>;
    readAll(admit?: () => void): Awaitable<Uint8Array>;
    /** In place; ENOTSUP where it cannot be written so. */
    write(offset: number, bytes: Uint8Array, admit?: () => void): Awaitable<void>;
    /** Its whole content, `bytes`. */
    replace(bytes: Uint8Array, admit?: () => void): Awaitable<void>;
    truncate(size: number, admit?: () => void): Awaitable<void>;
    chmod(mode: number, admit?: () => void): Awaitable<void>;
    chown(uid: number | null, gid: number | null, admit?: () => void): Awaitable<void>;
    /** As its backend's utimes, each time an FsTime its backend resolves as it commits. */
    utimes(atime: FsTime, mtime: FsTime, admit?: () => void): Awaitable<void>;
    readdir(admit?: () => void): Awaitable<VfsDirent[]>;
    close(): Awaitable<void>;
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
    /** `point` and a slash: what a path under it starts with. */
    under: string;
    source: VfsSource;
    options: MountOptions;
    /**
     * st_dev of what is mounted here: an anonymous device number (0x10000 + n,
     * as Linux gives a mount with no device of its own), clear of the small
     * ids a SQLite engine reports. Null for the root, whose backend's own is kept.
     */
    dev: number | null;
    /** Inode numbers for a backend that has none, by path, stable while mounted. */
    inos: Map<string, number>;
}
/** One observeWrites registration: its observer, and where it wants content read, per side. */
interface WriteWatch {
    observer: VfsWriteObserver;
    wants: (path: string, principal: Principal) => VfsWriteWants;
}
/** One watchChanges registration: its view, the tree it watches, and the mounts whose backends tell it their own changes. */
interface ChangeWatch {
    readonly view: CompositeVFS;
    /** The namespace path watched, and everything under it: where its target is now, for a watch that follows it (projectChange). */
    path: string;
    /** It follows its target's own move (watchChanges' `follow`). */
    readonly follow: boolean;
    readonly listener: (events: readonly VfsEvent[]) => void;
    readonly subscribed: Map<Mount, () => void>;
    /** Batches published to it and not yet told, in landing order (judgeChanges judges each as it is told). */
    readonly queue: Changes[];
    /** An earlier batch's judgment awaits: the ones after it wait behind it. */
    waiting: boolean;
    stopped: boolean;
    /** Whether something is at `path`, as a look when the watch began and the changes judged since say; null: not known. */
    present: Awaitable<boolean> | null;
}
/** Changes published to a watch: in namespace names, from the mount their ends are on. */
interface Changes {
    readonly mount: Mount;
    readonly events: readonly VfsEvent[];
    /** Told by the backend as this view's principal sees it (VFS.watchChanges): who may see what on it is the backend's to say. */
    readonly judged: boolean;
}
/** watchChanges: who is told, and the watches with batches to tell (drainChanges). */
interface ChangeWatches {
    readonly watches: Set<ChangeWatch>;
    readonly ready: ChangeWatch[];
    draining: boolean;
}
/** observeWrites: who is told, the mounts whose backends report their own writes, and the namespace's own reports in flight. */
interface WriteWatches {
    watches: Set<WriteWatch>;
    subscribed: Map<Mount, () => void>;
    /**
     * Observed mutations on backends that do not report their own take one
     * turn per namespace (reportWrite): one store can sit behind several
     * mounts (a backend mounted directly and through a factory, its own
     * links), and nothing here can tell reliably which, so no path or mount
     * decides what conflicts. Costs only while someone observes; a turn's
     * section is `busy`.
     */
    turn: {
        tail: Promise<void>;
        busy: boolean;
    };
}
interface Table {
    mounts: Map<string, Mount>;
    /** Bumped by every mount and unmount: a placement made under an older table may be stale (mountGeneration). */
    generation: number;
    /** The last st_dev a mount was given, through any view: two mounts are never one device. */
    lastDev: number;
    /** observeWrites: who is told, and the mounts whose backends report their own writes, subscribed. */
    writes?: WriteWatches;
    /** watchChanges: who is told. */
    changes?: ChangeWatches;
    /** Each principal's view of a backend, to the backend it views (storeBehind). */
    readonly behind: WeakMap<object, VFS>;
    /** Directory → names of mount points (or their missing ancestors) directly in it. */
    synthesized: Map<string, Set<string>>;
    /** Asked before a credentialed view's mutation reaches a backend (guardMutations). */
    guard?: MutationGuard;
    /** Told of every mount and unmount (watchMounts). */
    moved?: () => void;
    /** Asked before a mount or unmount changes what a path routes to (guardRouting). */
    routing?: (point: string) => void;
}
/**
 * Why a mutation by `cred` at the namespace path `path` is refused (an
 * exclusive-mutation lease covers it), or null: CompositeVFS.guardMutations.
 * `owner`: the lease the mutation presents (a view made by `presenting`).
 */
export type MutationGuard = (cred: VfsCred, path: string, owner?: string) => {
    code: VfsErrorCode;
    detail: string;
} | null;
interface Views {
    refs: Map<string, WeakRef<CompositeVFS>>;
    gone: FinalizationRegistry<string>;
}
/** Where the namespace's own device numbers for mounts start (see Mount.dev): an entry's dev at or past it is on a mount. */
export declare const ANONYMOUS_DEV = 65536;
/** Whether `error` is a synchronous caller's refusal by an asynchronous mount (one that can await may retry on the async face). */
export declare function isAsyncMountRefusal(error: unknown): boolean;
/** `/a/b`, from any spelling; `..` stops at the root. */
export declare function normalizePath(path: string): string;
/** What a view over a table shares with the view it was made from (CompositeVFS constructor). */
interface ViewShare {
    table: Table;
    principal: Principal;
    views: Views;
    viewed?: WeakMap<VFS, VFS>;
    check?: () => void;
    /** The exclusive-mutation lease this view's mutations present to the guard. */
    owner?: string;
    /** The delegations this view's process holds: its backends' lookups recall none of them (VFS.as). */
    holds?: () => ReadonlySet<string>;
    /** Its reads read what has landed (VFS.as): they ask no holder. */
    landed?: boolean;
}
export declare class CompositeVFS implements VFS {
    private readonly table;
    private readonly viewer;
    /** Backends seen as this view's principal (a backend's `as` view is made once per view). */
    private readonly viewed;
    /** Asked right before each of this view's mutations reaches a backend (scoped). */
    private readonly check;
    /** The exclusive-mutation lease this view's mutations present (scoped's `owner`). */
    private readonly owner;
    /** The delegations this view's process holds (scoped's `holds`): presented to every backend it reaches. */
    private readonly holds;
    /** Whether its reads read what has landed (as's `landed`): presented to every backend it reaches. */
    private readonly landed;
    /**
     * Views per principal, held weakly: one per principal while someone holds
     * it, none once no one does (a table serving thousands of agents does not
     * keep a view per agent for its life).
     */
    private readonly views;
    private readonly syncView;
    constructor(root: VfsSource, options?: MountOptions);
    /** @internal a view over the same table. */
    constructor(root: VfsSource, options: MountOptions | undefined, shared: ViewShare);
    /** This principal's namespace feed. */
    get feed(): CompositeFeed;
    /**
     * The mount table as this principal sees it: which mounts are live, which
     * have a feed, and what answers at each. A change is not in any backend's
     * feed, so a reader holding another signature relists.
     */
    private feedSignature;
    /** Live mounts with their backend's feed (none: only the point is staged). */
    private feedSources;
    private feedPosition;
    private static reroot;
    /** Whether the namespace shows `path` from `mount`: routed there, not covered, reachable. */
    private feedShows;
    private feedSince;
    /**
     * One page of every name the namespace shows, in path order: each feed's
     * listing re-rooted and filtered, merged with the directories the
     * namespace makes (mount points and their ancestors) and with `walked`
     * (the names a walk of the mounts without a feed found, which stand for
     * those mounts). A mount without a feed shows only its point otherwise.
     * Take `position()` before the first page.
     */
    private feedList;
    /**
     * A directory the namespace makes, as a listing entry: its stat as `stat`
     * answers it (the mounted root's own, or the directory the backend beneath
     * holds there), where that can be answered without waiting.
     */
    private madeStat;
    /** The mounts without a feed that this principal reaches: a point under a directory it cannot search is left out, as a listing leaves out a name there. */
    private unfedPoints;
    /** CompositeFeed.walk. */
    private walkUnfed;
    mount(point: string, source: VfsSource, options?: MountOptions): void;
    /** The mount table's generation: it moves with every mount and unmount, in every view of this namespace. */
    mountGeneration(): number;
    unmount(point: string): void;
    /**
     * Every mutation that lands in this namespace, on any mount, reported
     * once it landed (never a refused or failed one) with what stood at its
     * path before, what stands there after, and the principal it was made as
     * (VfsWriteEvent, paths in this namespace). For every view of this table;
     * the returned function stops it.
     *
     * A backend that reports its own writes (VFS.observeWrites: SQLite) is
     * subscribed per mount, so its every mutation is reported, whoever made
     * it (a process's, a W7 stream's), its content held until the observer is
     * done. Any other backend's mutations are reported as they are made
     * through this namespace: each costs a stat of its path before, and,
     * where `wants` says (by default, everywhere; per side when it answers
     * `{ before, after }`), a read of its content before and after. What a
     * writeFile or a compare-and-write leaves is the bytes it was given, so
     * its after costs no read.
     */
    observeWrites(observer: VfsWriteObserver, options?: {
        wants?: (path: string, principal: Principal) => VfsWriteWants;
    }): () => void;
    /**
     * Subscribe to `mount`'s backend when it reports its own writes (a source
     * fixed for every principal). An event is the namespace's only where the
     * principal that made it is shown that path from this mount (routed there,
     * not covered by another mount or a directory above one, reachable): a
     * root write beneath a mount point changed nothing the namespace shows
     * there. A rename half shown is the delete, or the create, its shown half is.
     */
    private subscribeWrites;
    /** This table as `principal` sees it (the embedder's own view for a principal with no credential). */
    private viewOf;
    /**
     * `event` to every observer of this table. Settles once each is done (a
     * backend holds the event's content until then); `release` lets go of
     * what the namespace captured itself, then, whatever an observer did.
     */
    private deliverWrite;
    /**
     * Every change this view may see at `path` or under it, on any mount,
     * told once it landed (VfsEvent, paths in this namespace), as the one
     * rule tells a watch (projectChange): each end of a change told where
     * this view shows that file (routed to its store from the mount it is on,
     * not covered, its source present for this principal) and may search
     * every directory above it, judged through this view's own lookup. In
     * landing order, in the batches its backend makes of them; to the watches
     * registered when it landed; a watch let go hears nothing more. No write
     * reads or waits for it; a watch that is not root's looks up the
     * directories above each change (the lookups a path read makes), and a
     * judgment through a backend that awaits is waited for by that watch
     * alone, its later changes behind it. The returned function stops it.
     *
     * A watch is of `path` wherever it leads: the path renamed away, or a
     * directory above it, is its unlink; a directory above it took it along
     * only if it was there, as a look when the watch began (a backend that
     * awaits answers it when it does) and the changes since say, else as it
     * is now. One that follows its target (`follow`, as Node's fs.watch does,
     * an inode's watch) is told that move instead, a rename, and is then of
     * the path its target has.
     *
     * A backend that tells its own changes (VFS.watchChanges: SQLite) is
     * watched per mount, as this view's principal sees it, so its every
     * change is told, whoever made it. Any other backend's changes are told
     * as they land through this namespace, at every mount of the same store
     * (VFS.fileStore), by what the operation is: a directory made addDir, a
     * file or link made add (a copy, each entry it made), rmdir unlinkDir,
     * a walked rm -r each entry it removed (a backend's own, the roots of what
     * it removed), a rename rename, anything else change. Whether a write of a
     * whole file or a range made its file, and what kind of entry a backend's
     * rm -r removed, is not looked up: those are change and unlink. mkdir -p
     * on a mount that resolves its own paths is one call to its backend: the
     * directories it answers it made are told (VFS.mkdir); one that does not
     * say has nothing told.
     */
    watchChanges(path: string, listener: (events: readonly VfsEvent[]) => void, options?: {
        follow?: boolean;
    }): () => void;
    /** `watch` let go: nothing more told, each backend subscription stopped (all of them, whichever throws). */
    private stopWatch;
    /**
     * Watch `mount`'s backend, as this view sees it, where it tells its own
     * changes and holds part of `watch`'s tree: a source fixed for every
     * principal (one that gives a backend per principal, or per moment, is
     * told as the namespace changes it). The whole of it: what is under the
     * watched path, and where it moves to, is the namespace's to judge (a
     * rename does not leave its mount).
     */
    private subscribeChanges;
    /**
     * `result`, `spec`'s mutation's answer, once it landed: its change told,
     * then, to the watches registered now (tellLanded). One that awaits is
     * told when it lands, before its caller hears the answer.
     */
    private landing;
    private tellSpec;
    /**
     * A change of `type` that landed at `paths` (and from `oldPath`) through
     * `mount`, in `store` (the one the mutation was routed to, whatever the
     * mount gives now), to each watch registered now: at every mount through
     * which that watch's view sees the same store, unless that mount's
     * backend tells the watch its own.
     */
    private tellLanded;
    private publishChanges;
    /**
     * Each published batch told, in order, one drain at a time: a change a
     * listener makes is published behind the ones being told, and told after
     * them.
     */
    private drainChanges;
    /** `watch`'s queued batches, judged and told in order; one judged by awaiting holds the rest until it is told. */
    private tellQueued;
    private tellWatch;
    /**
     * `batch` as `watch` is told it (projectChange), in order, a watch that
     * follows its target moving with it: each end shown from the mount it is
     * on (that mount still at its point, the namespace routing the path to
     * it, its source present: feedShows, asked only where another mount meets
     * the watched tree), and, for a watch that is not root's, under
     * directories it may search (searchable): an end its backend told as the
     * watcher's principal sees it (judged) by the directories above the mount,
     * any other by this view's lookups. Where a directory above the watched
     * path was renamed, it took the watched path along if something was there,
     * as the watch's look when it began and the changes judged since say (else
     * as the namespace has it where it is now), seen where it is now, or it is
     * not told. Judged event by event, a wait holding the rest.
     */
    private judgeChanges;
    /**
     * Whether something is at `path` for this view (lstat, its own lookup), by awaiting where its mount does: on a
     * backend that holds changes back, as they have been told (VFS.landedAt), its own lookup storing and recalling nothing.
     */
    private presentAt;
    /**
     * Whether this view may search every directory above `path`, by its own
     * lookup (resolve, the last component not looked at), and, on a mount that
     * resolves its own paths, by that backend's (access). A directory no
     * longer there (a removed tree, its entries told after it) cannot be
     * judged: what was under it is not shown.
     */
    private searchable;
    /** On a mount that resolves its own paths, whether its backend lets this view search the directory holding `path` (access, search). */
    private searchableWithin;
    /**
     * `run`, a mutation landing at `spec.path` on `spec.route`'s backend,
     * reported once it landed: by the backend itself when it reports its own
     * writes (subscribed), else here. Here, what the path held before and
     * after is read through the same backend view, with the operation's own
     * leaf-follow policy (content only where an observer wants it); the
     * namespace's observed mutations there take turns, capture to capture,
     * so none reads another's (WriteWatches.turn); and the guard is asked right before the
     * write, after the reads it waited on. `landed` says where the mutation actually landed
     * (default: its path): a compare-and-write that lost, or an rm -r that
     * kept its operand, did not land there.
     */
    private reportWrite;
    /**
     * reportWrite of the mutation `prepare` gives, prepared in its turn, after
     * the observed mutations queued before it (a held-open file's change is
     * placed where that file is then). Its `spec` null: a change at no name,
     * reported to no one. `name`: the mutation's name before it is placed.
     */
    private reportPrepared;
    /** `report` in its turn among the observed mutations (takeTurn); a caller that cannot wait is refused while another holds it. */
    private inTurn;
    /** reportWrite's report of `spec`'s mutation, `run`, in its turn. */
    private reportIn;
    /** `run` once every observed mutation queued before it is done; those after it wait for it. */
    private takeTurn;
    /**
     * What stands at `rel` on a backend that does not report its own writes,
     * as the operation sees it (`follow`: through a link at the leaf): null
     * when nothing does, its content when `read`, false when what is there
     * was not read (not wanted, or the backend would not say). What it reads
     * is held in `held`, let go when the observers are done.
     */
    private capture;
    /** Content the observers are told of, held in `held` until they are done. */
    private keep;
    /** Whether the table declares an accepted mount point, even if its source is absent. */
    someMountPoint(wants: (point: string) => boolean): boolean;
    /** The mounts this view's principal has now, root first, in mount order. */
    mounts(): readonly MountInfo[];
    /** The mount point `path` is on ('/' for the root), whether or not its source is present. */
    mountOf(path: string): string;
    /**
     * Where an operation on `path` lands for this view's principal: the mount
     * it is on, that backend as this principal sees it, and the path the
     * backend is handed, so an embedder can call a backend's own extras. The
     * lookup is every operation's: root links on the way are followed (the
     * last only with `follow`), and `..` inside a mount whose backend resolves
     * its own paths is lexical. A mount absent for this principal (any mount
     * on the path, rule 1) answers a null source, with its absentReason.
     * Rejects as the operation's lookup would: ENOENT, ENOTDIR, EACCES, ELOOP.
     * `creating`: the lookup of a write that makes its parents (writeFile's
     * `parents`): directories missing on the way are allowed, a file among
     * them is still ENOTDIR, and a link to where nothing is yet leads there.
     */
    route(path: string, options: VfsRouteOptions & {
        report: true;
    }): Promise<VfsRouteReport>;
    route(path: string, options?: VfsRouteOptions & {
        report?: false;
    }): Promise<VfsRoute>;
    route(path: string, options?: VfsRouteOptions): Promise<VfsRoute | VfsRouteReport>;
    /**
     * The name `path` leads to now, for an open (PinnedName): links on the
     * way followed, the last only with `follow`. The open's decisions, and the
     * description it keeps (PinnedName.hold), go to the backend that lookup
     * landed on, as this view's principal sees it, whatever is mounted,
     * unmounted or linked at the name later. A directory the namespace makes
     * above mount points is the namespace's own, by its name; a mount point
     * is its backend's root. Inside a backend that resolves its own paths
     * (MountOptions.resolvesPaths) the name is held as given: a link of the
     * backend's repointed later is the backend's to follow. `sync`: through the
     * backends' synchronous faces only.
     */
    pin(path: string, options: {
        follow: boolean;
        sync: boolean;
    }): Awaitable<PinnedName>;
    /**
     * A pinned target's mutation of the file `place` finds in the mutation's
     * turn, after the observed mutations before it (the target's name, or
     * where a file held open is named then; null once it has none): refused on
     * a read-only mount and by the guard there, `admit` right before the
     * backend, observed there while `still`. `held(at)`: the held file's own
     * refusal (it is not the file at `at` now), asked after the before-image is
     * read, before the guard. A file with no name (unlinked, held open) is no
     * name's change: only the view's own check is asked. `told`: what its
     * change is told as (WriteSpec.told). `own`: the view's check is asked (a
     * pin's, its opener's call); a held file's caller's comes in `admit`.
     */
    private changingOn;
    /** A name an open found on a backend (pin). */
    private static readonly Pinned;
    /** A file a description holds (HeldFile), on the backend its pin captured. */
    private static readonly Held;
    /** A directory the namespace makes above mount points, pinned (pin): the namespace's own, by its name. */
    private static readonly NamespaceName;
    /**
     * Where a mutation of `path` lands: the namespace path its lookup resolves
     * (links on the way followed, the last only with `follow`), the mount
     * point it is on ('/' for the root), and whether that mount is read-only.
     * The lookup is the mutations' own (onMutation's), so a writer that asks
     * before it writes lands where the operation would. Rejects as that
     * lookup does: ENOENT, ENOTDIR, EACCES, ELOOP, ENXIO. Synchronous while
     * the lookup stays on synchronous backends. `creating`: as route's.
     */
    mutationRoute(path: string, options: VfsRouteOptions & {
        report: true;
    }): Awaitable<VfsMutationRouteReport>;
    mutationRoute(path: string, options?: VfsRouteOptions & {
        report?: false;
    }): Awaitable<VfsMutationRoute>;
    mutationRoute(path: string, options?: VfsRouteOptions): Awaitable<VfsMutationRoute | VfsMutationRouteReport>;
    private mutationRouteOf;
    /**
     * Whether `path` is a directory above a live mount point (not the root):
     * one the namespace keeps a directory for its mounts, so removing it is
     * EBUSY and a file at it EISDIR.
     */
    isAboveMount(path: string): boolean;
    /**
     * Whether the namespace answers `path` itself rather than the root
     * backend alone: a path on another mount, a directory above a mount point
     * (whose listing includes the mount's name), or a path under such a
     * directory that the root holds none of (absent there, whatever the root
     * holds through a link or file higher up).
     */
    composes(path: string): boolean;
    /**
     * Whether a walk over this namespace, at `path` on its way to `to` (the
     * rest of the lookup, taken lexically), hands `path` to its backend: it
     * lies past the point of a mount whose backend resolves its own paths
     * (MountOptions.resolvesPaths), and is not a directory above a mount
     * nested in it that the lookup goes on into. As `resolve` does, the walk
     * looks up the mount point, and the directories on the way into a nested
     * mount, as any other, and no component that is the backend's alone.
     *
     * A walk confined `within` a directory (a WASI preopen) hands a path over
     * only when that mount's point lies at or under it: the backend follows
     * its links anywhere in its own tree, which is then within too. From a
     * directory inside such a mount the walk looks each component up itself.
     */
    resolvedByBackend(path: string, within?: string, to?: string): boolean;
    /** The path with every link resolved, as this principal sees the namespace (ENOENT when absent). */
    realpath(path: string): string;
    /** `realpath` for a caller that can wait: links on an asynchronous mount are awaited. */
    realpathAsync(path: string): Promise<string>;
    /**
     * Where the link at `path`, reading `link` (readlink's text), leads in
     * this namespace: the one link-root rule, for a walk over the namespace
     * that follows the link itself. A mount whose backend resolves its own
     * paths reads its links from its own root, so an absolute target re-roots
     * at the mount point and a relative one climbs no higher than it; either
     * comes back as the namespace path it leads to. Null when that name is
     * another mount's (a mount nested in this one covers it): the backend
     * follows the link to its own file, which the namespace has no name for,
     * so a caller hands the link's own path to the namespace instead (whose
     * backend follows it) or takes what it leads to as unknown. Any other
     * link leads to its text. readlink answers the text, as written, so a
     * copied link is the same link.
     */
    linkLeadsTo(path: string, link: string): string | null;
    /**
     * `input` with every link the namespace follows resolved. Inside a mount
     * whose backend resolves its own paths the links are the backend's: the
     * rest is spelled as given (normalized), and the one stat that proves it
     * is there follows them.
     */
    private realpathAt;
    /** The same table as `cred` (and `actor`): sources are resolved for that principal. */
    /**
     * Refuse mutations before they reach a backend. `guard` is asked, for every
     * mutation a view with a credential makes, at the name it was given and at
     * each namespace path it lands at, right before the backend is called, on
     * the route this namespace resolved: what is checked is where the mutation
     * goes, with no second lookup between. An exclusive-mutation lease is one
     * (ProcessFiles). For every view of this table; the embedder's own view
     * (no credential) is not asked.
     */
    guardMutations(guard: MutationGuard): void;
    /** `moved` is told of every mount and unmount after it is made, for every view of this table. */
    watchMounts(moved: () => void): void;
    /**
     * `routing` is asked before a mount or unmount at a point changes what
     * anything at, beneath or above it routes to, before the table moves: it
     * throws to stop the change (RecallRequired: a held subtree is given up
     * first, and the change is made again, withRecall's).
     */
    guardRouting(routing: (point: string) => void): void;
    /**
     * This view, for one holder: `check` is asked right before each mutation
     * reaches a backend, after every lookup and read the mutation waited on,
     * and refuses by throwing. A process's bridge passes its scope's liveness,
     * so a write whose lookup was still awaited when the process was released
     * or killed (or its host lease disposed) does not land. `owner`: the
     * exclusive-mutation lease its mutations present to the guard (a wave's,
     * routed onto a mount). Shares this view's table, principal and backend
     * views; not cached, so the check is the holder's alone. A scoped view
     * scoped again keeps the checks it had (they run first) and its lease,
     * unless another is given. `holds`: the delegations its process holds,
     * presented to the backends it reaches (their views are its own then).
     */
    scoped(check: () => void, owner?: string, holds?: () => ReadonlySet<string>): CompositeVFS;
    as(cred: VfsCred, actor?: string, options?: VfsViewOptions): CompositeVFS;
    /** Who this view acts as. */
    get principal(): Principal;
    get sync(): CompositeSyncVFS;
    private resynthesize;
    /** locate(path), its rel the rest as written where the lookup handed it to a mount that resolves its own paths (LookupTrace.verbatim). */
    private located;
    /** The mount `path` (resolved, normalized) is on: the longest point at or above it. */
    private locate;
    private backend;
    /** What `mount`'s source gives this view's principal now (the backend itself, before a principal's view of it). */
    private sourceOf;
    /** `found` as this view's principal sees it (its `as`), one view per backend. */
    private backendView;
    /** `files`' synchronous face, or EAGAIN for a caller that cannot wait (an asynchronous mount). */
    private synchronousFace;
    /** The shortest mount on `path` whose source answers null for this view (rule 1), or null. */
    private absentOn;
    private absent;
    private absentReason;
    /** ENXIO when `path` is absent for this view. */
    private present;
    /** Whether `point` is a mount this view reaches (rule 1). */
    private live;
    /** The operations the backend at `route` offers, synchronous or not. */
    private ops;
    /** The root, a live mount point, or a directory above one (rule 2): this namespace's, not a backend's. */
    private isStructural;
    private hasLiveBelow;
    /**
     * A capability the backend may lack, asked after lookup (Linux order): a
     * path that is not there is ENOENT, and ENOTSUP is for a path that exists
     * on a backend without the capability. (FormalModelsLane
     * `Vfs/CompositeOps`, unsupported_is_enotsup.)
     */
    private capability;
    /**
     * readRange and the revision ops: `/` and a mount point are EISDIR;
     * anything else is the backend's, looked up before its capability is asked.
     * `written`: a write's whole content (a compare-and-write's), what
     * observers are told stands after. `creates`: a missing final component
     * is the backend's to answer, as a compare-and-write expecting revision 0
     * (nothing there: O_CREAT|O_EXCL) creates it, atomically only there. Its
     * parents are the lookup's, as any path's.
     */
    private onCapability;
    private method;
    /**
     * `input` with every root link on it followed (the last only when
     * `follow`), normalized in this namespace. A mount point or a directory
     * above one is never a link (rule 2); a component inside a mount is left to
     * that backend. ELOOP past 40 link hops.
     */
    /** `creating`: absent non-final components are allowed (mkdir -p makes them); a file among them is still ENOTDIR. */
    private resolve;
    /**
     * The directory a backend holds at a path above a mount point, or null
     * when it holds none there (then the namespace makes one: EPOCH_STAT).
     * Held means literally: under a directory the backend holds, never through
     * a link or file it holds higher up (the namespace's directory wins there).
     * A backend that resolves its own paths is asked once, for the path, and
     * follows its own links.
     */
    private heldDirectory;
    /** A mounted backend's root, or null when it cannot stat it. */
    private mountRoot;
    /** Whether this view's principal has `want` (r=4, w=2, x=1) on a stat (modeAllows); a view with no principal is not judged. */
    private permits;
    /** A stat that failed during the walk: absent (ENOENT) reads as nothing there; other errors stand. */
    private walkMiss;
    /**
     * Whether `path` lies under a directory above a mount point (not a mount
     * point, and not `path` itself as a mount name there) that its backend does
     * not hold as a directory: that directory holds only its mount names (rule 2
     * applied to ancestors: a mount covers everything under its path), whatever
     * the backend has there through a link or file.
     */
    private shadowed;
    /** ENOENT when `path` is shadowed. */
    private reachable;
    /**
     * The names the namespace itself puts in `dir` (mount points and the
     * directories above them), as directory entries, whatever `dir`'s own
     * backend holds.
     */
    mountedNames(dir: string): VfsDirent[];
    /**
     * An entry's identity in the namespace: st_dev is its mount's (the root
     * keeps its backend's), and a backend that numbers no inodes gets numbers
     * here, per path, stable while it stays mounted.
     */
    private identify;
    /** `identify`, on the mount `path` was found on (a pin's, which may since have left its point). */
    private identifyOn;
    private statAt;
    /**
     * A mount point's stat: its backend root's. Only a backend that cannot
     * stat its own root (a container that derives stat from a parent listing)
     * gets a synthesized directory; one with no modes has the namespace's.
     */
    private mountPointStat;
    /** The stat of a resolved namespace path, before its identity is stamped. */
    private statResolved;
    /** stat, with ENOENT/ENOTDIR from the backend read as "not there". */
    private softStat;
    private absentOrThrow;
    /** Mount points (and directories above live ones) directly in `dir` that this view reaches. */
    private liveNamesIn;
    private readdirAt;
    /** readdir of a path already resolved in this namespace. */
    private readdirOf;
    private emptyIfMissing;
    private onFile;
    /**
     * `parents`: missing directories on the way are made first (makeTree),
     * where the lookup lands. `written`: the whole content it writes, what
     * observers are told stands after (WriteSpec.written).
     */
    private onMutation;
    /**
     * Refuses this view's mutation at each of `paths` (the names it was given
     * and the namespace paths it lands at): by the view's own check (its
     * binding's authority, scoped), unless the caller's comes with the call
     * (`own` false: a held file's, whoever holds it), and by the table's guard
     * (guardMutations), for a view with a credential. Called right before the
     * backend is, on the path this namespace resolved.
     */
    private guardMutation;
    private mkdirAt;
    /**
     * mkdir -p of a resolved namespace path, across mounts: each missing
     * component in the filesystem it lives on, each checked by the mutation
     * guard right before it is made.
     */
    private makeTree;
    private renameAt;
    private renameIn;
    /**
     * The copy primitive: one entry or one tree, onto a name that is not there
     * (or a file onto a file, which it replaces). Within one filesystem it is
     * the backend's own (SQLite copies rows); across filesystems it copies
     * bytes, links as links. Returns the entries copied.
     *
     * A tree holding another mount point is ENOTSUP: crossing filesystems in
     * one tree is cp -r's decision (-x stays on one), not this primitive's.
     * A directory onto an existing path is EEXIST: merging into a directory
     * is cp's job too. (FormalModelsLane `Vfs/Composite`, copy_stays_in_target.)
     */
    private copyAt;
    /**
     * Copy an entry (a tree when it is a directory) between backends, links as
     * links. `toAt` is the namespace path `toRel` names: each write, link and
     * directory is guarded there (guardMutation) right before it is made,
     * after the reads it waited on, and told once it lands (watchChanges):
     * the root as `made.told` says, each entry under it as made. `made` is
     * the copy's own root: a tree copied into itself (two mounts of one
     * backend) meets it on the way and passes it by, as it was not there when
     * the copy began. With `preserve` (cp -p), an entry's metadata is the
     * source's once its content is in (preserveMetadata); a directory is made
     * writable by its owner until its entries are.
     */
    private copyBytes;
    /**
     * cp -p's metadata for an entry a copy between backends made at `toRel`
     * (`toAt` in the namespace; a file or a directory; a link's own is not
     * set, as no backend sets a link's own times or owner, and through it
     * they would land on another file): the source's owner when root copies,
     * then its mode (a chown may clear set-id bits), then its times, as the
     * backend allows each. Each is guarded right before it is made, after the
     * write it waited on, and told as a change once it lands. As a native
     * copy preserves them (SqliteVFS copyFile, planCopyTree).
     */
    private preserveMetadata;
    /** rmdir, or on a backend without it, an emptiness check and unlink. */
    private rmdirAt;
    /**
     * rm -r of one tree, with an exact report. `removed` lists the maximal
     * removed subtrees (so a native removal is just the operand), `kept` every
     * entry still there: one whose own removal failed, and the directories
     * holding it. A walked removal carries on past a failure, as rm -r does,
     * and `failures` says why each one stayed.
     */
    private removeAt;
    private walkRemove;
    stat(path: string, options?: {
        follow?: boolean;
    }): Promise<VfsStat | null>;
    /** VFS.landedAt, as this view's watches judge it (presentAt). */
    landedAt(path: string): Promise<boolean>;
    readFile(path: string): Promise<Uint8Array>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    /** `parents`: make the missing directories above where the write lands first (mkdir -p), as the write's own lookup resolves it. */
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
        parents?: boolean;
    }): Promise<void>;
    /** `parents`: as writeFile's. */
    writeRange(path: string, offset: number, bytes: Uint8Array, options?: {
        parents?: boolean;
    }): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    readdir(path: string): Promise<VfsDirent[]>;
    /**
     * `readdir` with each entry's own stat (links not followed), identified as
     * `stat` identifies it: the stat the backend's listing carries, else one
     * asked of the backend that holds the name. A name gone between the two
     * is left out.
     */
    readdirStat(path: string): Promise<Array<{
        name: string;
        stat: VfsStat;
    }>>;
    /**
     * readdirStat of a directory already resolved in this namespace: the
     * directory is looked up once, and each entry's stat (when its listing
     * does not carry one) is one call to the backend that holds it, a few at
     * a time.
     */
    private statEntries;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    removeRecursive(path: string, options?: {
        keepVanishedAncestors?: boolean;
    }): Promise<VfsRemoval>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number | null, gid: number | null): Promise<void>;
    utimes(path: string, atime: FsTime, mtime: FsTime): Promise<void>;
    writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): Promise<VfsCasResult>;
    copy(from: string, to: string, options?: VfsCopyOptions): Promise<number>;
    readFileAtRevision(path: string, revision: VfsRevision, range?: {
        offset: number;
        length: number;
    }): Promise<Uint8Array>;
    describe(): VfsMountDescription;
    private makeSync;
}
//# sourceMappingURL=composite.d.ts.map