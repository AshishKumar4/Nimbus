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
import type {
  Awaitable, Principal, SyncVFS, VFS, VfsCasResult, VfsChanges, VfsContentRef, VfsCopyOptions, VfsCred, VfsDirent, VfsMountDescription, VfsOpenFile, VfsRemoval,
  VfsRevision, VfsStat, VfsUsage, VfsViewOptions, VfsWriteEvent, VfsWriteObserver, VfsWriteWants,
} from './vfs.js';
import type { RuntimeVfsStat, VfsAcquireOptions, VfsInvalidatedPath, VfsListEntry } from '../runtime/os-contracts.js';
import { LOCAL_PLACEMENT, type ExecDelegate, type ProgramPlacement } from '../runtime/program-start.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import { inWatchedTree, projectChange, type VfsEvent, type VfsEventType } from './events.js';
import { VfsError, VFS_DESCRIPTION, isVfsError, syscallError, type VfsErrorCode } from './vfs-error.js';
import { normalizeVfsPath, parentOf } from './path.js';
import { entryVfsPath, walkVfsPath } from './path-walk.js';
import { modeAllows } from './posix-access.js';
import { recallOf, withRecall } from './recall.js';
import { DIRENT_TYPES } from './dirent-type.js';
import { walkRemoval, type RemovalSteps } from './removal-walk.js';
import { S_IFMT, abandon, andThen, copiedPermissions, copySetsMode, isCharacterDevice, isPromise, readRangeOrWhole, syncValue } from './vfs.js';
import { compareUtf8 as comparePaths } from '@nimbus-sh/platform/utf8.js';

/**
 * Where a reader of a namespace's feed stands: the mount table as its
 * principal saw it, and each change feed's epoch and cursor.
 */
export interface FeedPosition<Epoch extends string | null = string> {
  readonly table: string;
  readonly feeds: Readonly<Record<string, { readonly epoch: Epoch; readonly cursor: number }>>;
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
  list(after: string | null, limit: number, walked?: MountWalk): { entries: VfsListEntry[]; next: string | null };
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

/** `entries` in path order: as given when they already are (a backend's listing is), else sorted. */
function inPathOrder(entries: readonly VfsListEntry[]): readonly VfsListEntry[] {
  for (let i = 1; i < entries.length; i++) {
    if (comparePaths(entries[i - 1].path, entries[i].path) > 0) return [...entries].sort((a, b) => comparePaths(a.path, b.path));
  }
  return entries;
}

/** The first `limit` entries of two runs in path order, in path order. */
function mergeByPath(a: readonly VfsListEntry[], b: readonly VfsListEntry[], limit: number): VfsListEntry[] {
  const out: VfsListEntry[] = [];
  for (let i = 0, j = 0; out.length < limit && (i < a.length || j < b.length);) {
    if (j >= b.length || (i < a.length && comparePaths(a[i].path, b[j].path) <= 0)) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

/** Directories a walk (or a readdir's stats) reads at once. */
const WALK_CONCURRENCY = 8;

/** A number for each object asked of (a mount's source, a file store): the same each time, never another's. */
const objectIds = new WeakMap<object, number>();
let lastObjectId = 0;
function objectId(target: object): number {
  let id = objectIds.get(target);
  if (id === undefined) objectIds.set(target, id = ++lastObjectId);
  return id;
}

/** Identity of a mount's source object, for the table signature: 0 for none. */
function sourceId(found: unknown): number {
  return found === null || typeof found !== 'object' ? 0 : objectId(found);
}

const SYNTH_RUNTIME_STAT: RuntimeVfsStat = {
  dev: 0, ino: 0, nlink: 1, type: 'directory', size: 0, ctime: 0, atime: 0, mtime: 0, mode: 0o40755, uid: 0, gid: 0, revision: 0,
};

/**
 * A namespace entry's stat in the runtime contract's shape: its identity
 * (dev, ino) is the namespace's, and a mounted backend's entries carry no
 * SQLite revision.
 */
export function runtimeStatOf(stat: VfsStat): RuntimeVfsStat {
  // Format bits the backend's mode leaves out are its coarse type's (dirent-type.ts).
  const typeBits = DIRENT_TYPES[stat.type].format;
  const mode = stat.mode === undefined ? typeBits | (stat.type === 'directory' ? 0o755 : 0o644) : (stat.mode & S_IFMT ? stat.mode : typeBits | stat.mode);
  return {
    dev: stat.dev ?? 0, ino: stat.ino ?? 0, nlink: stat.nlink ?? 1, type: stat.type, size: stat.size,
    ctime: stat.ctimeMs ?? stat.mtimeMs, atime: stat.atimeMs ?? stat.mtimeMs, mtime: stat.mtimeMs,
    mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: typeof stat.revision === 'number' ? stat.revision : 0,
  };
}

export type { Principal } from './vfs.js';

/** The namespace always offers recursive removal, walking a backend that does not, and copies across filesystems. */
export interface CompositeSyncVFS extends SyncVFS {
  removeRecursive(path: string, options?: { keepVanishedAncestors?: boolean }): VfsRemoval;
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
  /**
   * Programs started with their cwd under the mount run on the machine its
   * files live on (Kinu ask 66): every program start (the shell's, execvp's,
   * a node child's) is placed first (placeProgram), and one placed here is
   * the delegate's to start, nothing of it run in the session.
   */
  exec?: ExecDelegate;
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
  readonly refusal: { readonly code: VfsLookupRefusalCode; readonly at: string };
}
export interface VfsMutationRoute {
  readonly path: string;
  readonly point: string;
  readonly readOnly: boolean;
}
export type VfsRouteReport = (VfsRoute & VfsTraversal) | VfsRouteRefusal;
export type VfsMutationRouteReport = (VfsMutationRoute & VfsTraversal) | VfsRouteRefusal;

/** The optional per-lookup recorder `resolve` writes while it walks; absent costs nothing. */
interface LookupTrace { links: string[]; at: string }

/**
 * A path as the namespace resolved it. `path` is the namespace's name for it
 * (normalized, root links followed), for its own rules: structure, absence,
 * EBUSY and EXDEV, reachability, events, guards; it is never looked up again.
 * Past the point of a mount that resolves its own paths, `operand` is what
 * that backend is handed: the rest as written, but for the names the
 * namespace owns on the way (CompositeVFS.forwardedTail). `spelling` names
 * the same entry when looked up again (a pin's name, a description's path,
 * realpath's answer): `path`, unless the operand has a `..`, past which the
 * backend may reach another file than the lexical name (it follows a link
 * first), or, in a lookup that does not follow its last link, ends `/` or
 * `/.` (then that link is followed); then the operand under its point, as
 * written.
 */
interface Resolution {
  readonly path: string;
  readonly operand?: { readonly point: string; readonly rel: string };
  readonly spelling: string;
}

/** A mount-relative `rel` under its `point`, root-aware and not normalized. */
function rerooted(point: string, rel: string): string {
  return point === '/' ? rel : point + rel;
}
const LOOKUP_REFUSALS: ReadonlySet<string> = new Set<VfsLookupRefusalCode>(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENXIO', 'EACCES']);

/** Whether `code` is a lookup's refusal (VfsRouteRefusal). */
function isLookupRefusal(code: string): code is VfsLookupRefusalCode {
  return LOOKUP_REFUSALS.has(code);
}

/**
 * Wrap an opt-in route call: found routes gain their traversal, and a lookup
 * refusal (a code in `at`'s words) answers as `{ links, refusal }` instead of
 * rejecting. Recall requests and backend faults still reject.
 */
function lookupReport<T extends object>(trace: LookupTrace, run: () => Awaitable<T>): Awaitable<(T & VfsTraversal) | VfsRouteRefusal> {
  const found = (route: T): T & VfsTraversal => ({ ...route, links: trace.links });
  const refused = (error: unknown): VfsRouteRefusal => {
    if (!isVfsError(error)) throw error;
    const { code } = error;
    if (!isLookupRefusal(code)) throw error;
    return { links: trace.links, refusal: { code, at: trace.at } };
  };
  try {
    const out = run();
    return isPromise(out) ? out.then(found, refused) : found(out);
  } catch (error) { return refused(error); }
}

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
  hold(rights: { read: boolean; write: boolean }, ino: number): Awaitable<HeldFile>;
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

/** What a pin captured: the mount its lookup landed on, its backend as its principal sees it, and the source's own object. */
interface PinTarget {
  readonly mount: Mount;
  readonly backend: VFS;
  /** What the mount's source gave (before a principal's view of it): the backend files are numbered by. */
  readonly source: VFS;
  readonly rel: string;
  /** The namespace's name for it (Resolution.path): what its changes are told and guarded as. */
  readonly name: string;
  /** The name that finds it again (Resolution.spelling): PinnedName.name and HeldFile.name. */
  readonly spelling: string;
  /** What its synthetic inode number is kept under (CompositeVFS.identityOf). */
  readonly identity: string;
  /** It is the mount's root (a mount point). */
  readonly root: boolean;
  readonly sync: boolean;
}

/** A `..` component: past one, a backend that resolves its own paths may reach another file than the lexical name (it follows a link first). */
const DOT_DOT = /(?:^|\/)\.\.(?:\/|$)/;

/** A path ending `/` or `/.`: its last name must be a directory, a link there followed. */
const DIRECTORY_ENDING = /\/\.?$/;

/** Where a pinned file's change lands (CompositeVFS.changingOn): its namespace name, and its name on its backend. */
interface Placed {
  readonly name: string;
  readonly rel: string;
}

/**
 * `r`, its operand given back the final separators `input`'s lookup was made
 * without (entryVfsPath): the namespace's rules take the entry, a backend
 * that resolves its own paths the name as written.
 */
function withEnding(r: Resolution, input: string): Resolution {
  const operand = r.operand;
  const ending = input.length - entryVfsPath(input).path.length;
  if (operand === undefined || ending === 0) return r;
  return { path: r.path, operand: { point: operand.point, rel: operand.rel + input.slice(input.length - ending) }, spelling: r.spelling };
}

/** Entry `name` of the directory `r` found, as its own lookup would: its operand extends the directory's (the backend's walk, not the namespace's). */
function childOf(r: Resolution, name: string): Resolution {
  const path = r.path === '/' ? `/${name}` : `${r.path}/${name}`;
  const operand = r.operand;
  if (operand === undefined) return { path, spelling: path };
  const trimmed = entryVfsPath(operand.rel).path;
  const rel = `${trimmed === '/' ? '' : trimmed}/${name}`;
  return { path, operand: { point: operand.point, rel }, spelling: DOT_DOT.test(rel) ? rerooted(operand.point, rel) : path };
}

/**
 * The operand of the directory a create makes first (writeFile's `parents`):
 * its final separators, then its last component, cut as text, so a `..`
 * inside stays the backend's to walk. None when only the point is left.
 */
function parentOperand(operand: Resolution['operand']): Resolution['operand'] {
  if (operand === undefined) return undefined;
  const trimmed = entryVfsPath(operand.rel).path;
  const rel = trimmed.slice(0, trimmed.lastIndexOf('/'));
  return rel.split('/').some((name) => name !== '' && name !== '.') ? { point: operand.point, rel } : undefined;
}

/** `fn`, a backend's optional operation, or ENOTSUP for `path` where it has none. */
function need<F>(fn: F | undefined, path: string): F {
  if (fn === undefined) throw new Refusal('ENOTSUP', path, 'this filesystem does not support it');
  return fn;
}

/**
 * Which file the number `ino` is, at `rel` on `target`: that number in its
 * backend's store (VFS.fileStore, the same through any view or wrapper of
 * those files; a backend's device number is its own, never another's to
 * compare), else its name there.
 */
function fileKey(target: PinTarget, ino: number | undefined): string {
  // A file store's own number: a dynamic source that gives another store gives other files.
  const store = objectId(storeOf(target.source));
  return ino === undefined ? `${store}:${target.rel}` : `${store}#${ino}`;
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
  turn: { tail: Promise<void>; busy: boolean };
}

/**
 * A mutation the namespace reports itself (reportWrite): where it lands, the
 * backend view it lands through, the operation's leaf-follow policy for
 * reading what is there, and what it does.
 */
interface WriteSpec<T> {
  path: string;
  route: Route;
  ops: Ops;
  follow: boolean;
  /** 'create' needs no read before; 'remove' leaves nothing after; a rename names its source. */
  kind: 'write' | 'create' | 'remove';
  oldPath?: string;
  /** mkdir -p: a directory already there is no mutation. */
  existingIsNoop?: boolean;
  /** Where it landed, by its result; default its path. */
  landed?: (result: T) => readonly string[];
  /** The whole content it writes (writeFile, a compare-and-write): what stands after, without reading it back. */
  written?: Uint8Array;
  /** Whether what it changed is still what its path names (a held file, PinnedName.hold): a change to another file is no change there. */
  still?: () => Awaitable<boolean>;
  /**
   * What its change is told as (watchChanges); by default by its kind: a
   * create addDir, a removal unlink, a rename rename, else change. Null:
   * nothing (it tells its own landings, or it made nothing).
   */
  told?: VfsEventType | null;
  /** The backend it was made on, when not the one its mount gives this view now (a pinned file's). */
  source?: VFS;
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
  /** How many mounts carry an exec delegate: none, and no program start is placed (placesPrograms). */
  delegates: number;
  /** Asked before a mount or unmount changes what a path routes to (guardRouting). */
  routing?: (point: string) => void;
}

/**
 * Why a mutation by `cred` at the namespace path `path` is refused (an
 * exclusive-mutation lease covers it), or null: CompositeVFS.guardMutations.
 * `owner`: the lease the mutation presents (a view made by `presenting`).
 */
export type MutationGuard = (cred: VfsCred, path: string, owner?: string) => { code: VfsErrorCode; detail: string } | null;

interface Views {
  refs: Map<string, WeakRef<CompositeVFS>>;
  gone: FinalizationRegistry<string>;
}

interface Route {
  mount: Mount;
  /** The backend path, '/'-rooted. */
  rel: string;
  /** The namespace path, normalized. */
  path: string;
}

type Ops = VFS | SyncVFS;

/** A directory this namespace makes (above a mount point, or a backend root with no stat). */
const EPOCH_STAT: VfsStat = { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40755, uid: 0, gid: 0 };
/** Where the namespace's own device numbers for mounts start (see Mount.dev): an entry's dev at or past it is on a mount. */
export const ANONYMOUS_DEV = 0x10000;

/** Whether `error` is a synchronous caller's refusal by an asynchronous mount (one that can await may retry on the async face). */
export function isAsyncMountRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { asyncMount?: unknown }).asyncMount === true;
}
const ROOT_POINT = '/';

/** An absolute path's first component when it is spelled plainly (not empty, `.` or `..`). */
function firstComponent(path: string): string | undefined {
  if (path.charCodeAt(0) !== 47) return undefined;
  const end = path.indexOf('/', 1);
  const first = end === -1 ? path.slice(1) : path.slice(1, end);
  return first === '' || first === '.' || first === '..' ? undefined : first;
}

/** `/a/b`, from any spelling; `..` stops at the root. */
export function normalizePath(path: string): string {
  return `/${normalizeVfsPath(String(path))}`;
}

/** `path` (at or under `point`) as the backend mounted at `point` names it: '/' at the point. */
function relativeTo(point: string, path: string): string {
  if (point === ROOT_POINT) return path;
  return path.length === point.length ? '/' : path.slice(point.length);
}

/** The store `found`'s files are in (VFS.fileStore): the backend itself, when it names none. */
function storeOf(found: VFS): object {
  return found.fileStore ?? found;
}

/** The store a mutation's `ops` (a backend, a principal's view of it, or its synchronous face) wrote in. */
function storeBehind(table: Table, ops: Ops): object {
  if (ops.fileStore !== undefined) return ops.fileStore;
  const found = table.behind.get(ops);
  return found === undefined ? ops : storeOf(found);
}

/** An rm -r report (VfsRemoval). */
function isRemoval(value: unknown): value is VfsRemoval {
  return typeof value === 'object' && value !== null && Array.isArray((value as VfsRemoval).removed);
}

/** A compare-and-write that won (VfsCasResult ok). */
function casWon(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as VfsCasResult).ok === true;
}

/** A compare-and-write expecting revision 0, nothing there: create-if-absent (SqliteFiles.writeFileIfRevision). */
function createsIfAbsent(expected: VfsRevision): boolean {
  return String(expected) === '0';
}

/**
 * An asynchronous call of the namespace: `run` reported as `call`, and run
 * again once a delegation it meets is recalled (withRecall).
 */
function awaited<T>(call: Call, run: () => Awaitable<T>): Promise<T> {
  return withRecall(() => reported(call, run));
}

/** `run`'s value, or `fallback`'s when it throws or rejects. */
function attempt<T>(run: () => Awaitable<T>, fallback: () => T): Awaitable<T> {
  try {
    const out = run();
    return isPromise(out) ? out.catch(fallback) : out;
  } catch {
    return fallback();
  }
}

const utf8 = new TextEncoder();

/** Content the namespace read itself (a backend without observeWrites): held as bytes. */
/** Content the namespace read itself, readable until it is released (the observers are done). */
interface CapturedRef extends VfsContentRef {
  release(): void;
}

function capturedRef(type: VfsContentRef['type'], bytes: Uint8Array | null): CapturedRef {
  let held = bytes;
  let released = false;
  return {
    type,
    size: bytes?.byteLength ?? 0,
    read: () => {
      if (released) throw new VfsError('EBADF', '', 'the write event was released');
      if (held === null) throw new VfsError('EISDIR', '', 'a directory has no bytes');
      return held;
    },
    release: () => { released = true; held = null; },
  };
}

/**
 * A refusal the namespace makes while it resolves or routes a path, before
 * it knows which call it refuses. The call that met it reports it
 * (`reported`), as Node reports a failed syscall. `detail` is the reason
 * where the namespace knows more than the code says.
 */
class Refusal extends VfsError {
  constructor(code: VfsErrorCode, path: string, detail?: string) {
    super(code, detail ?? VFS_DESCRIPTION[code], path);
  }
}

/** One call of the namespace as Node names it: its syscall, and the paths its caller gave. */
interface Call {
  syscall: string;
  path: string;
  dest?: string;
}

/**
 * `run`, a refusal it meets, or a backend's own filesystem error, reported as
 * Node's error for `call`: `ENOENT: no such file or directory, open '/x'`.
 * The call's syscall and the caller's paths, whatever path the backend was
 * handed (a mount-relative one, a link's target), and the reason in the
 * refusal's or the backend's own words; the error met is the cause.
 */
function reported<T>(call: Call, run: () => Awaitable<T>): Awaitable<T> {
  const report = (error: unknown): never => {
    if (!isVfsError(error)) throw error;
    const out = syscallError(error.code, call.syscall, call.path, { detail: error.detail, dest: call.dest, cause: error });
    throw isAsyncMountRefusal(error) ? Object.assign(out, { asyncMount: true as const }) : out;
  };
  try {
    const out = run();
    return isPromise(out) ? out.catch(report) : out;
  } catch (error) {
    return report(error);
  }
}

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

function principalKey(principal: Principal): string {
  const { cred, actor } = principal;
  const id = cred === null ? '-' : `${cred.uid}:${cred.gid}:${[...cred.groups].join(',')}:${cred.umask}`;
  return actor === undefined ? id : `${id}@${actor}`;
}

export class CompositeVFS implements VFS {
  private readonly table: Table;
  private readonly viewer: Principal;
  /** Backends seen as this view's principal (a backend's `as` view is made once per view). */
  private readonly viewed: WeakMap<VFS, VFS>;
  /** Asked right before each of this view's mutations reaches a backend (scoped). */
  private readonly check: (() => void) | undefined;
  /** The exclusive-mutation lease this view's mutations present (scoped's `owner`). */
  private readonly owner: string | undefined;
  /** The delegations this view's process holds (scoped's `holds`): presented to every backend it reaches. */
  private readonly holds: (() => ReadonlySet<string>) | undefined;
  /** Whether its reads read what has landed (as's `landed`): presented to every backend it reaches. */
  private readonly landed: boolean;
  /**
   * Views per principal, held weakly: one per principal while someone holds
   * it, none once no one does (a table serving thousands of agents does not
   * keep a view per agent for its life).
   */
  private readonly views: Views;
  private readonly syncView: CompositeSyncVFS;

  constructor(root: VfsSource, options?: MountOptions);
  /** @internal a view over the same table. */
  constructor(root: VfsSource, options: MountOptions | undefined, shared: ViewShare);
  constructor(root: VfsSource, options: MountOptions = {}, shared?: ViewShare) {
    this.viewed = shared?.viewed ?? new WeakMap();
    this.check = shared?.check;
    this.owner = shared?.owner;
    this.holds = shared?.holds;
    this.landed = shared?.landed === true;
    if (shared) {
      this.table = shared.table;
      this.viewer = shared.principal;
      this.views = shared.views;
    } else {
      this.table = { mounts: new Map([[ROOT_POINT, { point: ROOT_POINT, under: ROOT_POINT, source: root, options, dev: null, inos: new Map() }]]), generation: 0, lastDev: 0, synthesized: new Map(), behind: new WeakMap(), delegates: options.exec === undefined ? 0 : 1 };
      this.viewer = { cred: null };
      const refs = new Map<string, WeakRef<CompositeVFS>>();
      this.views = { refs, gone: new FinalizationRegistry((key: string) => {
        if (refs.get(key)?.deref() === undefined) refs.delete(key);
      }) };
    }
    this.syncView = this.makeSync();
  }

  // ── the feed ───────────────────────────────────────────────────────────

  /** This principal's namespace feed. */
  get feed(): CompositeFeed {
    return {
      position: () => this.feedPosition(this.feedSignature(), this.feedSources()),
      since: (position, options) => this.feedSince(position, options),
      list: (after, limit, walked) => this.feedList(after, limit, walked),
      walk: (named, limit) => this.walkUnfed(named, limit),
    };
  }

  /**
   * The mount table as this principal sees it: which mounts are live, which
   * have a feed, and what answers at each. A change is not in any backend's
   * feed, so a reader holding another signature relists.
   */
  private feedSignature(): string {
    const parts: string[] = [];
    for (const mount of this.table.mounts.values()) {
      const found = typeof mount.source === 'function' ? mount.source(this.viewer) : mount.source;
      const live = mount.point === ROOT_POINT || this.live(mount);
      const files = live ? this.backend(mount) : null;
      parts.push(`${mount.point}\u0000${live ? 1 : 0}\u0000${files?.changes ? 1 : 0}\u0000${sourceId(found)}`);
    }
    return parts.join('\u0001');
  }

  /** Live mounts with their backend's feed (none: only the point is staged). */
  private feedSources(): Array<{ mount: Mount; changes: VfsChanges | undefined }> {
    const out: Array<{ mount: Mount; changes: VfsChanges | undefined }> = [];
    for (const mount of this.table.mounts.values()) {
      if (mount.point !== ROOT_POINT && !this.live(mount)) continue;
      const files = this.backend(mount);
      if (files !== null) out.push({ mount, changes: files.changes });
    }
    return out;
  }

  private feedPosition(table: string, sources: Array<{ mount: Mount; changes: VfsChanges | undefined }>): FeedPosition {
    const feeds: Record<string, { epoch: string; cursor: number }> = {};
    for (const { mount, changes } of sources) {
      if (changes) feeds[mount.point] = { epoch: changes.epoch, cursor: changes.revision() };
    }
    return { table, feeds };
  }

  private static reroot(point: string, path: string): string {
    if (point === ROOT_POINT) return path;
    return path === '/' ? point : point + path;
  }

  /** Whether the namespace shows `path` from `mount`: routed there, not covered, reachable. */
  private feedShows(path: string, mount: Mount): boolean {
    if (this.locate(path).mount !== mount || this.absentOn(path) !== null) return false;
    return !this.isStructural(path) || this.table.mounts.get(path) === mount;
  }

  private feedSince(position: FeedPosition<string | null>, options?: VfsAcquireOptions): FeedAnswer {
    const table = this.feedSignature();
    const sources = this.feedSources();
    const poison = (): FeedAnswer => ({ position: this.feedPosition(table, sources), poison: true, paths: [] });
    if (position.table !== table) return poison();
    const feeds: Record<string, { epoch: string; cursor: number }> = {};
    const paths: VfsInvalidatedPath[] = [];
    for (const { mount, changes } of sources) {
      if (!changes) continue;
      const held = position.feeds[mount.point];
      if (held === undefined) return poison();
      const delta = changes.since(held.epoch, held.cursor, options);
      if (delta.poison) return poison();
      feeds[mount.point] = { epoch: delta.epoch, cursor: delta.rev };
      for (const entry of delta.paths) {
        const at = CompositeVFS.reroot(mount.point, entry.path);
        if (this.feedShows(at, mount)) {
          paths.push(at === entry.path ? entry : { ...entry, path: at });
          continue;
        }
        // A covered row changing is nothing to the reader, except at a
        // directory this namespace makes: a removal reported there (once, at
        // the subtree's root) also took root rows the namespace does show,
        // and which ones only a relist can say.
        if (this.isStructural(at) && this.locate(at).mount === mount && (entry.subtree === true || entry.structural === true)) {
          return poison();
        }
      }
    }
    return { position: { table, feeds }, poison: false, paths };
  }

  /**
   * One page of every name the namespace shows, in path order: each feed's
   * listing re-rooted and filtered, merged with the directories the
   * namespace makes (mount points and their ancestors) and with `walked`
   * (the names a walk of the mounts without a feed found, which stand for
   * those mounts). A mount without a feed shows only its point otherwise.
   * Take `position()` before the first page.
   */
  private feedList(after: string | null, limit: number, walked: MountWalk = []): { entries: VfsListEntry[]; next: string | null } {
    const want = Math.max(1, limit);
    const past = (path: string): boolean => after === null || comparePaths(path, after) > 0;
    const streams: Array<{ entries: readonly VfsListEntry[]; more: boolean }> = [];
    const walkedPaths = new Set(walked.map((entry) => entry.path));
    const made: VfsListEntry[] = [];
    for (const point of [...this.table.mounts.keys(), ...this.table.synthesized.keys()]) {
      if (point === ROOT_POINT || !this.isStructural(point) || !past(point) || walkedPaths.has(point)) continue;
      if (made.some((entry) => entry.path === point)) continue;
      // One whose entries are a mount's without a feed, and that the walk did
      // not list, is unlisted: what is in it is not known absent.
      const holder = this.locate(point).mount;
      const unfed = holder.point !== ROOT_POINT && this.backend(holder)?.changes === undefined;
      made.push({ path: point, kind: 'directory', size: 0, rev: 0, stat: this.madeStat(point), ...(unfed ? { unlisted: holder.point } : {}) });
    }
    streams.push({ entries: made, more: false });
    streams.push({ entries: walked.filter((entry) => past(entry.path)), more: false });
    for (const { mount, changes } of this.feedSources()) {
      if (!changes) continue;
      const point = mount.point;
      let from: string | null;
      if (point === ROOT_POINT || after === null || comparePaths(after, `${point}/`) < 0) from = point === ROOT_POINT ? after : null;
      else if (after.startsWith(`${point}/`)) from = after.slice(point.length);
      else continue;
      const entries: VfsListEntry[] = [];
      let more = true;
      while (entries.length < want && more) {
        const page = changes.list(from, want);
        for (const entry of page.entries) {
          const at = CompositeVFS.reroot(point, entry.path);
          if (past(at) && this.feedShows(at, mount) && at !== point) {
            entries.push(at === entry.path ? entry : { ...entry, path: at });
          }
        }
        more = page.next !== null;
        from = page.next;
      }
      streams.push({ entries, more });
    }
    // Each stream is in path order already (a backend's listing is, the
    // directories made and the walk are sorted): merged, not sorted whole.
    let merged: readonly VfsListEntry[] = [];
    for (const stream of streams) merged = mergeByPath(merged, inPathOrder(stream.entries), want + 1);
    const entries = merged.slice(0, want);
    const more = merged.length > want || streams.some((stream) => stream.more);
    return { entries, next: more && entries.length > 0 ? entries[entries.length - 1].path : null };
  }

  /**
   * A directory the namespace makes, as a listing entry: its stat as `stat`
   * answers it (the mounted root's own, or the directory the backend beneath
   * holds there), where that can be answered without waiting.
   */
  private madeStat(point: string): RuntimeVfsStat {
    try {
      const stat = this.statAt(point, false, true);
      if (stat === null || isPromise(stat) || stat.type !== 'directory') return SYNTH_RUNTIME_STAT;
      return runtimeStatOf(stat);
    } catch {
      return SYNTH_RUNTIME_STAT;
    }
  }

  /** The mounts without a feed that this principal reaches: a point under a directory it cannot search is left out, as a listing leaves out a name there. */
  private async unfedPoints(): Promise<Map<string, VfsStat>> {
    const reached = new Map<string, VfsStat>();
    await Promise.all([...this.table.mounts.values()].map(async (mount) => {
      if (mount.point === ROOT_POINT || !this.live(mount) || this.backend(mount)?.changes !== undefined) return;
      const stat = await (async () => this.statAt(mount.point, true, false))().catch(() => null);
      if (stat !== null && stat.type === 'directory') reached.set(mount.point, stat);
    }));
    return reached;
  }

  /** CompositeFeed.walk. */
  private async walkUnfed(named: Iterable<string>, limit: number): Promise<MountWalk> {
    const found = new Map<string, VfsListEntry>();
    const stats = new Map<string, VfsStat>();
    const put = (path: string, stat: VfsStat, linkTarget?: string): void => {
      stats.set(path, stat);
      found.set(path, {
        path, kind: stat.type, size: stat.size, rev: 0, stat: runtimeStatOf(stat),
        ...(linkTarget === undefined ? {} : { linkTarget }),
      });
    };
    const points = await this.unfedPoints();
    for (const [point, stat] of points) put(point, stat);
    // Where the names lead: each one's directory and those above it, down
    // from its mount point; a name the listings show as a directory, whole.
    const levels = new Set<string>();
    const wanted = new Set<string>();
    for (const name of named) {
      const path = normalizePath(name);
      const point = this.locate(path).mount.point;
      if (!points.has(point)) continue;
      wanted.add(path);
      if (path === point) continue;
      for (let dir = parentOf(path); ; dir = parentOf(dir)) {
        levels.add(dir);
        if (dir === point) break;
      }
    }
    let room = limit;
    const listed = new Set<string>();
    const tried = new Set<string>();
    /** One directory, whole, when this principal may search it and its names fit: its child directories. */
    const list = async (dir: string): Promise<string[]> => {
      if (tried.has(dir)) return [];
      tried.add(dir);
      if (!stats.has(dir) && !listed.has(parentOf(dir)) && this.locate(dir).mount.options.resolvesPaths) {
        const own = await (async () => this.statAt(dir, true, false))().catch(() => null);
        if (own !== null) put(dir, own);
      }
      const held = stats.get(dir);
      if (room <= 0 || held === undefined || held.type !== 'directory' || !this.permits(held, 1)) return [];
      let entries: Array<{ name: string; stat: VfsStat }>;
      try { entries = await this.statEntries(dir); } catch { return []; }
      const fresh = entries.filter(({ name }) => !found.has(`${dir}/${name}`));
      if (fresh.length > room) return [];
      room -= fresh.length;
      const links = fresh.filter(({ stat }) => stat.type === 'symlink');
      for (const { name, stat } of fresh) if (stat.type !== 'symlink') put(`${dir}/${name}`, stat);
      // A link the namespace cannot name the target of (one it cannot read,
      // or one its backend follows to a name a nested mount covers) is left
      // out, and its directory is then not listed: what it leads to is not
      // known, rather than absent.
      let named = true;
      for (let i = 0; i < links.length; i += WALK_CONCURRENCY) {
        await Promise.all(links.slice(i, i + WALK_CONCURRENCY).map(async ({ name, stat }) => {
          const target = await this.readlink(`${dir}/${name}`).catch(() => null);
          const leads = target === null ? null : this.linkLeadsTo(`${dir}/${name}`, target);
          if (leads === null) named = false;
          else put(`${dir}/${name}`, stat, leads);
        }));
      }
      if (named) listed.add(dir);
      return entries.filter(({ stat }) => stat.type === 'directory').map(({ name }) => `${dir}/${name}`);
    };
    // Top down, a depth at a time: each directory is named by its parent's listing before its own.
    const depth = (path: string): number => path.split('/').length;
    const ordered = [...levels].sort((a, b) => depth(a) - depth(b) || comparePaths(a, b));
    for (let i = 0; i < ordered.length;) {
      const batch = [ordered[i++]];
      while (i < ordered.length && batch.length < WALK_CONCURRENCY && depth(ordered[i]) === depth(batch[0])) batch.push(ordered[i++]);
      await Promise.all(batch.map(list));
    }
    const queue = [...wanted].filter((path) => found.get(path)?.kind === 'directory').sort(comparePaths);
    while (queue.length > 0 && room > 0) {
      for (const dirs of await Promise.all(queue.splice(0, WALK_CONCURRENCY).map(list))) queue.push(...dirs);
    }
    for (const entry of found.values()) {
      if (entry.kind === 'directory' && !listed.has(entry.path)) entry.unlisted = this.locate(entry.path).mount.point;
    }
    return [...found.values()].sort((a, b) => comparePaths(a.path, b.path));
  }

  // ── the table ──────────────────────────────────────────────────────────

  mount(point: string, source: VfsSource, options: MountOptions = {}): void {
    const at = normalizePath(point);
    if (at === ROOT_POINT) throw syscallError('EBUSY', 'mount', point, { detail: 'the root is mounted at construction' });
    if (this.table.mounts.has(at)) throw syscallError('EBUSY', 'mount', point, { detail: 'something is already mounted there' });
    this.table.routing?.(at);
    const mount: Mount = { point: at, under: `${at}/`, source, options, dev: ANONYMOUS_DEV + ++this.table.lastDev, inos: new Map() };
    this.table.mounts.set(at, mount);
    this.table.generation++;
    if (options.exec !== undefined) this.table.delegates++;
    this.resynthesize();
    if (this.table.writes !== undefined) this.subscribeWrites(mount);
    for (const watch of this.table.changes?.watches ?? []) {
      try {
        watch.view.subscribeChanges(watch, mount);
      } catch (error) {
        // Its backend refuses the watch: its changes through this namespace are told all the same.
        console.error('[composite-vfs] a mount refused a change watch:', error instanceof Error ? error.message : String(error));
      }
    }
    this.table.moved?.();
  }

  /** The mount table's generation: it moves with every mount and unmount, in every view of this namespace. */
  mountGeneration(): number {
    return this.table.generation;
  }

  /** Whether a mount carries an exec delegate: in a namespace with none, every program runs here, nothing asked. */
  placesPrograms(): boolean {
    return this.table.delegates > 0;
  }

  /**
   * Where a program started with its cwd at `cwd` runs (MountOptions.exec),
   * for this view's principal: by the mount the cwd is on, links into it
   * followed, as every lookup finds it (route). A cwd the namespace cannot
   * look up is no mount's: the program is placed here, to fail as it would.
   */
  async placeProgram(cwd: string): Promise<ProgramPlacement> {
    if (this.table.delegates === 0) return LOCAL_PLACEMENT;
    let route: VfsRoute;
    try {
      route = await this.route(cwd, { follow: true });
    } catch (error) {
      if (isVfsError(error)) return LOCAL_PLACEMENT;
      throw error;
    }
    const exec = this.table.mounts.get(route.point)?.options.exec;
    if (exec === undefined) return LOCAL_PLACEMENT;
    if (route.source === null) return { kind: 'absent', reason: route.absentReason ?? 'its mount is absent' };
    return { kind: 'delegated', delegate: exec, cwd: route.path };
  }

  unmount(point: string): void {
    const at = normalizePath(point);
    const mount = this.table.mounts.get(at);
    if (at === ROOT_POINT || mount === undefined) throw syscallError('EINVAL', 'umount', point, { detail: 'nothing is mounted there' });
    this.table.routing?.(at);
    this.table.mounts.delete(at);
    this.table.generation++;
    if (mount.options.exec !== undefined) this.table.delegates--;
    this.table.writes?.subscribed.get(mount)?.();
    this.table.writes?.subscribed.delete(mount);
    for (const watch of this.table.changes?.watches ?? []) {
      const stop = watch.subscribed.get(mount);
      watch.subscribed.delete(mount);
      try {
        stop?.();
      } catch (error) {
        console.error('[composite-vfs] a change watch could not be stopped:', error instanceof Error ? error.message : String(error));
      }
    }
    this.resynthesize();
    this.table.moved?.();
  }

  // ── write observation ─────────────────────────────────────────────────

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
  observeWrites(observer: VfsWriteObserver, options?: { wants?: (path: string, principal: Principal) => VfsWriteWants }): () => void {
    const writes = this.table.writes ??= { watches: new Set(), subscribed: new Map(), turn: { tail: Promise.resolve(), busy: false } };
    const watch: WriteWatch = { observer, wants: options?.wants ?? (() => true) };
    writes.watches.add(watch);
    if (writes.watches.size === 1) for (const mount of this.table.mounts.values()) this.subscribeWrites(mount);
    return () => {
      if (!writes.watches.delete(watch) || writes.watches.size > 0) return;
      // No one observes: a backend that holds content for observers stops.
      for (const stop of writes.subscribed.values()) stop();
      writes.subscribed.clear();
      if (this.table.writes === writes) delete this.table.writes;
    };
  }

  /**
   * Subscribe to `mount`'s backend when it reports its own writes (a source
   * fixed for every principal). An event is the namespace's only where the
   * principal that made it is shown that path from this mount (routed there,
   * not covered by another mount or a directory above one, reachable): a
   * root write beneath a mount point changed nothing the namespace shows
   * there. A rename half shown is the delete, or the create, its shown half is.
   */
  private subscribeWrites(mount: Mount): void {
    const writes = this.table.writes!;
    const source = mount.source;
    if (typeof source === 'function' || typeof source.observeWrites !== 'function' || writes.subscribed.has(mount)) return;
    writes.subscribed.set(mount, source.observeWrites((event) => {
      const view = this.viewOf(event.principal);
      const shown = (backendPath: string): string | null => {
        const at = CompositeVFS.reroot(mount.point, backendPath);
        return view.feedShows(at, mount) ? at : null;
      };
      const path = shown(event.path);
      if (event.oldPath === undefined) return path === null ? undefined : this.deliverWrite({ ...event, path });
      const oldPath = shown(event.oldPath);
      const { type: _type, oldPath: _oldPath, ...rest } = event;
      if (path !== null && oldPath !== null) return this.deliverWrite({ ...rest, type: 'rename', path, oldPath });
      if (path !== null) return this.deliverWrite({ ...rest, type: event.before === null ? 'create' : 'modify', path });
      if (oldPath !== null) return this.deliverWrite({ ...rest, type: 'delete', path: oldPath, before: event.after, after: null });
      return undefined;
    }));
  }

  /** This table as `principal` sees it (the embedder's own view for a principal with no credential). */
  private viewOf(principal: Principal): CompositeVFS {
    if (principal.cred !== null) return this.as(principal.cred, principal.actor);
    if (this.viewer.cred === null && this.viewer.actor === principal.actor) return this;
    const key = principalKey(principal);
    let view = this.views.refs.get(key)?.deref();
    if (view === undefined) {
      view = new CompositeVFS(this.table.mounts.get(ROOT_POINT)!.source, undefined, { table: this.table, principal, views: this.views });
      this.views.refs.set(key, new WeakRef(view));
      this.views.gone.register(view, key);
    }
    return view;
  }

  /**
   * `event` to every observer of this table. Settles once each is done (a
   * backend holds the event's content until then); `release` lets go of
   * what the namespace captured itself, then, whatever an observer did.
   */
  private deliverWrite(event: VfsWriteEvent, release?: () => void): Promise<void> | undefined {
    const pending: Promise<void>[] = [];
    for (const { observer } of this.table.writes?.watches ?? []) {
      try {
        const out = observer(event);
        if (out !== undefined && isPromise(out)) pending.push(out);
      } catch (error) {
        console.error('[composite-vfs] a write observer failed:', error instanceof Error ? error.message : String(error));
      }
    }
    if (pending.length === 0) {
      release?.();
      return undefined;
    }
    return Promise.allSettled(pending).then(() => { release?.(); });
  }

  // ── change notification ───────────────────────────────────────────────

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
  watchChanges(path: string, listener: (events: readonly VfsEvent[]) => void, options?: { follow?: boolean }): () => void {
    const changes = this.table.changes ??= { watches: new Set(), ready: [], draining: false };
    const watch: ChangeWatch = {
      view: this, path: normalizePath(path), follow: options?.follow === true, listener, subscribed: new Map(), queue: [], waiting: false, stopped: false, present: null,
    };
    try {
      const found = this.presentAt(watch.path);
      const looking: Awaitable<boolean> = !isPromise(found) ? found : found.then((there) => {
        if (watch.present === looking) watch.present = there;
        return there;
      }, () => {
        if (watch.present === looking) watch.present = null;
        return false;
      });
      watch.present = looking;
    } catch {
      watch.present = null;
    }
    changes.watches.add(watch);
    try {
      for (const mount of this.table.mounts.values()) this.subscribeChanges(watch, mount);
    } catch (error) {
      this.stopWatch(changes, watch);
      throw error;
    }
    return () => this.stopWatch(changes, watch);
  }

  /** `watch` let go: nothing more told, each backend subscription stopped (all of them, whichever throws). */
  private stopWatch(changes: ChangeWatches, watch: ChangeWatch): void {
    if (watch.stopped) return;
    watch.stopped = true;
    watch.queue.length = 0;
    changes.watches.delete(watch);
    if (changes.watches.size === 0 && this.table.changes === changes) delete this.table.changes;
    let failed: unknown = null;
    for (const stop of watch.subscribed.values()) {
      try {
        stop();
      } catch (error) {
        failed ??= error;
      }
    }
    watch.subscribed.clear();
    if (failed !== null) throw failed;
  }

  /**
   * Watch `mount`'s backend, as this view sees it, where it tells its own
   * changes and holds part of `watch`'s tree: a source fixed for every
   * principal (one that gives a backend per principal, or per moment, is
   * told as the namespace changes it). The whole of it: what is under the
   * watched path, and where it moves to, is the namespace's to judge (a
   * rename does not leave its mount).
   */
  private subscribeChanges(watch: ChangeWatch, mount: Mount): void {
    if (typeof mount.source === 'function') return;
    const { path } = watch;
    if (!inWatchedTree(mount.point, path) && !inWatchedTree(path, mount.point)) return;
    const backend = this.backend(mount);
    if (backend === null || typeof backend.watchChanges !== 'function') return;
    const { point } = mount;
    const named = (event: VfsEvent): VfsEvent => (event.oldPath === undefined
      ? { type: event.type, path: CompositeVFS.reroot(point, event.path), timestamp: event.timestamp }
      : { type: event.type, path: CompositeVFS.reroot(point, event.path), oldPath: CompositeVFS.reroot(point, event.oldPath), timestamp: event.timestamp });
    watch.subscribed.set(mount, backend.watchChanges('/', (events) => {
      const changes = this.table.changes;
      if (changes === undefined || watch.stopped) return;
      this.publishChanges(changes, watch, { mount, events: point === ROOT_POINT ? events : events.map(named), judged: true });
      this.drainChanges(changes);
    }));
  }

  /**
   * `result`, `spec`'s mutation's answer, once it landed: its change told,
   * then, to the watches registered now (tellLanded). One that awaits is
   * told when it lands, before its caller hears the answer.
   */
  private landing<T>(spec: WriteSpec<T>, result: Awaitable<T>): Awaitable<T> {
    if (spec.told === null) return result;
    if (isPromise(result)) {
      // Beside the answer, not in its way: told as it settles, before the caller resumes.
      result.then((value) => this.tellSpec(spec, value), () => {});
      return result;
    }
    if (this.table.changes !== undefined) this.tellSpec(spec, result);
    return result;
  }

  private tellSpec<T>(spec: WriteSpec<T>, value: T): void {
    if (this.table.changes === undefined) return;
    const { oldPath } = spec;
    const type = spec.told ?? (oldPath !== undefined ? 'rename' : spec.kind === 'create' ? 'addDir' : spec.kind === 'remove' ? 'unlink' : 'change');
    this.tellLanded(spec.route.mount, spec.source === undefined ? storeBehind(this.table, spec.ops) : storeOf(spec.source), type, spec.landed?.(value) ?? [spec.path], oldPath);
  }

  /**
   * A change of `type` that landed at `paths` (and from `oldPath`) through
   * `mount`, in `store` (the one the mutation was routed to, whatever the
   * mount gives now), to each watch registered now: at every mount through
   * which that watch's view sees the same store, unless that mount's
   * backend tells the watch its own.
   */
  private tellLanded(mount: Mount, store: object, type: VfsEventType, paths: readonly string[], oldPath?: string): void {
    const changes = this.table.changes;
    if (changes === undefined) return;
    const timestamp = Date.now();
    const rels = paths.map((at) => relativeTo(mount.point, at));
    const oldRel = oldPath === undefined ? undefined : relativeTo(mount.point, oldPath);
    for (const watch of [...changes.watches]) {
      for (const other of this.table.mounts.values()) {
        if (watch.subscribed.has(other)) continue;
        let theirs: VFS | null;
        try {
          theirs = watch.view.sourceOf(other);
        } catch (error) {
          // A source that fails this watch's view shows it nothing there; the change landed, and every other watch is told.
          console.error('[composite-vfs] a change could not be judged:', error instanceof Error ? error.message : String(error));
          continue;
        }
        if (theirs === null || storeOf(theirs) !== store) continue;
        this.publishChanges(changes, watch, {
          mount: other,
          judged: false,
          events: rels.map((rel): VfsEvent => {
            const at = CompositeVFS.reroot(other.point, rel);
            return oldRel === undefined ? { type, path: at, timestamp } : { type, path: at, oldPath: CompositeVFS.reroot(other.point, oldRel), timestamp };
          }),
        });
      }
    }
    this.drainChanges(changes);
  }

  private publishChanges(changes: ChangeWatches, watch: ChangeWatch, batch: Changes): void {
    if (batch.events.length === 0 || watch.stopped) return;
    watch.queue.push(batch);
    changes.ready.push(watch);
  }

  /**
   * Each published batch told, in order, one drain at a time: a change a
   * listener makes is published behind the ones being told, and told after
   * them.
   */
  private drainChanges(changes: ChangeWatches): void {
    if (changes.draining) return;
    changes.draining = true;
    try {
      for (let watch = changes.ready.shift(); watch !== undefined; watch = changes.ready.shift()) watch.view.tellQueued(changes, watch);
    } finally {
      changes.draining = false;
    }
  }

  /** `watch`'s queued batches, judged and told in order; one judged by awaiting holds the rest until it is told. */
  private tellQueued(changes: ChangeWatches, watch: ChangeWatch): void {
    while (!watch.stopped && !watch.waiting) {
      const batch = watch.queue.shift();
      if (batch === undefined) return;
      let judged: Awaitable<VfsEvent[]>;
      try {
        judged = this.judgeChanges(watch, batch);
      } catch (error) {
        // A batch that cannot be judged is not told; the write that made it, and every other watch, go on.
        console.error('[composite-vfs] a change could not be judged:', error instanceof Error ? error.message : String(error));
        continue;
      }
      if (isPromise(judged)) {
        watch.waiting = true;
        void judged.then((events) => {
          watch.waiting = false;
          this.tellWatch(watch, events);
        }, (error: unknown) => {
          watch.waiting = false;
          console.error('[composite-vfs] a change could not be judged:', error instanceof Error ? error.message : String(error));
        }).finally(() => {
          changes.ready.push(watch);
          this.drainChanges(changes);
        });
        return;
      }
      this.tellWatch(watch, judged);
    }
  }

  private tellWatch(watch: ChangeWatch, events: readonly VfsEvent[]): void {
    if (watch.stopped || events.length === 0) return;
    try {
      watch.listener(events);
    } catch (error) {
      console.error('[composite-vfs] a change watcher failed:', error instanceof Error ? error.message : String(error));
    }
  }

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
  private judgeChanges(watch: ChangeWatch, batch: Changes): Awaitable<VfsEvent[]> {
    const { mount, events, judged } = batch;
    if (this.table.mounts.get(mount.point) !== mount) return [];
    // The path the namespace looks up for an end its backend told: on a mount whose backend judged it, its first name there.
    const lookedUp = (path: string): string => {
      if (!judged || path === mount.point) return path;
      const rest = relativeTo(mount.point, path);
      const slash = rest.indexOf('/', 1);
      return CompositeVFS.reroot(mount.point, slash === -1 ? rest : rest.slice(0, slash));
    };
    const routedFrom = (tree: string): ((path: string) => boolean) => {
      // No other mount at, above or in the watched tree: every path in it is this mount's to show.
      let alone = true;
      for (const other of this.table.mounts.values()) {
        if (other !== mount && other.point !== ROOT_POINT && (inWatchedTree(tree, other.point) || inWatchedTree(other.point, tree))) alone = false;
      }
      return (path) => (alone && inWatchedTree(tree, path)) || this.feedShows(path, mount);
    };
    // Where the watched path went when a directory above it was renamed, or null.
    const movedBy = (event: VfsEvent, tree: string): string | null => {
      const from = event.oldPath;
      return from !== undefined && from !== tree && inWatchedTree(from, tree) ? event.path + tree.slice(from.length) : null;
    };
    const cred = this.viewer.cred;
    const everywhere = cred === null || cred.uid === 0;
    // This view's answers, by path, as each settles: whether it may search to it, whether something is there.
    const searched = new Map<string, Awaitable<boolean>>();
    const present = new Map<string, Awaitable<boolean>>();
    const ask = (known: Map<string, Awaitable<boolean>>, path: string, lookup: (path: string) => Awaitable<boolean>): Awaitable<boolean> => {
      let answer = known.get(path);
      if (answer === undefined) {
        answer = lookup(path);
        if (isPromise(answer)) answer = answer.then((found) => { known.set(path, found === true); return found === true; });
        known.set(path, answer);
      }
      return answer;
    };
    const searchable = (path: string): Awaitable<boolean> => this.searchable(path);
    const presentAt = (path: string): Awaitable<boolean> => this.presentAt(path);
    if (!everywhere) {
      for (const event of events) {
        ask(searched, lookedUp(event.path), searchable);
        if (event.oldPath !== undefined) ask(searched, lookedUp(event.oldPath), searchable);
      }
    }
    // Where the watched path a directory above it took to `moved` (event i) is now, through the moves this watch
    // has been published since.
    const carriedTo = (i: number, moved: string): string => {
      let at = moved;
      for (const later of [events.slice(i + 1), ...watch.queue.map((queued) => queued.events)]) {
        for (const event of later) {
          const from = event.oldPath;
          if (from !== undefined && inWatchedTree(from, at)) at = event.path + at.slice(from.length);
        }
      }
      return at;
    };
    // Whether something is at the watched path `tree` after `event`, from whether it was before (watch.present):
    // its own change says (a change, wherever it is told, leaves something there); one under it says it is a
    // directory; one made, removed or replaced (not known) above it says. Moved away, it is wherever the watch went.
    const after = (event: VfsEvent, tree: string, was: Awaitable<boolean> | null, carried: boolean | null): Awaitable<boolean> | null => {
      const { type, path, oldPath: from } = event;
      if (from !== undefined && inWatchedTree(from, tree)) return carried ?? false;
      if (path === tree) return type !== 'unlink' && type !== 'unlinkDir';
      if (inWatchedTree(tree, path) || (from !== undefined && inWatchedTree(tree, from))) return true;
      if (inWatchedTree(path, tree)) return type === 'change' ? was : type === 'rename' ? null : false;
      return was;
    };
    const told: VfsEvent[] = [];
    const judgeFrom = (start: number): Awaitable<VfsEvent[]> => {
      // A wait may outlast the mount.
      if (this.table.mounts.get(mount.point) !== mount) return told;
      let routed = routedFrom(watch.path);
      for (let i = start; i < events.length; i++) {
        const event = events[i]!;
        const tree = watch.path;
        const moved = movedBy(event, tree);
        let along: { was: boolean; seen: boolean } | null = null;
        if (moved !== null) {
          const known = watch.present;
          // The look the watch began with settles first.
          if (isPromise(known)) return known.then(() => judgeFrom(i));
          const at = carriedTo(i, moved);
          const there = known ?? ask(present, at, presentAt);
          const seen = everywhere || ask(searched, at, searchable);
          if (isPromise(there) || isPromise(seen)) return Promise.all([there, seen]).then(() => judgeFrom(i));
          along = { was: there, seen };
        }
        const shown = (path: string): string | null => {
          if (!routed(path)) return null;
          if (path === moved) return along?.seen === true ? path : null;
          return everywhere || searched.get(lookedUp(path)) === true ? path : null;
        };
        const one = projectChange(event, tree, shown, watch.follow, () => along?.was === true);
        const follows = one !== null && watch.follow && one.type === 'rename' && one.oldPath === tree;
        watch.present = after(event, tree, watch.present, follows ? along?.was ?? true : null);
        if (one === null) continue;
        told.push(one);
        if (follows) {
          watch.path = one.path;
          routed = routedFrom(watch.path);
        }
      }
      return told;
    };
    const asked = [...searched.values()].filter(isPromise);
    return asked.length === 0 ? judgeFrom(0) : Promise.all(asked).then(() => judgeFrom(0));
  }

  /**
   * Whether something is at `path` for this view (lstat, its own lookup), by awaiting where its mount does: on a
   * backend that holds changes back, as they have been told (VFS.landedAt), its own lookup storing and recalling nothing.
   */
  private presentAt(path: string, canWait = true): Awaitable<boolean> {
    const decide = (sync: boolean): Awaitable<boolean> => {
      const refused = (error: unknown): boolean => {
        if (isVfsError(error)) return false;
        throw error;
      };
      try {
        if (!this.isStructural(path) && this.absentOn(path) === null) {
          const route = this.locate(path);
          const ops = this.ops(route, sync);
          if (typeof ops.landedAt === 'function') {
            this.check?.();
            const found = ops.landedAt(route.rel);
            return isPromise(found) ? found.then((there) => there === true, refused) : found === true;
          }
        }
        const stat = this.statAt(path, false, sync);
        return isPromise(stat) ? stat.then((found) => found !== null, refused) : stat !== null;
      } catch (error) {
        if (sync && isAsyncMountRefusal(error)) {
          if (canWait) return decide(false);
          throw error;
        }
        return refused(error);
      }
    };
    return decide(true);
  }

  /**
   * Whether this view may search every directory above `path`, by its own
   * lookup (resolve, the last component not looked at), and, on a mount that
   * resolves its own paths, by that backend's (access). A directory no
   * longer there (a removed tree, its entries told after it) cannot be
   * judged: what was under it is not shown.
   */
  private searchable(path: string): Awaitable<boolean> {
    const refused = (error: unknown): boolean => {
      if (isVfsError(error)) return false;
      throw error;
    };
    const decide = (sync: boolean): Awaitable<boolean> => {
      try {
        const at = this.resolve(path, false, sync);
        const within = (to: Resolution): Awaitable<boolean> => (to.path === path ? this.searchableWithin(path, sync) : false);
        return isPromise(at) ? at.then(within, refused) : within(at);
      } catch (error) {
        if (sync && isAsyncMountRefusal(error)) return decide(false);
        return refused(error);
      }
    };
    return decide(true);
  }

  /** On a mount that resolves its own paths, whether its backend lets this view search the directory holding `path` (access, search). */
  private searchableWithin(path: string, sync: boolean): Awaitable<boolean> {
    const route = this.locate(path);
    if (!route.mount.options.resolvesPaths || path === route.mount.point) return true;
    const files = this.backend(route.mount);
    if (files === null) return false;
    const face = sync ? files.sync : files;
    if (face === undefined) return this.searchableWithin(path, false);
    // A backend of one identity has no modes to search by.
    if (face.access === undefined) return true;
    const refused = (error: unknown): boolean => {
      if (isVfsError(error)) return false;
      throw error;
    };
    try {
      this.check?.();
      const searched = face.access(relativeTo(route.mount.point, parentOf(path)), 1);
      return isPromise(searched) ? searched.then(() => true, refused) : true;
    } catch (error) {
      return refused(error);
    }
  }

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
  private reportWrite<T>(spec: WriteSpec<T>, run: () => Awaitable<T>, sync: boolean): Awaitable<T> {
    const writes = this.table.writes;
    if (writes === undefined || writes.subscribed.has(spec.route.mount)) {
      const result = run();
      return this.table.changes === undefined && !isPromise(result) ? result : this.landing(spec, result);
    }
    return this.inTurn(writes, spec.route.mount, spec.path, sync, () => this.reportIn(writes, spec, run));
  }

  /**
   * reportWrite of the mutation `prepare` gives, prepared in its turn, after
   * the observed mutations queued before it (a held-open file's change is
   * placed where that file is then). Its `spec` null: a change at no name,
   * reported to no one. `name`: the mutation's name before it is placed.
   */
  private reportPrepared<T>(
    mount: Mount, name: string, sync: boolean, prepare: () => Awaitable<{ spec: WriteSpec<T> | null; run: () => Awaitable<T> }>,
  ): Awaitable<T> {
    const writes = this.table.writes;
    if (writes === undefined || writes.subscribed.has(mount)) {
      return andThen(prepare(), ({ spec, run }) => {
        const result = run();
        return spec === null || (this.table.changes === undefined && !isPromise(result)) ? result : this.landing(spec, result);
      });
    }
    return this.inTurn(writes, mount, name, sync, () => andThen(prepare(), ({ spec, run }) => (spec === null ? run() : this.reportIn(writes, spec, run))));
  }

  /** `report` in its turn among the observed mutations (takeTurn); a caller that cannot wait is refused while another holds it. */
  private inTurn<T>(writes: WriteWatches, mount: Mount, name: string, sync: boolean, report: () => Awaitable<T>): Awaitable<T> {
    if (sync) {
      // A caller that cannot wait cannot take a turn: while another's
      // section holds this backend, it is refused as an asynchronous mount
      // refuses it (a caller that can wait retries on the asynchronous face).
      if (writes.turn.busy) {
        throw Object.assign(
          new Refusal('EAGAIN', name, `${mount.point}: an observed write to this filesystem is in flight; this caller cannot wait for it`),
          { asyncMount: true as const },
        );
      }
      return report();
    }
    return this.takeTurn(writes, report);
  }

  /** reportWrite's report of `spec`'s mutation, `run`, in its turn. */
  private reportIn<T>(writes: WriteWatches, spec: WriteSpec<T>, run: () => Awaitable<T>): Awaitable<T> {
    const principal = this.viewer;
    let wantsBefore = false;
    let wantsAfter = false;
    for (const watch of writes.watches) {
      const wants = watch.wants(spec.path, principal);
      wantsBefore ||= typeof wants === 'boolean' ? wants : wants.before;
      wantsAfter ||= typeof wants === 'boolean' ? wants : wants.after;
      if (wantsBefore && wantsAfter) break;
    }
    const { path, route, ops, follow, kind, oldPath, written } = spec;
    const held: CapturedRef[] = [];
    // Whether what stood before was a regular file (not a device): with a
    // backend that stores what it is written, the bytes it was given are
    // then its after-image (VFS.storesWrites).
    let regular = false;
    const capture = (read: boolean): Awaitable<VfsContentRef | null | false> => this.capture(ops, route.rel, read, follow, held, (stat) => {
      regular = stat.type === 'file' && !isCharacterDevice(stat.mode);
    });
    const release = (): void => { for (const ref of held) ref.release(); };
    // A plain mkdir made what was not there (EEXIST otherwise); mkdir -p looks.
    const before = kind === 'create' && spec.existingIsNoop !== true ? null : capture(wantsBefore);
    return andThen(before, (prior) => {
      // Nothing to make: mkdir -p of a directory that is there (nothing changed, nothing told).
      if (kind === 'create' && prior !== null && prior !== false && prior.type === 'directory') {
        release();
        return run();
      }
      return andThen(this.landing(spec, run()), (result) => {
        const landed = spec.landed?.(result) ?? [path];
        if (landed.length === 0) { release(); return result; }
        const stores = written !== undefined && wantsAfter && (ops as VFS).storesWrites === true && (prior === null || regular);
        const after = kind === 'remove' ? null
          : stores ? this.keep(held, 'file', written.slice())
            : capture(wantsAfter);
        return andThen(after, (now) => andThen(spec.still?.() ?? true, (still) => {
          // What the namespace no longer shows there (its mount left its point, or one mounted since covers it,
          // or its name holds another file now): no change to what is there now.
          if (!still || !this.feedShows(path, route.mount)) { release(); return result; }
          const known = (ref: VfsContentRef | null | false): VfsContentRef | null | undefined => (ref === false ? undefined : ref);
          if (kind === 'remove') {
            const heard = landed.map((at) => this.deliverWrite({
              type: 'delete', path: at, before: at === path ? known(prior) : undefined, after: null, principal,
            })).filter((done) => done !== undefined);
            if (heard.length === 0) release();
            else void Promise.all(heard).then(release);
            return result;
          }
          const type: VfsWriteEvent['type'] = oldPath !== undefined ? 'rename' : prior === null ? 'create' : 'modify';
          this.deliverWrite({ type, path, ...(oldPath !== undefined ? { oldPath } : {}), before: known(prior), after: known(now), principal }, release);
          return result;
        }));
      });
    });
  }

  /** `run` once every observed mutation queued before it is done; those after it wait for it. */
  private async takeTurn<T>(writes: WriteWatches, run: () => Awaitable<T>): Promise<T> {
    const { turn } = writes;
    const prior = turn.tail;
    let done!: () => void;
    turn.tail = new Promise<void>((resolve) => { done = resolve; });
    try {
      await prior;
      turn.busy = true;
      return await run();
    } finally {
      turn.busy = false;
      done();
    }
  }


  /**
   * What stands at `rel` on a backend that does not report its own writes,
   * as the operation sees it (`follow`: through a link at the leaf): null
   * when nothing does, its content when `read`, false when what is there
   * was not read (not wanted, or the backend would not say). What it reads
   * is held in `held`, let go when the observers are done.
   */
  private capture(
    ops: Ops, rel: string, read: boolean, follow: boolean, held: CapturedRef[], seen?: (stat: VfsStat) => void,
  ): Awaitable<VfsContentRef | null | false> {
    const keep = (type: VfsContentRef['type'], bytes: Uint8Array | null): VfsContentRef => this.keep(held, type, bytes);
    return attempt(() => andThen(this.softStat(ops, rel, follow), (stat): Awaitable<VfsContentRef | null | false> => {
      if (stat === null) return null;
      seen?.(stat);
      if (stat.type === 'directory') return keep('directory', null);
      if (!read) return false;
      this.check?.();
      if (stat.type === 'symlink') return andThen((ops as SyncVFS).readlink!(rel), (target) => keep('symlink', utf8.encode(target)));
      return andThen((ops as SyncVFS).readFile(rel), (bytes) => keep('file', bytes));
    }), () => false);
  }

  /** Content the observers are told of, held in `held` until they are done. */
  private keep(held: CapturedRef[], type: VfsContentRef['type'], bytes: Uint8Array | null): VfsContentRef {
    const ref = capturedRef(type, bytes);
    held.push(ref);
    return ref;
  }

  /** Whether the table declares an accepted mount point, even if its source is absent. */
  someMountPoint(wants: (point: string) => boolean): boolean {
    for (const mount of this.table.mounts.values()) {
      if (wants(mount.point)) return true;
    }
    return false;
  }

  /** The mounts this view's principal has now, root first, in mount order. */
  mounts(): readonly MountInfo[] {
    const out: MountInfo[] = [];
    for (const mount of this.table.mounts.values()) {
      const files = this.backend(mount);
      if (files === null) continue;
      out.push({
        point: mount.point,
        source: mount.source,
        options: mount.options,
        describe: () => files.describe?.() ?? { source: 'none', type: 'vfs', options: [mount.options.readOnly ? 'ro' : 'rw'] },
        usage: async () => (await files.usage?.()) ?? null,
      });
    }
    return out;
  }

  /** The mount point `path` is on ('/' for the root), whether or not its source is present. */
  mountOf(path: string): string {
    return this.locate(normalizePath(path)).mount.point;
  }

  /**
   * Where an operation on `path` lands for this view's principal: the mount
   * it is on, that backend as this principal sees it, and the path the
   * backend is handed, so an embedder can call a backend's own extras. The
   * lookup is every operation's: root links on the way are followed (the
   * last only with `follow`), and a mount whose backend resolves its own
   * paths is handed the rest as written (Resolution.operand). A mount absent for this principal (any mount
   * on the path, rule 1) answers a null source, with its absentReason.
   * Rejects as the operation's lookup would: ENOENT, ENOTDIR, EACCES, ELOOP.
   * `creating`: the lookup of a write that makes its parents (writeFile's
   * `parents`): directories missing on the way are allowed, a file among
   * them is still ENOTDIR, and a link to where nothing is yet leads there.
   */
  route(path: string, options: VfsRouteOptions & { report: true }): Promise<VfsRouteReport>;
  route(path: string, options?: VfsRouteOptions & { report?: false }): Promise<VfsRoute>;
  route(path: string, options?: VfsRouteOptions): Promise<VfsRoute | VfsRouteReport>;
  async route(path: string, options?: VfsRouteOptions): Promise<VfsRoute | VfsRouteReport> {
    const trace: LookupTrace | undefined = options?.report === true ? { links: [], at: normalizePath(path) } : undefined;
    const run = (): Awaitable<VfsRoute> => awaited({ syscall: 'route', path }, () => {
      // A recalled lookup starts over: keep only the traversal that answers.
      if (trace !== undefined) { trace.links.length = 0; trace.at = normalizePath(path); }
      return andThen(this.resolve(path, options?.follow === true, false, options?.creating === true, trace), (resolved): Awaitable<VfsRoute> => {
        const at = resolved.path;
        const gone = this.absentOn(at);
        if (gone !== null) {
          if (trace !== undefined) { trace.at = gone.point; throw this.absent(gone, at); }
          return { point: gone.point, source: null, path: relativeTo(gone.point, at), absentReason: this.absentReason(gone) };
        }
        const { mount, rel } = this.routeOf(resolved);
        const source = this.backend(mount);
        if (source === null) {
          if (trace !== undefined) { trace.at = mount.point; throw this.absent(mount, at); }
          return { point: mount.point, source, path: rel, absentReason: this.absentReason(mount) };
        }
        // A path the namespace does not show (under a directory above a mount
        // that its holder does not hold as one) is refused as an operation on it is.
        return andThen(this.reachable(at, false), (value): Awaitable<VfsRoute> => {
          if (trace !== undefined) trace.at = at;
          return { point: mount.point, source, path: rel };
        });
      });
    });
    return trace === undefined ? run() : lookupReport(trace, run);
  }

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
  pin(path: string, options: { follow: boolean; sync: boolean }): Awaitable<PinnedName> {
    const run = (): Awaitable<PinnedName> => andThen(this.resolve(path, options.follow, options.sync), (resolved) => {
      const at = resolved.path;
      this.present(at);
      const point = this.table.mounts.get(at);
      if (point === undefined && this.isStructural(at)) return new CompositeVFS.NamespaceName(this, at, options.sync);
      const route = this.routeOf(resolved);
      const source = this.sourceOf(route.mount);
      if (source === null) throw this.absent(route.mount, at);
      return andThen(this.reachable(at, options.sync), (): PinnedName => {
        // Found by awaiting, a file on a backend that answers at once is held as one: its description need not await.
        const files = this.backendView(source);
        const sync = options.sync || files.sync !== undefined;
        const backend: VFS = sync ? this.synchronousFace(files, route) : files;
        return new CompositeVFS.Pinned(this, {
          mount: route.mount, backend, source, rel: route.rel, name: at, spelling: resolved.spelling, identity: this.identityOf(resolved), root: point !== undefined, sync,
        });
      });
    });
    return options.sync ? reported({ syscall: 'open', path }, run) : awaited({ syscall: 'open', path }, run);
  }

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
  private changingOn<T>(
    target: PinTarget, place: () => Awaitable<Placed | null>, run: () => Awaitable<T>, admit: (() => void) | undefined,
    written: Uint8Array | undefined, still: (at: Placed) => Awaitable<boolean>, held?: (at: Placed | null) => Awaitable<void>, told?: VfsEventType, own = true,
  ): Awaitable<T> {
    const { mount, backend } = target;
    if (mount.options.readOnly) throw new Refusal('EROFS', target.name, `${mount.point} is mounted read-only`);
    return this.reportPrepared(mount, target.name, target.sync, () => andThen(place(), (at) => {
      const admitted = (): Awaitable<T> => {
        this.guardMutation(at === null ? [] : [at.name], own);
        admit?.();
        return run();
      };
      const guarded = held === undefined ? admitted : (): Awaitable<T> => andThen(held(at), admitted);
      if (at === null) return { spec: null, run: guarded };
      const { name, rel } = at;
      const spec: WriteSpec<T> = { path: name, route: { mount, path: name, rel }, ops: backend, follow: true, kind: 'write', still: () => still(at), source: target.source, written, told };
      return { spec, run: guarded };
    }));
  }

  /** A name an open found on a backend (pin). */
  private static readonly Pinned = class implements PinnedName {
    readonly name: string;
    readonly awaits: boolean;

    constructor(private readonly host: CompositeVFS, private readonly target: PinTarget) {
      this.name = target.spelling;
      this.awaits = !target.sync;
    }

    private call<T>(syscall: string, run: () => Awaitable<T>): Awaitable<T> {
      const call = { syscall, path: this.target.name };
      return this.target.sync ? reported(call, run) : awaited(call, run);
    }

    private statAt(follow: boolean): Awaitable<VfsStat | null> {
      const { host, target } = this;
      host.check?.();
      return andThen(target.root ? host.mountPointStat(target.backend) : target.backend.stat(target.rel, { follow }), (stat) => (
        stat === null ? null : host.identifyOn(target.mount, target.identity, stat)));
    }

    lstat(): Awaitable<VfsStat | null> { return this.call('lstat', () => this.statAt(false)); }
    stat(): Awaitable<VfsStat | null> { return this.call('stat', () => this.statAt(true)); }

    access(mode: number): Awaitable<void> {
      const { backend, rel } = this.target;
      const access = backend.access;
      if (access !== undefined) return this.call('open', () => { this.host.check?.(); return access.call(backend, rel, mode); });
    }

    create(mode: number | undefined, admit?: () => void): Awaitable<void> {
      const { backend, rel } = this.target;
      const empty = new Uint8Array(0);
      // O_CREAT of a name with nothing at it (openOnMount): the file it makes is told as made.
      return this.call('open', () => this.host.changingOn(this.target, () => this.target, () => backend.writeFile(rel, empty, mode === undefined ? undefined : { mode }), admit, empty, () => true, undefined, 'add'));
    }

    truncate(size: number, admit?: () => void): Awaitable<void> {
      const { backend, rel } = this.target;
      return this.call('open', () => this.host.changingOn(this.target, () => this.target, () => need(backend.truncate, this.target.name).call(backend, rel, size), admit, undefined, () => true));
    }

    key(): Awaitable<string | null> {
      this.host.check?.();
      return andThen(this.target.backend.stat(this.target.rel), (stat) => (stat === null ? null : fileKey(this.target, stat.ino)));
    }

    readAll(): Awaitable<Uint8Array> {
      return this.call('open', () => { this.host.check?.(); return this.target.backend.readFile(this.target.rel); });
    }

    hold(rights: { read: boolean; write: boolean }, ino: number): Awaitable<HeldFile> {
      const { host, target } = this;
      const { backend, rel } = target;
      const decided = (stat: VfsStat | null): VfsStat => {
        if (stat === null) throw new Refusal('ENOENT', target.name);
        if (host.identifyOn(target.mount, target.identity, stat).ino !== ino) throw new Refusal('ESTALE', target.name, 'the file the open decided on is not the one at its name now');
        return stat;
      };
      return this.call('open', () => andThen((host.check?.(), target.root ? host.mountPointStat(backend) : backend.stat(rel)), (there) => {
        const stat = decided(there);
        const openFile = backend.openFile;
        if (stat.type !== 'file' || openFile === undefined) return new CompositeVFS.Held(host, target, stat, null);
        host.check?.();
        return andThen(openFile.call(backend, rel, rights), (file) => {
          const bound = (opened: VfsStat): HeldFile => new CompositeVFS.Held(host, target, decided(opened), file);
          try {
            const opened = file.stat();
            return isPromise(opened) ? opened.then(bound).catch((error: unknown) => { abandon(file); throw error; }) : bound(opened);
          } catch (error) {
            abandon(file);
            throw error;
          }
        });
      }));
    }
  };

  /** A file a description holds (HeldFile), on the backend its pin captured. */
  private static readonly Held = class implements HeldFile {
    readonly name: string;
    readonly awaits: boolean;
    /** Its backend's number for it, when it numbers its files: the file at its name after its own replace of it (replace). */
    private ino: number | undefined;

    constructor(
      private readonly host: CompositeVFS,
      private readonly target: PinTarget,
      opened: VfsStat,
      /** The backend's own open file, where it keeps them (VFS.openFile). */
      private readonly file: VfsOpenFile | null,
    ) {
      this.name = target.spelling;
      this.awaits = !target.sync;
      this.ino = opened.ino;
    }

    get key(): string {
      return fileKey(this.target, this.ino);
    }

    private call<T>(syscall: string, run: () => Awaitable<T>): Awaitable<T> {
      const call = { syscall, path: this.target.name };
      return this.target.sync ? reported(call, run) : awaited(call, run);
    }

    /** Whether `now`, what its name holds, is this file: always, where the backend numbers none. */
    private is(now: VfsStat | null): boolean {
      return this.ino === undefined || this.target.root || now?.ino === this.ino;
    }

    private still(admit?: () => void): Awaitable<boolean> {
      const { backend, rel, root } = this.target;
      if (this.ino === undefined || root) return true;
      admit?.();
      return andThen(backend.stat(rel), (now) => this.is(now));
    }

    private stale(): never {
      throw new Refusal('ESTALE', this.target.name, 'the name this file was opened at holds another file now, or none');
    }

    /** Refused (ESTALE) once its name holds another file, or none. */
    private here(admit?: () => void): Awaitable<void> {
      return andThen(this.still(admit), (still) => (still ? undefined : this.stale()));
    }

    /** `run` by its name, refused (ESTALE) once the name holds another file, or none, `admit` asked before each. */
    private named<T>(run: () => Awaitable<T>, admit: (() => void) | undefined): Awaitable<T> {
      return andThen(this.here(admit), () => { admit?.(); return run(); });
    }

    /**
     * A change through the file the backend holds open: guarded, captured and
     * observed at the name it has in the change's turn (changingOn), none once
     * unlinked. One the backend renamed by itself while the before-image was
     * read is refused (ESTALE); one renamed before its change is published is
     * no change at its old name.
     */
    private changing<T>(syscall: string, file: VfsOpenFile, run: () => Awaitable<T>, admit: (() => void) | undefined, written?: Uint8Array): Awaitable<T> {
      const { host, target } = this;
      const place = (): Awaitable<Placed | null> => andThen(file.path(), (rel) => (rel === null ? null : { name: CompositeVFS.reroot(target.mount.point, rel), rel }));
      const there = (at: Placed | null): Awaitable<boolean> => andThen(file.path(), (now) => now === (at?.rel ?? null));
      const stays = (at: Placed | null): Awaitable<void> => andThen(there(at), (still) => {
        if (!still) throw new Refusal('ESTALE', target.name, 'the file moved while its change was prepared');
      });
      return this.call(syscall, () => host.changingOn(target, place, run, admit, written, there, stays, undefined, false));
    }

    stat(admit?: () => void): Awaitable<VfsStat> {
      const { host, target, file } = this;
      const now = (): Awaitable<VfsStat | null> => {
        admit?.();
        return file !== null ? file.stat()
          : target.root ? host.mountPointStat(target.backend)
            : andThen(target.backend.stat(target.rel), (there) => (this.is(there) ? there : this.stale()));
      };
      return this.call('fstat', () => andThen(now(), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', target.name);
        return host.identifyOn(target.mount, target.identity, stat);
      }));
    }

    read(offset: number, length: number, admit?: () => void): Awaitable<Uint8Array> {
      const { file, target } = this;
      return this.call('read', () => (file !== null ? (admit?.(), file.read(offset, length)) : this.named(() => readRangeOrWhole(target.backend, target.rel, offset, length), admit)));
    }

    readAll(admit?: () => void): Awaitable<Uint8Array> {
      const { file, target } = this;
      return this.call('read', () => (file !== null
        ? andThen((admit?.(), file.stat()), (stat) => { admit?.(); return file.read(0, stat.size); })
        : this.named(() => target.backend.readFile(target.rel), admit)));
    }

    write(offset: number, bytes: Uint8Array, admit?: () => void): Awaitable<void> {
      const { file, target } = this;
      if (file !== null) return this.changing('write', file, () => file.write(offset, bytes), admit);
      return this.call('write', () => this.host.changingOn(target, () => target, () => need(target.backend.writeRange, target.name).call(target.backend, target.rel, offset, bytes), admit, undefined, () => this.still(admit), () => this.here(admit), undefined, false));
    }

    /** By its name, the file there after it is this one: a backend may write a whole file as a new one (a new number) at its name. */
    replace(bytes: Uint8Array, admit?: () => void): Awaitable<void> {
      const { file, target } = this;
      // Written, then cut to its length: a write that fails leaves the file as it was.
      if (file !== null) return this.changing('write', file, () => andThen(file.write(0, bytes), () => file.truncate(bytes.byteLength)), admit, bytes);
      const { backend, rel } = target;
      return this.call('write', () => andThen(this.host.changingOn(target, () => target, () => backend.writeFile(rel, bytes), admit, bytes, () => true, () => this.here(admit), undefined, false), () => (
        this.ino === undefined ? undefined : andThen(backend.stat(rel), (now) => { if (now?.ino !== undefined) this.ino = now.ino; }))));
    }

    truncate(size: number, admit?: () => void): Awaitable<void> {
      const { file, target } = this;
      if (file !== null) return this.changing('ftruncate', file, () => file.truncate(size), admit);
      return this.byName('ftruncate', (backend) => need(backend.truncate, target.name).call(backend, target.rel, size), admit);
    }

    chmod(mode: number, admit?: () => void): Awaitable<void> {
      return this.byName('fchmod', (backend) => need(backend.chmod, this.target.name).call(backend, this.target.rel, mode), admit);
    }

    chown(uid: number | null, gid: number | null, admit?: () => void): Awaitable<void> {
      return this.byName('fchown', (backend) => need(backend.chown, this.target.name).call(backend, this.target.rel, uid, gid), admit);
    }

    utimes(atime: FsTime, mtime: FsTime, admit?: () => void): Awaitable<void> {
      return this.byName('futimes', (backend) => need(backend.utimes, this.target.name).call(backend, this.target.rel, atime, mtime), admit);
    }

    /** A mutation at its name (refused once that holds another file): `run` on its backend. */
    private byName(syscall: string, run: (backend: VFS) => Awaitable<void>, admit: (() => void) | undefined): Awaitable<void> {
      const { target } = this;
      return this.call(syscall, () => this.host.changingOn(target, () => target, () => run(target.backend), admit, undefined, () => this.still(admit), () => this.here(admit), undefined, false));
    }

    /** A mount point's entries: its backend root's, and the mount points the namespace puts in it while that mount is still there. */
    readdir(admit?: () => void): Awaitable<VfsDirent[]> {
      const { host, target } = this;
      return this.call('scandir', () => this.named(() => andThen(target.backend.readdir(target.rel), (entries) => {
        if (!target.root || host.table.mounts.get(target.mount.point) !== target.mount) return entries;
        const mounted = host.mountedNames(target.name);
        const covered = new Set(mounted.map((entry) => entry.name));
        return [...entries.filter((entry) => !covered.has(entry.name)), ...mounted];
      }), admit));
    }

    close(): Awaitable<void> {
      return this.file?.close();
    }
  };

  /** A directory the namespace makes above mount points, pinned (pin): the namespace's own, by its name. */
  private static readonly NamespaceName = class implements PinnedName {
    readonly awaits: boolean;

    constructor(private readonly host: CompositeVFS, readonly name: string, private readonly sync: boolean) {
      this.awaits = !sync;
    }

    private get files(): Pick<VFS, 'stat' | 'readdir' | 'chmod' | 'chown' | 'utimes'> {
      return this.sync ? this.host.sync : this.host;
    }

    lstat(): Awaitable<VfsStat | null> { return this.files.stat(this.name, { follow: false }); }
    stat(): Awaitable<VfsStat | null> { return this.files.stat(this.name); }
    access(): Awaitable<void> {}
    create(): Awaitable<void> { throw new Refusal('EISDIR', this.name); }
    truncate(): Awaitable<void> { throw new Refusal('EISDIR', this.name); }
    key(): Awaitable<string | null> { return `namespace:${this.name}`; }
    readAll(): Awaitable<Uint8Array> { throw new Refusal('EISDIR', this.name); }

    hold(): Awaitable<HeldFile> {
      const { name, awaits } = this;
      const files = this.files;
      const directory = (): never => { throw new Refusal('EISDIR', name); };
      return {
        name, awaits, key: `namespace:${name}`,
        stat: (admit) => andThen((admit?.(), files.stat(name)), (stat) => {
          if (stat === null) throw new Refusal('ENOENT', name);
          return stat;
        }),
        read: directory, readAll: directory, write: directory, replace: directory, truncate: directory,
        chmod: (mode, admit) => { admit?.(); return need(files.chmod, name).call(files, name, mode); },
        chown: (uid, gid, admit) => { admit?.(); return need(files.chown, name).call(files, name, uid, gid); },
        utimes: (atime, mtime, admit) => { admit?.(); return need(files.utimes, name).call(files, name, atime, mtime); },
        readdir: (admit) => { admit?.(); return files.readdir(name); },
        close: () => {},
      };
    }
  };

  /**
   * Where a mutation of `path` lands: the namespace path its lookup resolves
   * (links on the way followed, the last only with `follow`), the mount
   * point it is on ('/' for the root), and whether that mount is read-only.
   * The lookup is the mutations' own (onMutation's), so a writer that asks
   * before it writes lands where the operation would. Rejects as that
   * lookup does: ENOENT, ENOTDIR, EACCES, ELOOP, ENXIO. Synchronous while
   * the lookup stays on synchronous backends. `creating`: as route's.
   */
  mutationRoute(path: string, options: VfsRouteOptions & { report: true }): Awaitable<VfsMutationRouteReport>;
  mutationRoute(path: string, options?: VfsRouteOptions & { report?: false }): Awaitable<VfsMutationRoute>;
  mutationRoute(path: string, options?: VfsRouteOptions): Awaitable<VfsMutationRoute | VfsMutationRouteReport>;
  mutationRoute(path: string, options?: VfsRouteOptions): Awaitable<VfsMutationRoute | VfsMutationRouteReport> {
    if (options?.report !== true) return this.mutationRouteOf(path, options, undefined);
    const trace: LookupTrace = { links: [], at: normalizePath(path) };
    return lookupReport(trace, () => this.mutationRouteOf(path, options, trace));
  }

  private mutationRouteOf(path: string, options: VfsRouteOptions | undefined, trace: LookupTrace | undefined): Awaitable<VfsMutationRoute> {
    return reported({ syscall: 'route', path }, () => {
      if (trace !== undefined) { trace.links.length = 0; trace.at = normalizePath(path); }
      return andThen(this.resolve(path, options?.follow === true, false, options?.creating === true, trace), ({ path: at }) => {
        if (trace !== undefined) trace.at = this.absentOn(at)?.point ?? at;
        this.present(at);
        const { mount } = this.locate(at);
        return { path: at, point: mount.point, readOnly: mount.options.readOnly === true };
      });
    });
  }

  /**
   * Whether `path` is a directory above a live mount point (not the root):
   * one the namespace keeps a directory for its mounts, so removing it is
   * EBUSY and a file at it EISDIR.
   */
  isAboveMount(path: string): boolean {
    const at = normalizePath(path);
    return at !== ROOT_POINT && !this.table.mounts.has(at) && this.isStructural(at);
  }

  /**
   * Whether the namespace answers `path` itself rather than the root
   * backend alone: a path on another mount, a directory above a mount point
   * (whose listing includes the mount's name), or a path under such a
   * directory that the root holds none of (absent there, whatever the root
   * holds through a link or file higher up).
   */
  composes(path: string): boolean {
    // A path whose first component is no mount point's first component is
    // the root backend's alone: no mount, and no directory above one, is on
    // it or above it. Only a spelling that `..` could move is normalized.
    const first = firstComponent(path);
    if (first !== undefined && !path.includes('/..') && this.table.synthesized.get(ROOT_POINT)?.has(first) !== true) return false;
    const at = normalizePath(path);
    if (this.locate(at).mount.point !== ROOT_POINT) return true;
    if (at === ROOT_POINT) return false;
    if (this.isStructural(at)) return true;
    for (let dir = at.slice(0, at.lastIndexOf('/')); dir !== ''; dir = dir.slice(0, dir.lastIndexOf('/'))) {
      if (!this.isStructural(dir)) continue;
      const held = this.heldDirectory(dir, true);
      return !isPromise(held) && held === null;
    }
    return false;
  }

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
  resolvedByBackend(path: string, within: string = ROOT_POINT, to: string = path): boolean {
    const at = normalizePath(path);
    const { mount } = this.locate(at);
    if (mount.options.resolvesPaths !== true || at === mount.point) return false;
    if (this.isStructural(at) && this.locate(normalizePath(to)).mount !== mount) return false;
    const bound = normalizePath(within);
    return bound === ROOT_POINT || mount.point === bound || mount.point.startsWith(`${bound}/`);
  }

  /** The path with every link resolved, as this principal sees the namespace (ENOENT when absent). */
  realpath(path: string): string {
    return syncValue(reported({ syscall: 'realpath', path }, () => this.realpathAt(path, true)));
  }

  /** `realpath` for a caller that can wait: links on an asynchronous mount are awaited. */
  async realpathAsync(path: string): Promise<string> {
    return awaited({ syscall: 'realpath', path }, () => this.realpathAt(path, false));
  }

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
   * backend follows it) or takes what it leads to as unknown. A relative
   * link read at a spelling past a `..` (Resolution.spelling) leads to its
   * text, from that spelling. Any other link leads to its text. readlink answers the text, as written, so a
   * copied link is the same link.
   */
  linkLeadsTo(path: string, link: string): string | null {
    const route = this.locate(normalizePath(path));
    if (!route.mount.options.resolvesPaths) return link;
    // Read at a name past a `..` its backend walks (a walk anchored at a directory
    // opened so), a relative target is the walk's to follow from that name.
    if (!link.startsWith('/') && DOT_DOT.test(path)) return link;
    const inBackend = normalizePath(link.startsWith('/') ? link : `${parentOf(route.rel)}/${link}`);
    const leads = inBackend === ROOT_POINT ? route.mount.point : `${route.mount.point}${inBackend}`;
    return this.locate(leads).mount === route.mount ? leads : null;
  }

  /**
   * `input` with every link the namespace follows resolved. Inside a mount
   * whose backend resolves its own paths the links are the backend's: the
   * rest is its spelling (Resolution.spelling: past a `..` the backend walks,
   * as handed to it, so it reads back the same entry; the backend's own
   * canonical name may be hidden by a mount), and the one stat that proves it
   * is there follows them.
   */
  private realpathAt(input: string, sync: boolean): Awaitable<string> {
    return andThen(this.resolve(input, true, sync), (r) => {
      const follow = this.locate(r.path).mount.options.resolvesPaths === true;
      return andThen(this.statResolved(r.path, follow, sync, r), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', input);
        return entryVfsPath(r.spelling).path;
      });
    });
  }

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
  guardMutations(guard: MutationGuard): void {
    this.table.guard = guard;
  }

  /** `moved` is told of every mount and unmount after it is made, for every view of this table. */
  watchMounts(moved: () => void): void {
    this.table.moved = moved;
  }

  /**
   * `routing` is asked before a mount or unmount at a point changes what
   * anything at, beneath or above it routes to, before the table moves: it
   * throws to stop the change (RecallRequired: a held subtree is given up
   * first, and the change is made again, withRecall's).
   */
  guardRouting(routing: (point: string) => void): void {
    this.table.routing = routing;
  }

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
  scoped(check: () => void, owner?: string, holds?: () => ReadonlySet<string>): CompositeVFS {
    const outer = this.check;
    const composed = outer === undefined ? check : () => { outer(); check(); };
    const lease = owner ?? this.owner;
    const held = holds ?? this.holds;
    return new CompositeVFS(this.table.mounts.get(ROOT_POINT)!.source, undefined, {
      table: this.table, principal: this.viewer, views: this.views, viewed: held === this.holds ? this.viewed : new WeakMap(), check: composed,
      ...(lease === undefined ? {} : { owner: lease }),
      ...(held === undefined ? {} : { holds: held }),
      ...(this.landed ? { landed: true } : {}),
    });
  }

  as(cred: VfsCred, actor?: string, options?: VfsViewOptions): CompositeVFS {
    const principal: Principal = actor === undefined ? { cred } : { cred, actor };
    // A process's view (its holds) and a landed one are their own, never the cached one.
    if (options?.holds !== undefined || options?.landed === true) {
      return new CompositeVFS(this.table.mounts.get(ROOT_POINT)!.source, undefined, {
        table: this.table, principal, views: this.views, viewed: new WeakMap(),
        ...(options.holds === undefined ? {} : { holds: options.holds }),
        ...(options.landed === true ? { landed: true } : {}),
      });
    }
    const key = principalKey(principal);
    let view = this.views.refs.get(key)?.deref();
    if (view === undefined) {
      view = new CompositeVFS(this.table.mounts.get(ROOT_POINT)!.source, undefined, {
        table: this.table, principal, views: this.views,
      });
      this.views.refs.set(key, new WeakRef(view));
      this.views.gone.register(view, key);
    }
    return view;
  }

  /** Who this view acts as. */
  get principal(): Principal {
    return this.viewer;
  }

  get sync(): CompositeSyncVFS {
    return this.syncView;
  }

  private resynthesize(): void {
    this.table.synthesized.clear();
    for (const point of this.table.mounts.keys()) {
      if (point === ROOT_POINT) continue;
      let child = point;
      while (child !== ROOT_POINT) {
        const dir = parentOf(child);
        let names = this.table.synthesized.get(dir);
        if (!names) this.table.synthesized.set(dir, names = new Set());
        names.add(child.slice(dir === ROOT_POINT ? 1 : dir.length + 1));
        child = dir;
      }
    }
  }

  // ── routing ────────────────────────────────────────────────────────────
  //
  // Three rules, proved in FormalModelsLane's Vfs/Composite model and
  // checked by tests/unit/composite-vfs-refinement.mjs:
  //  1. A path is absent for a principal when ANY mount on it answers null
  //     for that principal, not only the longest: a live mount nested under
  //     an absent one is unreachable, and the absent one's point never shows.
  //  2. A mount point, and a directory above a live one, is a directory of
  //     this namespace and covers a root entry (a link included) of the same
  //     name, as a Linux mount covers what is beneath it.
  //  3. Refusals come in one order: ENXIO, then EBUSY, then EXDEV, then
  //     whatever the backend answers.
  // Links in the root backend are followed here (at every intermediate
  // component, and at the last for the operations POSIX follows), so a root
  // link into a mount reaches the mount. A link inside a mounted backend is
  // that backend's. Inside a mount whose backend resolves its own paths
  // (MountOptions.resolvesPaths) nothing is looked up: the backend is handed
  // the rest of the path whole.

  /** The mount `path` (resolved, normalized) is on: the longest point at or above it. */
  private locate(path: string): Route {
    for (let at = path; ; at = parentOf(at)) {
      const mount = this.table.mounts.get(at);
      if (mount !== undefined) return { mount, path, rel: relativeTo(at, path) };
      if (at === ROOT_POINT) throw new Error('the root mount is missing');
    }
  }

  private backend(mount: Mount): VFS | null {
    const found = this.sourceOf(mount);
    return found === null ? null : this.backendView(found);
  }

  /** What `mount`'s source gives this view's principal now (the backend itself, before a principal's view of it). */
  private sourceOf(mount: Mount): VFS | null {
    const found = typeof mount.source === 'function' ? mount.source(this.viewer) : mount.source;
    return found ?? null;
  }

  /** `found` as this view's principal sees it (its `as`), one view per backend. */
  private backendView(found: VFS): VFS {
    const cred = this.viewer.cred;
    if (cred === null || found.as === undefined) return found;
    let view = this.viewed.get(found);
    // The actor goes with the credential: a backend's write events name the principal (observeWrites).
    if (view === undefined) {
      const options = this.holds === undefined && !this.landed ? undefined : {
        ...(this.holds === undefined ? {} : { holds: this.holds }),
        ...(this.landed ? { landed: true } : {}),
      };
      this.viewed.set(found, view = found.as(cred, this.viewer.actor, options));
      this.table.behind.set(view, found);
    }
    return view;
  }

  /** `files`' synchronous face, or EAGAIN for a caller that cannot wait (an asynchronous mount). */
  private synchronousFace(files: VFS, route: Route): SyncVFS {
    if (files.sync === undefined) {
      throw Object.assign(
        new Refusal('EAGAIN', route.path, `${route.mount.point} is an asynchronous mount; this caller cannot wait for it`),
        { asyncMount: true as const },
      );
    }
    const face = files.sync;
    // A face of its own (not the backend itself): the backend it is of, for the store a mutation through it lands in (storeBehind).
    if (face !== files && !this.table.behind.has(face)) this.table.behind.set(face, this.table.behind.get(files) ?? files);
    return face;
  }

  /** The shortest mount on `path` whose source answers null for this view (rule 1), or null. */
  private absentOn(path: string): Mount | null {
    let found: Mount | null = null;
    for (const mount of this.table.mounts.values()) {
      if (mount.point === ROOT_POINT) continue;
      if (path !== mount.point && !path.startsWith(mount.under)) continue;
      if (found !== null && found.point.length <= mount.point.length) continue;
      if (this.backend(mount) === null) found = mount;
    }
    return found;
  }

  private absent(mount: Mount, path: string): VfsError {
    return new Refusal('ENXIO', path, `${mount.point} — ${this.absentReason(mount)}`);
  }

  private absentReason(mount: Mount): string {
    return mount.options.absentReason?.(this.viewer) ?? 'nothing is mounted there now';
  }

  /** ENXIO when `path` is absent for this view. */
  private present(path: string): void {
    const gone = this.absentOn(path);
    if (gone !== null) throw this.absent(gone, path);
  }

  /** Whether `point` is a mount this view reaches (rule 1). */
  private live(mount: Mount): boolean {
    return this.absentOn(mount.point) === null;
  }

  /** The operations the backend at `route` offers, synchronous or not. */
  private ops(route: Route, sync: boolean): Ops {
    const files = this.backend(route.mount);
    if (files === null) throw this.absent(route.mount, route.path);
    return sync ? this.synchronousFace(files, route) : files;
  }

  /** The root, a live mount point, or a directory above one (rule 2): this namespace's, not a backend's. */
  private isStructural(path: string): boolean {
    if (path === ROOT_POINT) return true;
    const mount = this.table.mounts.get(path);
    if (mount !== undefined) return this.live(mount);
    return this.table.synthesized.has(path) && this.hasLiveBelow(path);
  }

  private hasLiveBelow(dir: string): boolean {
    const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
    for (const mount of this.table.mounts.values()) {
      if (mount.point !== ROOT_POINT && mount.point.startsWith(prefix) && this.live(mount)) return true;
    }
    return false;
  }

  /**
   * A capability the backend may lack, asked after lookup (Linux order): a
   * path that is not there is ENOENT, and ENOTSUP is for a path that exists
   * on a backend without the capability. (FormalModelsLane
   * `Vfs/CompositeOps`, unsupported_is_enotsup.)
   */
  private capability<K extends keyof SyncVFS, T>(
    ops: Ops, name: K, rel: string, path: string, run: (fn: NonNullable<SyncVFS[K]>, there: boolean) => Awaitable<T>, creates: boolean,
  ): Awaitable<T> {
    return andThen(this.softStat(ops, rel, true), (stat) => {
      if (stat === null && !creates) throw new Refusal('ENOENT', path);
      const fn = (ops as SyncVFS)[name];
      if (typeof fn !== 'function') throw new Refusal('ENOTSUP', path, `this filesystem does not support ${String(name)}`);
      return run(fn.bind(ops) as NonNullable<SyncVFS[K]>, stat !== null);
    });
  }

  /**
   * readRange and the revision ops: `/` and a mount point are EISDIR;
   * anything else is the backend's, looked up before its capability is asked.
   * `written`: a write's whole content (a compare-and-write's), what
   * observers are told stands after. `creates`: a missing final component
   * is the backend's to answer, as a compare-and-write expecting revision 0
   * (nothing there: O_CREAT|O_EXCL) creates it, atomically only there. Its
   * parents are the lookup's, as any path's.
   */
  private onCapability<K extends keyof SyncVFS, T>(
    input: string, sync: boolean, name: K, write: boolean, run: (fn: NonNullable<SyncVFS[K]>, rel: string) => Awaitable<T>,
    { written, creates = false }: { written?: Uint8Array; creates?: boolean } = {},
  ): Awaitable<T> {
    return andThen(this.resolve(input, true, sync), (resolved) => {
      const path = resolved.path;
      this.present(path);
      if (this.isStructural(path)) {
        throw new Refusal('EISDIR', path);
      }
      const route = this.routeOf(resolved);
      if (write && route.mount.options.readOnly) throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
      return andThen(this.reachable(path, sync), () => {
        const ops = this.ops(route, sync);
        const call = (fn: NonNullable<SyncVFS[K]>, there = true): Awaitable<T> => {
          if (!write) {
            this.check?.();
            return run(fn, route.rel);
          }
          // A compare-and-write landed only when it won; where nothing was, it made its file.
          return this.reportWrite<T>({
            path, route, ops, follow: true, kind: 'write', landed: (result) => (casWon(result) ? [path] : []),
            ...(written === undefined ? {} : { written }),
            ...(there ? {} : { told: 'add' as const }),
          }, () => {
            this.guardMutation([input, path]);
            return run(fn, route.rel);
          }, sync);
        };
        // A backend that resolves its own paths answers a missing path itself.
        if (route.mount.options.resolvesPaths && typeof (ops as SyncVFS)[name] === 'function') return call(this.method(ops, name, path));
        return this.capability(ops, name, route.rel, path, call, creates);
      });
    });
  }

  private method<K extends keyof SyncVFS>(ops: Ops, name: K, path: string): NonNullable<SyncVFS[K]> {
    const fn = (ops as SyncVFS)[name];
    if (typeof fn !== 'function') throw new Refusal('ENOTSUP', path, `this filesystem does not support ${String(name)}`);
    return fn.bind(ops) as NonNullable<SyncVFS[K]>;
  }

  /**
   * `input` with every root link on it followed (the last only when
   * `follow`), normalized in this namespace. A mount point or a directory
   * above one is never a link (rule 2); a component inside a mount is left to
   * that backend. ELOOP past 40 link hops.
   */
  /** `creating`: absent non-final components are allowed (mkdir -p makes them); a file among them is still ENOTDIR. */
  private resolve(input: string, follow: boolean, sync: boolean, creating = false, trace?: LookupTrace): Awaitable<Resolution> {
    // Linux lookup, component by component. Every component that is not the
    // last (a trailing "" or "." counts as following) must exist and be a
    // directory once links are followed: ENOENT or ENOTDIR otherwise, before
    // any of rule 3's refusals. A root link is substituted where it is met,
    // and `..` pops the prefix resolved so far, so it applies after a link.
    // A mount point and a directory above one are directories. A component
    // under a mount this principal lacks is not read: the op answers ENXIO.
    // Links resolve in this namespace whichever backend holds them (Linux):
    // an absolute target from this view's root, a relative one from the
    // link's directory, so `..` at a mount root reaches the mount point's
    // parent. Every hop is walked again with this view's credential.
    // A structural directory its holder lacks hides its other children.
    let shadowParent = false;
    // What a mount that resolves its own paths is handed (forwardedTail), as of
    // the walk that answers: a link followed starts the walk, and it, over.
    let operand: Resolution['operand'];
    let scanned: readonly string[] | null = null;
    const root = this.table.mounts.get(ROOT_POINT);
    const walked = walkVfsPath(input, (prefix, final, components, at): Awaitable<(() => Awaitable<string>) | null> => {
      if (trace !== undefined) trace.at = prefix;
      // A root that resolves its own paths is handed the rest from `/`, which the walk does not visit.
      if (scanned !== components && root !== undefined && root.options.resolvesPaths === true) {
        scanned = components;
        operand = this.forwardedTail(root, components, components[0] === '' ? 1 : 0);
      }
      if (this.isStructural(prefix)) {
        shadowParent = false;
        if (final) return null;
        const holder = this.locate(prefix).mount;
        if (holder.options.resolvesPaths && this.locate(normalizePath(`${prefix}/${components.slice(at + 1).join('/')}`)).mount === holder) {
          if (prefix === holder.point) operand = this.forwardedTail(holder, components, at + 1);
          return null;
        }
        const mount = this.table.mounts.get(prefix);
        return andThen(mount === undefined ? this.heldDirectory(prefix, sync) : this.mountRoot(mount, prefix, sync), (held) => {
          if (held !== null && !this.permits(held, 1)) throw new Refusal('EACCES', input);
          shadowParent = mount === undefined && held === null;
          return null;
        });
      }
      if (shadowParent) {
        shadowParent = false;
        if (!final) throw new Refusal('ENOENT', input);
        return null;
      }
      if (this.absentOn(prefix) !== null) return null;
      const route = this.locate(prefix);
      if (final && !follow) return null;
      if (route.mount.options.resolvesPaths) return null;
      const ops = this.ops(route, sync);
      const readlink = ops.readlink;
      const look = (): Awaitable<VfsStat | null> => {
        try {
          this.check?.();
          const out = ops.stat(route.rel, { follow: readlink === undefined });
          return isPromise(out) ? out.catch((error: Error) => this.walkMiss(error, prefix)) : out;
        } catch (error) {
          return this.walkMiss(error, prefix);
        }
      };
      return andThen(look(), (stat) => {
        if (stat !== null && stat.type === 'symlink' && readlink !== undefined) {
          shadowParent = false;
          return () => {
            trace?.links.push(prefix);
            operand = undefined;
            this.check?.();
            return readlink.call(ops, route.rel);
          };
        }
        if (!final) {
          if (stat === null) {
            if (creating) return null;
            throw new Refusal('ENOENT', input);
          }
          if (stat.type !== 'directory') throw new Refusal('ENOTDIR', input);
          if (!this.permits(stat, 1)) throw new Refusal('EACCES', input);
        }
        return null;
      });
    }, () => { throw new Refusal('ELOOP', input); });
    return andThen(walked, (path): Resolution => {
      const given = operand;
      if (given === undefined || this.locate(path).mount.point !== given.point) return { path, spelling: path };
      // Not followed, a final `/` or `/.` makes the last name a directory's, through its link.
      const raw = DOT_DOT.test(given.rel) || (!follow && DIRECTORY_ENDING.test(given.rel));
      return { path, operand: given, spelling: raw ? rerooted(given.point, given.rel) : path };
    });
  }

  /**
   * What `holder`, a mount that resolves its own paths, is handed of
   * `components` from `from` (the rest past its point): the rest as written,
   * but for what the namespace owns on the way. A lexical cursor walks the
   * rest; a raw cut marks where the handed text starts. `.`, `''` and a `..`
   * from a name the backend owns move the cursor only (the backend walks
   * them: `/m/missing/../f` is handed `/missing/../f`). A name the namespace
   * owns (a nested mount point, a directory above one), and a `..` from one,
   * move the cut past them, the position there rebased (`/m/n/../f`, n a
   * mount, is handed `/f`). None when a `..` climbs past the point (the path
   * is the namespace's, lexically; at `/` it climbs nowhere, and the backend
   * walks it), or the rest lands on the point, on a name
   * the namespace owns, or in another mount.
   */
  private forwardedTail(holder: Mount, components: readonly string[], from: number): Resolution['operand'] {
    const point = holder.point;
    const named = (names: readonly string[]): string => (names.length === 0 ? point : rerooted(point, `/${names.join('/')}`));
    // A mount point is the namespace's while it is mounted, its source there or not; a directory above one while that one is live.
    const owned = (path: string): boolean => this.table.mounts.has(path) || this.isStructural(path);
    const position: string[] = [];
    let cut = from;
    let base = '';
    for (let i = from; i < components.length; i++) {
      const name = components[i];
      if (name === '' || name === '.') continue;
      if (name === '..') {
        // At `/` a `..` stays there (the backend walks it); past any other point it leaves the mount.
        if (position.length === 0) {
          if (point === ROOT_POINT) continue;
          return undefined;
        }
        const leaving = owned(named(position));
        position.pop();
        if (leaving) { cut = i + 1; base = position.length === 0 ? '' : `/${position.join('/')}`; }
        continue;
      }
      position.push(name);
      if (owned(named(position))) { cut = i + 1; base = `/${position.join('/')}`; }
    }
    if (position.length === 0) return undefined;
    const lands = named(position);
    if (owned(lands) || this.locate(lands).mount !== holder) return undefined;
    return { point, rel: `${base}/${components.slice(cut).join('/')}` };
  }

  /** The route a backend call on `r` takes: its operand, past the point of a mount that resolves its own paths. */
  private routeOf(r: Resolution): Route {
    const route = this.locate(r.path);
    return r.operand !== undefined && r.operand.point === route.mount.point ? { mount: route.mount, rel: r.operand.rel, path: route.path } : route;
  }

  /**
   * The directory a backend holds at a path above a mount point, or null
   * when it holds none there (then the namespace makes one: EPOCH_STAT).
   * Held means literally: under a directory the backend holds, never through
   * a link or file it holds higher up (the namespace's directory wins there).
   * A backend that resolves its own paths is asked once, for the path, and
   * follows its own links.
   */
  private heldDirectory(path: string, sync: boolean): Awaitable<VfsStat | null> {
    const route = this.locate(path);
    const resolves = route.mount.options.resolvesPaths === true;
    const parent = path.slice(0, path.lastIndexOf('/')) || ROOT_POINT;
    const own = (): Awaitable<VfsStat | null> => {
      const held = (stat: VfsStat | null): VfsStat | null => (stat !== null && stat.type === 'directory' ? stat : null);
      // A file above it (ENOTDIR) or no stat at all (ENOTSUP): the backend holds no directory there.
      const unsupported = (error: unknown): null => { if (isVfsError(error, 'ENOTSUP') || isVfsError(error, 'ENOTDIR')) return null; throw error; };
      try {
        const out = this.softStat(this.ops(route, sync), route.rel, resolves);
        return isPromise(out) ? out.then(held, unsupported) : held(out);
      } catch (error) {
        return unsupported(error);
      }
    };
    if (parent === route.mount.point || resolves) return own();
    return andThen(this.heldDirectory(parent, sync), (above) => (above === null ? null : own()));
  }

  /** A mounted backend's root, or null when it cannot stat it. */
  private mountRoot(mount: Mount, point: string, sync: boolean): Awaitable<VfsStat | null> {
    const ops = this.ops({ mount, path: point, rel: '/' }, sync) as SyncVFS;
    try {
      this.check?.();
      const out = ops.stat('/', { follow: true });
      return isPromise(out) ? out.catch(() => null) : out;
    } catch {
      return null;
    }
  }

  /** Whether this view's principal has `want` (r=4, w=2, x=1) on a stat (modeAllows); a view with no principal is not judged. */
  private permits(stat: VfsStat, want: number): boolean {
    const cred = this.viewer.cred;
    return cred === null || modeAllows(stat, want, cred);
  }

  /** A stat that failed during the walk: absent (ENOENT) reads as nothing there; other errors stand. */
  private walkMiss(error: unknown, _path: string): VfsStat | null {
    if (isVfsError(error, 'ENOENT')) return null;
    if (isVfsError(error, 'ENOTDIR')) return { type: 'file', size: 0, mtimeMs: 0 };
    throw error;
  }

  // ── operations (one implementation; `sync` selects the backend's sync face) ──

  /**
   * Whether `path` lies under a directory above a mount point (not a mount
   * point, and not `path` itself as a mount name there) that its backend does
   * not hold as a directory: that directory holds only its mount names (rule 2
   * applied to ancestors: a mount covers everything under its path), whatever
   * the backend has there through a link or file.
   */
  private shadowed(path: string, sync: boolean): Awaitable<boolean> {
    if (this.isStructural(path)) return false;
    // Only directories the path's own backend serves: one above the path's
    // mount point belongs to another filesystem, which the mount covers. A
    // backend that resolves its own paths answers for them itself.
    const { mount } = this.locate(path);
    if (mount.options.resolvesPaths) return false;
    const point = mount.point;
    for (let at = parentOf(path); at !== ROOT_POINT && at !== point && at.length > point.length; at = parentOf(at)) {
      if (this.isStructural(at) && !this.table.mounts.has(at)) {
        // heldDirectory checks every directory above it in turn.
        return andThen(this.heldDirectory(at, sync), (held) => held === null);
      }
    }
    return false;
  }

  /** ENOENT when `path` is shadowed. */
  private reachable(path: string, sync: boolean): Awaitable<void> {
    return andThen(this.shadowed(path, sync), (hidden) => {
      if (hidden) throw new Refusal('ENOENT', path);
    });
  }

  /**
   * The names the namespace itself puts in `dir` (mount points and the
   * directories above them), as directory entries, whatever `dir`'s own
   * backend holds.
   */
  mountedNames(dir: string): VfsDirent[] {
    const names = this.table.synthesized.get(normalizePath(dir));
    return names === undefined ? [] : [...names].map((name) => ({ name, type: 'directory' as const }));
  }

  /**
   * An entry's identity in the namespace: st_dev is its mount's (the root
   * keeps its backend's), and a backend that numbers no inodes gets numbers
   * here, per path (`identity`: identityOf), stable while it stays mounted.
   */
  private identify(path: string, stat: VfsStat, identity: string = path): VfsStat {
    return this.identifyOn(this.table.mounts.get(path) ?? this.locate(path).mount, identity, stat);
  }

  /**
   * What `r`'s synthetic inode number is kept under: its namespace path, or,
   * where its spelling is not that (Resolution.spelling: the backend may reach
   * another file than the lexical name), the operand as handed. Two files
   * never share a number; one reached by two such spellings may get two.
   */
  private identityOf(r: Resolution): string {
    const operand = r.operand;
    return operand !== undefined && r.spelling !== r.path ? `${operand.point}\0${operand.rel}` : r.path;
  }

  /** `identify`, on the mount `identity` was found on (a pin's, which may since have left its point). */
  private identifyOn(mount: Mount, identity: string, stat: VfsStat): VfsStat {
    const dev = mount.dev ?? stat.dev ?? 0;
    let ino = stat.ino;
    if (ino === undefined || ino === 0) {
      ino = mount.inos.get(identity);
      if (ino === undefined) mount.inos.set(identity, ino = mount.inos.size + 1);
    }
    return stat.dev === dev && stat.ino === ino ? stat : { ...stat, dev, ino };
  }

  private statAt(input: string, follow: boolean, sync: boolean): Awaitable<VfsStat | null> {
    // Nothing at a component on the way is "not there" too: stat answers null.
    const walked = (): Awaitable<Resolution | null> => {
      const absent = (e: unknown): null => { if (isVfsError(e, 'ENOENT')) return null; throw e; };
      try {
        const out = this.resolve(input, follow, sync);
        return isPromise(out) ? out.catch(absent) : out;
      } catch (e) {
        return absent(e);
      }
    };
    return andThen(walked(), (r) => (r === null ? null : this.statOf(r, follow, sync)));
  }

  /**
   * A mount point's stat: its backend root's. Only a backend that cannot
   * stat its own root (a container that derives stat from a parent listing)
   * gets a synthesized directory; one with no modes has the namespace's.
   */
  private mountPointStat(ops: VFS): Awaitable<VfsStat> {
    const own = (): Awaitable<VfsStat | null> => {
      try {
        const out = ops.stat('/', { follow: true });
        return isPromise(out) ? out.catch(() => null) : out;
      } catch {
        return null;
      }
    };
    return andThen(own(), (stat) => {
      if (stat === null || stat.type !== 'directory') return EPOCH_STAT;
      return stat.mode === undefined ? { ...stat, mode: EPOCH_STAT.mode, uid: 0, gid: 0 } : stat;
    });
  }

  /** statAt of what a lookup already found: its stat, its identity stamped. */
  private statOf(r: Resolution, follow: boolean, sync: boolean): Awaitable<VfsStat | null> {
    return andThen(this.statResolved(r.path, follow, sync, r), (stat) => (stat === null ? null : this.identify(r.path, stat, this.identityOf(r))));
  }

  /** The stat of a resolved namespace path, before its identity is stamped. */
  private statResolved(path: string, follow: boolean, sync: boolean, resolution?: Resolution): Awaitable<VfsStat | null> {
    if (this.absentOn(path) !== null) return null;
    // A live mount point is the mounted backend's root: its mode, owner
    // and times are the backend's (chmod of /tmp reaches it, so stat must
    // too). Only a backend that cannot stat its own root (a container that
    // derives stat from a parent listing) gets a synthesized directory, as
    // does a directory above a mount point that no backend holds; one a
    // backend holds is that backend's (its mode governs lookup through it).
    if (path !== ROOT_POINT && this.isStructural(path)) {
      const mount = this.table.mounts.get(path);
      if (mount === undefined) {
        return andThen(this.heldDirectory(path, sync), (held) => {
          if (held === null) return EPOCH_STAT;
          return held.mode === undefined ? { ...held, mode: EPOCH_STAT.mode, uid: 0, gid: 0 } : held;
        });
      }
      this.check?.();
      return this.mountPointStat(this.ops({ mount, path, rel: '/' }, sync) as VFS);
    }
    return andThen(this.shadowed(path, sync), (hidden) => {
      if (hidden) return null;
      const route = resolution === undefined ? this.locate(path) : this.routeOf(resolution);
      return this.softStat(this.ops(route, sync), route.rel, follow);
    });
  }

  /** stat, with ENOENT/ENOTDIR from the backend read as "not there". */
  private softStat(ops: Ops, rel: string, follow: boolean): Awaitable<VfsStat | null> {
    try {
      this.check?.();
      const out = (ops as SyncVFS).stat(rel, { follow });
      return isPromise(out) ? out.catch((e: unknown) => this.absentOrThrow(e)) : out;
    } catch (e) {
      return this.absentOrThrow(e);
    }
  }

  private absentOrThrow(error: unknown): null {
    if (isVfsError(error, 'ENOENT')) return null;
    throw error;
  }

  /** Mount points (and directories above live ones) directly in `dir` that this view reaches. */
  private liveNamesIn(dir: string): string[] {
    const names = this.table.synthesized.get(dir);
    if (!names) return [];
    const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
    return [...names].filter((name) => this.isStructural(prefix + name));
  }

  private readdirAt(input: string, sync: boolean): Awaitable<VfsDirent[]> {
    return andThen(this.resolve(input, true, sync), (r) => this.readdirOf(r.path, sync, r));
  }

  /** readdir of a path already resolved in this namespace (`resolution`: that lookup, its operand the backend's). */
  private readdirOf(path: string, sync: boolean, resolution?: Resolution): Awaitable<VfsDirent[]> {
    this.present(path);
    const prefix = path === ROOT_POINT ? '/' : `${path}/`;
    const extra = this.liveNamesIn(path);
    const finish = (entries: VfsDirent[]): VfsDirent[] => {
      // A mount point covers whatever its parent holds under that name, and
      // a name absent for this view is not listed (rule 1).
      const merged = entries.filter((entry) => !extra.includes(entry.name) && this.absentOn(prefix + entry.name) === null);
      for (const name of extra) merged.push({ name, type: 'directory' });
      return merged;
    };
    if (this.isStructural(path) && this.table.mounts.get(path) === undefined) {
      // A directory above a live mount: the backend's own entries if it
      // holds a directory there, else only the mount points. A backend that
      // resolves its own paths is asked for the listing alone.
      const route = this.locate(path);
      const own = (): Awaitable<VfsDirent[]> => {
        try {
          this.check?.();
          const out = this.ops(route, sync).readdir(route.rel);
          return isPromise(out) ? out.catch((e: unknown) => this.emptyIfMissing(e)) : out;
        } catch (e) {
          return this.emptyIfMissing(e);
        }
      };
      return andThen(this.reachable(path, sync), () => andThen(route.mount.options.resolvesPaths
        ? own()
        : andThen(this.heldDirectory(path, sync), (held) => (held === null ? [] : own())), finish));
    }
    const route = resolution === undefined ? this.locate(path) : this.routeOf(resolution);
    const ops = this.ops(route, sync);
    // opendir(O_DIRECTORY) answers ENOTDIR before a permission check (a
    // backend that resolves its own paths answers in its own order).
    const notDirectoryFirst = (error: unknown): Awaitable<VfsDirent[]> => {
      if (!isVfsError(error, 'EACCES') || route.mount.options.resolvesPaths) throw error;
      return andThen(this.softStat(ops, route.rel, true), (stat) => {
        if (stat !== null && stat.type !== 'directory') throw new Refusal('ENOTDIR', path);
        throw error;
      });
    };
    const listed = (): Awaitable<VfsDirent[]> => {
      try {
        this.check?.();
        const out = ops.readdir(route.rel);
        return isPromise(out) ? out.catch(notDirectoryFirst) : out;
      } catch (error) {
        return notDirectoryFirst(error);
      }
    };
    return andThen(this.reachable(path, sync), () => andThen(listed(), finish));
  }

  private emptyIfMissing(error: unknown): VfsDirent[] {
    if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR')) return [];
    throw error;
  }

  private onFile<T>(input: string, follow: boolean, sync: boolean, run: (ops: Ops, rel: string, path: string) => Awaitable<T>): Awaitable<T> {
    return andThen(this.resolve(input, follow, sync), (resolved) => {
      const path = resolved.path;
      this.present(path);
      if (this.isStructural(path)) {
        // open(2) checks read permission before a read answers EISDIR.
        return andThen(this.statAt(path, true, sync), (stat) => {
          if (stat !== null && !this.permits(stat, 4)) throw new Refusal('EACCES', path);
          throw new Refusal('EISDIR', path);
        });
      }
      const route = this.routeOf(resolved);
      return andThen(this.reachable(path, sync), () => {
        this.check?.();
        return run(this.ops(route, sync), route.rel, path);
      });
    });
  }

  /**
   * `parents`: missing directories on the way are made first (makeTree),
   * where the lookup lands. `written`: the whole content it writes, what
   * observers are told stands after (WriteSpec.written).
   */
  private onMutation<T>(
    input: string, follow: boolean, sync: boolean, what: string,
    run: (ops: Ops, rel: string, path: string) => Awaitable<T>,
    { parents = false, written, told, children = false, recursiveEntry = false, spelled }: {
      parents?: boolean; written?: Uint8Array; told?: VfsEventType | null; children?: boolean; recursiveEntry?: boolean;
      /** The name as given, `input` its entry (entryVfsPath): its final separators go to a backend that resolves its own paths. */
      spelled?: string;
    } = {},
  ): Awaitable<T> {
    return andThen(this.resolve(input, follow, sync, parents), (entry) => {
      const resolved = spelled === undefined ? entry : withEnding(entry, spelled);
      const path = resolved.path;
      this.present(path);
      // unlink(2) refuses a directory before anything else (Linux), and a
      // mount point is one.
      if (what === 'unlinked' && (path === ROOT_POINT || this.isStructural(path))) {
        // may_delete: write and search on the parent, then EISDIR.
        if (path === ROOT_POINT) throw new Refusal('EISDIR', path);
        return andThen(this.statAt(parentOf(path), true, sync), (parent) => {
          if (parent !== null && !this.permits(parent, 3)) throw new Refusal('EACCES', path);
          throw new Refusal('EISDIR', path);
        });
      }
      const route = this.routeOf(resolved);
      // chmod, chown and utimes of a mount point change the mounted root, as
      // on Linux; only a directory above a mount point has no backend to ask.
      const metadataOnly = what === 'changed' && (path === ROOT_POINT || this.table.mounts.get(path) !== undefined);
      const walkingChildren = what === 'removed' && children && path !== ROOT_POINT;
      if (this.isStructural(path) && !metadataOnly && !walkingChildren) throw new Refusal('EBUSY', path, recursiveEntry ? undefined : `a mount point cannot be ${what}`);
      if (route.mount.options.readOnly && !walkingChildren) throw new Refusal('EROFS', path, recursiveEntry ? undefined : `${route.mount.point} is mounted read-only`);
      return andThen(this.reachable(path, sync), () => andThen(parents ? this.makeTree(parentOf(path), undefined, sync, parentOperand(resolved.operand)) : undefined, () => {
        const ops = this.ops(route, sync);
        const removes = what === 'unlinked' || what === 'removed';
        return this.reportWrite<T>({
          path, route, ops, follow, kind: removes ? 'remove' : 'write',
          ...(written === undefined ? {} : { written }),
          // A link it makes is told as made.
          ...(told !== undefined ? { told } : what === 'replaced' ? { told: 'add' as const } : {}),
          // rm -r reports what it removed: its operand, unless it kept it.
          ...(what === 'removed' ? { landed: (result: T) => (isRemoval(result) ? result.removed : [path]) } : {}),
        }, () => {
          this.guardMutation([input, path]);
          return run(ops, route.rel, path);
        }, sync);
      }));
    });
  }

  /**
   * Refuses this view's mutation at each of `paths` (the names it was given
   * and the namespace paths it lands at): by the view's own check (its
   * binding's authority, scoped), unless the caller's comes with the call
   * (`own` false: a held file's, whoever holds it), and by the table's guard
   * (guardMutations), for a view with a credential. Called right before the
   * backend is, on the path this namespace resolved.
   */
  private guardMutation(paths: readonly string[], own = true): void {
    if (own) this.check?.();
    const guard = this.table.guard;
    const cred = this.viewer.cred;
    if (guard === undefined || cred === null) return;
    for (const path of paths) {
      const refusal = guard(cred, normalizePath(path), this.owner);
      if (refusal !== null) throw new Refusal(refusal.code, path, refusal.detail);
    }
  }

  private mkdirAt(input: string, options: { recursive?: boolean; mode?: number } | undefined, sync: boolean): Awaitable<void> {
    return andThen(this.resolve(entryVfsPath(input).path, false, sync, options?.recursive === true), (entry) => {
      const resolved = withEnding(entry, input);
      const path = resolved.path;
      this.present(path);
      if (this.isStructural(path)) {
        // mkdir -p of a live mount point (or a directory above one) has nothing to do.
        if (options?.recursive) return undefined;
        throw new Refusal('EBUSY', path, 'a mount point cannot be created');
      }
      const route = this.routeOf(resolved);
      if (route.mount.options.readOnly) throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
      if (!options?.recursive) {
        return andThen(this.reachable(path, sync), () => {
          const ops = this.ops(route, sync);
          return this.reportWrite({ path, route, ops, follow: false, kind: 'create' }, (): Awaitable<void> => {
            this.guardMutation([input, path]);
            return andThen(ops.mkdir(route.rel, options), () => undefined);
          }, sync);
        });
      }
      this.guardMutation([input, path]);
      return this.makeTree(path, options.mode, sync, resolved.operand);
    });
  }

  /**
   * mkdir -p of a resolved namespace path, across mounts: each missing
   * component in the filesystem it lives on, each checked by the mutation
   * guard right before it is made. `handed`: the path's operand on a mount
   * that resolves its own paths (Resolution.operand), which that backend
   * makes in one call, from the point on, whatever it spells.
   */
  private makeTree(path: string, mode: number | undefined, sync: boolean, handed?: Resolution['operand']): Awaitable<void> {
    const parts = path === ROOT_POINT ? [] : path.slice(1).split('/');
    const make = (i: number): Awaitable<void> => {
      if (i > parts.length) return handed === undefined ? undefined : step(this.locate(path), path, i);
      const at = `/${parts.slice(0, i).join('/')}`;
      if (this.isStructural(at)) return make(i + 1);
      const r = this.locate(at);
      if (i === 1 || this.isStructural(`/${parts.slice(0, i - 1).join('/')}`)) {
        return andThen(this.reachable(at, sync), () => step(r, at, i));
      }
      return step(r, at, i);
    };
    const step = (r: Route, at: string, i: number): Awaitable<void> => {
      const ops = this.ops(r, sync) as SyncVFS;
      // Nothing is mounted below a directory that is not structural, so
      // a backend that resolves its own paths makes the rest in one call.
      if (r.mount.options.resolvesPaths) {
        const lexical = this.locate(path);
        const whole = handed !== undefined && handed.point === lexical.mount.point ? { ...lexical, rel: handed.rel } : lexical;
        // One call makes it all, and what it made is told as its backend says (VFS.mkdir).
        return this.reportWrite({ path, route: whole, ops, follow: true, kind: 'create', existingIsNoop: true, told: null }, () => {
          this.guardMutation([at, path]);
          const made = ops.mkdir(whole.rel, { recursive: true, mode });
          const tell = (dirs: readonly string[] | void): void => {
            if (this.table.changes === undefined || dirs === undefined || dirs.length === 0) return;
            this.tellLanded(whole.mount, storeBehind(this.table, ops), 'addDir', dirs.map((rel) => CompositeVFS.reroot(whole.mount.point, rel)));
          };
          if (isPromise(made)) made.then(tell, () => {});
          else tell(made);
          return andThen(made, () => undefined);
        }, sync);
      }
      return andThen(this.softStat(ops, r.rel, true), (stat) => {
        if (stat !== null) {
          if (stat.type !== 'directory') {
            throw new Refusal(i === parts.length ? 'EEXIST' : 'ENOTDIR', at);
          }
          return make(i + 1);
        }
        return andThen(this.reportWrite({ path: at, route: r, ops, follow: false, kind: 'create' }, () => {
          this.guardMutation([at]);
          return ops.mkdir(r.rel, { mode });
        }, sync), () => make(i + 1));
      });
    };
    return make(1);
  }

  private renameAt(fromInput: string, toInput: string, sync: boolean): Awaitable<void> {
    const fromEntry = entryVfsPath(fromInput);
    const toEntry = entryVfsPath(toInput);
    return andThen(this.resolve(fromEntry.path, false, sync), (fromEntryR) => andThen(this.resolve(toEntry.path, false, sync), (toEntryR) => {
      const fromR = withEnding(fromEntryR, fromInput);
      const toR = withEnding(toEntryR, toInput);
      const from = fromR.path;
      const to = toR.path;
      this.present(from);
      this.present(to);
      const source = this.routeOf(fromR);
      const target = this.routeOf(toR);
      if (this.isStructural(from)) throw new Refusal('EBUSY', from, 'a mount point cannot be renamed');
      if (this.isStructural(to)) throw new Refusal('EBUSY', to, 'a mount point cannot be replaced');
      if (source.mount !== target.mount) {
        throw new Refusal('EXDEV', from, `${source.mount.point} and ${target.mount.point} are different filesystems`);
      }
      if (source.mount.options.readOnly) throw new Refusal('EROFS', from, `${source.mount.point} is mounted read-only`);
      return andThen(this.reachable(from, sync), () => andThen(this.reachable(to, sync), () => {
        const move = (): Awaitable<void> => {
          this.guardMutation([fromInput, from, toInput, to]);
          if (fromEntry.directory || toEntry.directory) {
            return andThen(this.softStat(this.ops(source, sync), source.rel, false), (stat) => {
              if (stat === null) throw new Refusal('ENOENT', from);
              if (stat.type !== 'directory') throw new Refusal('ENOTDIR', from);
              return andThen(this.softStat(this.ops(target, sync), target.rel, false), (end) => {
                if (toEntry.directory && end !== null && end.type !== 'directory') throw new Refusal('ENOTDIR', to);
                return this.renameIn(source, target, from, sync);
              });
            });
          }
          return this.renameIn(source, target, from, sync);
        };
        // A name renamed onto itself changes nothing (the same operand: on a mount that
        // resolves its own paths, two spellings of one name may be two files).
        if (from === to && source.rel === target.rel) return move();
        return this.reportWrite({ path: to, route: target, ops: this.ops(target, sync), follow: false, kind: 'write', oldPath: from }, move, sync);
      }));
    }));
  }

  private renameIn(source: Route, target: Route, from: string, sync: boolean): Awaitable<void> {
    const ops = this.ops(source, sync) as SyncVFS;
    // A backend with no rename cannot move a name in place; EXDEV tells mv
    // to copy. A source that is not there is ENOENT first, as rename(2) says.
    if (typeof ops.rename !== 'function') {
      return andThen(this.softStat(ops, source.rel, false), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', from);
        throw new Refusal('EXDEV', from, `${source.mount.point} cannot rename in place`);
      });
    }
    return ops.rename(source.rel, target.rel);
  }

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
  private copyAt(fromInput: string, toInput: string, options: VfsCopyOptions | undefined, sync: boolean): Awaitable<number> {
    return andThen(this.resolve(fromInput, options?.follow === true, sync), (fromR) => { const from = fromR.path; this.present(from); return andThen(this.resolve(toInput, false, sync), (toR) => {
      const to = toR.path;
      this.present(to);
      const fromMount = this.table.mounts.get(from);
      if (from === ROOT_POINT || (this.isStructural(from) && fromMount === undefined) || (fromMount === undefined && this.hasLiveBelow(from))) {
        throw new Refusal('ENOTSUP', from, 'a tree holding another filesystem is copied by cp -r, not by this primitive');
      }
      if (to === ROOT_POINT || this.isStructural(to)) throw new Refusal('EBUSY', to, 'a mount point cannot be replaced');
      const source = this.routeOf(fromR);
      const target = this.routeOf(toR);
      if (target.mount.options.readOnly) throw new Refusal('EROFS', to, `${target.mount.point} is mounted read-only`);
      const sourceOps = this.ops(source, sync) as SyncVFS;
      // Followed, a link a backend resolves itself is followed there too.
      return andThen(this.statOf(fromR, options?.follow === true, sync), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', from);
        const dir = stat.type === 'directory';
        if (dir && !options?.recursive) throw new Refusal('EISDIR', from, 'a tree needs recursive');
        // The copy itself, at `atR` (its lookup; `at` its namespace path): guarded
        // right before the backend is called, there and at the name given.
        const write = (atR: Resolution, made: boolean, there?: VfsStat | null): Awaitable<number> => {
          const at = atR.path;
          const route = this.routeOf(atR);
          if (route.mount.options.readOnly) throw new Refusal('EROFS', at, `${route.mount.point} is mounted read-only`);
          // A regular file is written through a link at its destination, as
          // cp opens it; a copied link or tree is made at the name.
          const follow = stat.type === 'file';
          const told: VfsEventType = !made ? 'change' : dir ? 'addDir' : 'add';
          if (source.mount === route.mount && typeof sourceOps.copy === 'function') {
            return this.reportWrite({ path: at, route, ops: sourceOps, follow, kind: 'write', told }, () => {
              this.guardMutation([toInput, at]);
              return sourceOps.copy!(source.rel, route.rel, options);
            }, sync);
          }
          const targetOps = this.ops(route, sync);
          // Each entry the copy makes is told as it lands, the ones before a failure too.
          return this.reportWrite({ path: at, route, ops: targetOps, follow, kind: 'write', told: null }, () => {
            this.guardMutation([toInput]);
            return this.copyBytes(sourceOps, source.rel, stat, targetOps as SyncVFS, route.rel, at, { ops: targetOps as SyncVFS, rel: route.rel, mount: route.mount, told, preserve: options?.preserve === true, keepMode: options?.keepMode === true, made, there: there ?? null });
          }, sync);
        };
        // The target's parent is a directory, unless its backend resolves its own paths and answers for it (it may make it).
        return andThen(target.mount.options.resolvesPaths ? undefined : andThen(this.statAt(parentOf(to), true, sync), (parent) => {
          if (parent === null) throw new Refusal('ENOENT', to);
          if (parent.type !== 'directory') throw new Refusal('ENOTDIR', to);
        }), () => {
          // Into itself, by name, unless the backend copies it itself from names it
          // walks (a spelling past a `..`, which only it can judge); a copy walked here
          // could not tell its own new root among the entries it lists.
          const spelled = fromR.spelling !== from || toR.spelling !== to;
          const judgesItself = spelled && source.mount === target.mount && typeof sourceOps.copy === 'function';
          if (dir && !judgesItself && (to === from || to.startsWith(`${from}/`))) {
            throw new Refusal('EINVAL', to, 'a tree cannot be copied into itself');
          }
          // A tree named past a `..` its backend walks may hold the copy's own root under
          // another name: only that backend's own copy can tell, so none is walked here.
          if (dir && spelled && !judgesItself) {
            throw new Refusal('ENOTSUP', from, 'a tree named past a `..` its backend walks is copied by that backend, which has no copy');
          }
          return andThen(this.statOf(toR, false, sync), (existing) => {
            if (existing !== null) {
              if (dir) throw new Refusal('EEXIST', to);
              if (existing.type === 'directory') throw new Refusal('EISDIR', to);
            }
            if (stat.type !== 'file' || existing?.type !== 'symlink') return write(toR, existing === null, existing);
            // A file is written through a link at the destination, as cp
            // opens it: where that write lands, the link followed, is what is
            // checked and written. (A link or a tree is made at the name.)
            return andThen(this.resolve(toInput, true, sync), (throughR) => {
              const through = throughR.path;
              this.present(through);
              if (this.isStructural(through)) throw new Refusal('EBUSY', through, 'a mount point cannot be replaced');
              return andThen(this.statOf(throughR, false, sync), (landing) => {
                if (landing?.type === 'directory') throw new Refusal('EISDIR', to);
                return write(throughR, landing === null, landing);
              });
            });
          });
        });
      });
    }); });
  }

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
  private copyBytes(
    from: SyncVFS, fromRel: string, stat: VfsStat, to: SyncVFS, toRel: string, toAt: string,
    made: { readonly ops: SyncVFS; readonly rel: string; readonly mount: Mount; readonly told: VfsEventType; readonly preserve: boolean; readonly keepMode: boolean; readonly made: boolean; readonly there?: VfsStat | null },
  ): Awaitable<number> {
    const mode = stat.mode === undefined ? undefined
      : copySetsMode(stat.mode, stat.size ?? 1, this.viewer.cred?.uid ?? 0, made) ?? copiedPermissions(stat.mode, stat.type === 'directory');
    const told = toRel === made.rel ? made.told : stat.type === 'directory' ? 'addDir' : 'add';
    const landed = <R>(result: Awaitable<R>): Awaitable<R> => {
      if (isPromise(result)) result.then(() => this.tellLanded(made.mount, storeBehind(this.table, to), told, [toAt]), () => {});
      else if (this.table.changes !== undefined) this.tellLanded(made.mount, storeBehind(this.table, to), told, [toAt]);
      return result;
    };
    if (stat.type === 'symlink') {
      if (typeof from.readlink !== 'function' || typeof to.symlink !== 'function') {
        throw new Refusal('ENOTSUP', toRel, 'a link cannot be copied between these filesystems');
      }
      this.check?.();
      return andThen(from.readlink(fromRel), (target) => {
        this.guardMutation([toAt]);
        return andThen(landed(to.symlink!(target, toRel)), () => 1);
      });
    }
    if (stat.type === 'file') {
      this.check?.();
      return andThen(from.readFile(fromRel), (bytes) => {
        this.guardMutation([toAt]);
        // copyfile's mode (keepMode), as libuv leaves it: the file there is
        // opened for write under its own mode, given the copy's (fchmod: its
        // owner's to set), then written. Here by path, each step its
        // backend's to judge: a chmod that narrows it for others (its
        // owner's bits kept, so the write stays the one its own mode
        // allowed; a chmod another may not make refuses here, before the
        // bytes), the write, then the copy's mode. A new file is written,
        // then given the copy's mode (its creation mode is the umask's).
        // Changes there, not one step.
        const exact = made.keepMode && mode !== undefined && typeof to.chmod === 'function';
        const write = () => landed(to.writeFile(toRel, bytes, mode === undefined ? undefined : { mode }));
        const there = made.there;
        const preserved = (copied: Awaitable<unknown>): Awaitable<number> =>
          andThen(copied, () => (made.preserve ? andThen(this.preserveMetadata(to, toRel, toAt, made.mount, stat, mode), () => 1) : 1));
        if (!exact || made.made || there === null || there === undefined || there.mode === undefined) {
          return preserved(andThen(write(), () => (exact ? to.chmod!(toRel, mode!) : undefined)));
        }
        const own = there.mode & 0o7777;
        const narrowed = (own & ~0o077) | (own & mode! & 0o077);
        return preserved(andThen(to.chmod!(toRel, narrowed), () =>
          andThen(write(), () => (mode === narrowed ? undefined : to.chmod!(toRel, mode!)))));
      });
    }
    this.guardMutation([toAt]);
    // Preserved, its owner may write its entries in until its own mode is set
    // after them (cp -p's), where the backend can set it then.
    const makeMode = mode !== undefined && made.preserve && typeof to.chmod === 'function' ? mode | 0o700 : mode;
    return andThen(landed(to.mkdir(toRel, makeMode === undefined ? undefined : { mode: makeMode })), () => andThen((this.check?.(), from.readdir(fromRel)), (entries) =>
      andThen(entries.reduce<Awaitable<number>>((count, entry) => andThen(count, (n) => {
        const child = fromRel === '/' ? `/${entry.name}` : `${fromRel}/${entry.name}`;
        const dest = toRel === '/' ? `/${entry.name}` : `${toRel}/${entry.name}`;
        if (from === made.ops && child === made.rel) return n;
        return andThen(entry.stat ?? (this.check?.(), from.stat(child, { follow: false })), (childStat) => (childStat === null
          ? n
          : andThen(this.copyBytes(from, child, childStat, to, dest, `${toAt}/${entry.name}`, made), (m) => n + m)));
      }), 1), (n) => (made.preserve ? andThen(this.preserveMetadata(to, toRel, toAt, made.mount, stat, mode), () => n) : n))));
  }

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
  private preserveMetadata(to: SyncVFS, toRel: string, toAt: string, mount: Mount, stat: VfsStat, mode: number | undefined): Awaitable<void> {
    const step = (allowed: boolean, change: () => Awaitable<void>): Awaitable<void> => {
      if (!allowed) return undefined;
      this.guardMutation([toAt]);
      const result = change();
      const told = () => this.tellLanded(mount, storeBehind(this.table, to), 'change', [toAt]);
      if (isPromise(result)) return result.then(told);
      if (this.table.changes !== undefined) told();
      return result;
    };
    const owned = (this.viewer.cred?.uid ?? 0) === 0 && typeof to.chown === 'function' && (stat.uid !== undefined || stat.gid !== undefined);
    return andThen(step(owned, () => to.chown!(toRel, stat.uid ?? null, stat.gid ?? null)), () =>
      andThen(step(mode !== undefined && typeof to.chmod === 'function', () => to.chmod!(toRel, mode!)), () =>
        step(typeof to.utimes === 'function', () => to.utimes!(toRel, stat.atimeMs ?? stat.mtimeMs, stat.mtimeMs))));
  }

  /** rmdir, or on a backend without it, an emptiness check and unlink. */
  private rmdirAt(input: string, sync: boolean): Awaitable<void> {
    return this.onMutation(entryVfsPath(input).path, false, sync, 'removed', (ops, rel, path) => {
      const backend = ops as SyncVFS;
      if (typeof backend.rmdir === 'function') return backend.rmdir(rel);
      this.check?.();
      return andThen(backend.stat(rel, { follow: false }), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', path);
        if (stat.type !== 'directory') throw new Refusal('ENOTDIR', path);
        this.check?.();
        return andThen(backend.readdir(rel), (entries) => {
          if (entries.length > 0) throw new Refusal('ENOTEMPTY', path);
          // Guarded again after the reads it waited on, right before the unlink.
          this.guardMutation([path]);
          return backend.unlink(rel);
        });
      });
    }, { told: 'unlinkDir', spelled: input });
  }

  /**
   * rm -r of one tree, with an exact report. `removed` lists the maximal
   * removed subtrees (so a native removal is just the operand), `kept` every
   * entry still there: one whose own removal failed, and the directories
   * holding it. A walked removal carries on past a failure, as rm -r does,
   * and `failures` says why each one stayed.
   */
  private removeAt(input: string, sync: boolean, keepVanishedAncestors = false): Awaitable<VfsRemoval> {
    // Each removal is told as it lands (watchChanges): a backend's own rm -r at the roots of what it removed, a walked one entry by entry.
    const entry = entryVfsPath(input);
    return this.onMutation(entry.path, false, sync, 'removed', (ops, rel, path): Awaitable<VfsRemoval> => {
      const remove = (): Awaitable<VfsRemoval> => {
      const { mount } = this.locate(path);
      const composed = this.hasLiveBelow(path) || this.isStructural(path) || mount.options.readOnly === true;
      if (composed) return this.walkRemove(ops, rel, path, mount, sync, true, keepVanishedAncestors);
      const backend = ops;
      if (typeof backend.removeRecursive === 'function') {
        // What it reports is named from its root, whatever spelling it was handed.
        const at = (r: string): string => (r === rel ? path : normalizePath(rerooted(mount.point, r)));
        return andThen(backend.removeRecursive(rel, { keepVanishedAncestors }), (report) => {
          const removal: VfsRemoval = report
            ? {
              removed: report.removed.map(at),
              kept: report.kept.map(at),
              ...(report.vanished === undefined ? {} : { vanished: report.vanished.map(at) }),
              // Each failure named as Node names the call that met it, on the namespace's path.
              failures: report.failures.map((f) => ({
                path: at(f.path),
                error: syscallError(f.error.code, f.error.syscall ?? 'rm', at(f.path), { detail: f.error.detail, cause: f.error }),
              })),
            }
            : { removed: [path], kept: [], failures: [] };
          if (this.table.changes !== undefined) this.tellLanded(mount, storeBehind(this.table, backend), 'unlink', removal.removed);
          return removal;
        });
      }
      return this.walkRemove(backend, rel, path, mount, sync, false, keepVanishedAncestors);
      };
      if (!entry.directory) return remove();
      this.check?.();
      return andThen(ops.stat(rel, { follow: false }), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', path);
        if (stat.type !== 'directory') throw new Refusal('ENOTDIR', path);
        return remove();
      });
    }, { told: null, children: true, spelled: input });
  }

  private walkRemove(ops: Ops, rel: string, path: string, mount: Mount, sync: boolean, composed = false, keepVanishedAncestors = false): Awaitable<VfsRemoval> {
    // The walk extends `rel` (an operand, on a mount that resolves its own
    // paths) by each name: its spelling looks an entry up again, through the
    // backend's walk; its namespace path names it in what is reported and told.
    const spelled = (r: string): string => rerooted(mount.point, r);
    const at = (r: string): string => (r === rel ? path : normalizePath(spelled(r)));
    const landed = (r: string, dir: boolean, backend: Ops, holder: Mount, named: string): void => {
      if (this.table.changes !== undefined) this.tellLanded(holder, storeBehind(this.table, backend), dir ? 'unlinkDir' : 'unlink', [named]);
    };
    const removeOn = (backend: Ops, r: string, dir: boolean, holder: Mount, named: string): Awaitable<void> => {
      this.guardMutation([named]);
      const out = dir && typeof backend.rmdir === 'function' ? backend.rmdir(r) : backend.unlink(r);
      return andThen(out, () => landed(r, dir, backend, holder, named));
    };
    const steps: RemovalSteps = composed
      ? {
        lstat: (r) => this.statAt(spelled(r), false, sync),
        readdir: (r) => this.readdirAt(spelled(r), sync),
        remove: (r, dir) => andThen(
          this.onMutation(spelled(r), false, sync, dir ? 'removed' : 'unlinked',
            (backend, backendRel, named) => removeOn(backend, backendRel, dir, this.locate(named).mount, named), { told: null, recursiveEntry: true }),
          () => undefined,
        ),
        // A mount point is entered only by a mount that asks to be (MountOptions.removalCrosses).
        crosses: (r) => {
          const point = at(r);
          const held = point === ROOT_POINT ? undefined : this.table.mounts.get(point);
          return held === undefined || held.options.removalCrosses === true;
        },
      }
      : {
        lstat: (r) => { this.check?.(); return ops.stat(r, { follow: false }); },
        readdir: (r) => { this.check?.(); return ops.readdir(r); },
        remove: (r, dir) => removeOn(ops, r, dir, mount, at(r)),
      };
    return walkRemoval(steps, {
      rel, at, keepVanishedAncestors,
      missing: () => new Refusal('ENOENT', path),
      passes: (cause) => recallOf(cause) !== null || isAsyncMountRefusal(cause),
    });
  }

  // ── the VFS surface ──────────────────────────────────────────────────
  //
  // Asynchronous throughout: a refusal is a rejected promise, never a throw
  // from the call itself, whatever the backend. \`sync\` is the synchronous face.

  async stat(path: string, options?: { follow?: boolean }): Promise<VfsStat | null> {
    return awaited({ syscall: options?.follow === false ? 'lstat' : 'stat', path }, () => this.statAt(path, options?.follow !== false, false));
  }

  /** VFS.landedAt, as this view's watches judge it (presentAt). */
  async landedAt(path: string): Promise<boolean> {
    return this.presentAt(normalizePath(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return awaited({ syscall: 'open', path }, () => this.onFile(path, true, false, (ops, rel) => ops.readFile(rel)));
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return awaited({ syscall: 'open', path }, () => this.onCapability(path, false, 'readRange', false, (fn, rel) => fn(rel, offset, length)));
  }

  /** `parents`: make the missing directories above where the write lands first (mkdir -p), as the write's own lookup resolves it. */
  async writeFile(path: string, data: Uint8Array, options?: { mode?: number; parents?: boolean }): Promise<void> {
    const mode = options?.mode === undefined ? undefined : { mode: options.mode };
    return awaited({ syscall: 'open', path }, () =>
      this.onMutation(path, true, false, 'written', (ops, rel) => ops.writeFile(rel, data, mode), { parents: options?.parents === true, written: data }));
  }

  /** `parents`: as writeFile's. */
  async writeRange(path: string, offset: number, bytes: Uint8Array, options?: { parents?: boolean }): Promise<void> {
    return awaited({ syscall: 'open', path }, () =>
      this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes), { parents: options?.parents === true }));
  }

  async truncate(path: string, size: number): Promise<void> {
    return awaited({ syscall: 'open', path }, () => this.onMutation(path, true, false, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)));
  }

  async readdir(path: string): Promise<VfsDirent[]> {
    return awaited({ syscall: 'scandir', path }, () => this.readdirAt(path, false));
  }

  /**
   * `readdir` with each entry's own stat (links not followed), identified as
   * `stat` identifies it: the stat the backend's listing carries, else one
   * asked of the backend that holds the name. A name gone between the two
   * is left out.
   */
  async readdirStat(path: string): Promise<Array<{ name: string; stat: VfsStat }>> {
    return awaited({ syscall: 'scandir', path }, async () => {
      const r = await this.resolve(path, true, false);
      return this.statEntries(r.path, r);
    });
  }

  /**
   * readdirStat of a directory already resolved in this namespace: the
   * directory is looked up once, and each entry's stat (when its listing
   * does not carry one) is one call to the backend that holds it, a few at
   * a time. `resolution`: the directory's lookup, whose operand its entries'
   * extend (childOf).
   */
  private async statEntries(dir: string, resolution?: Resolution): Promise<Array<{ name: string; stat: VfsStat }>> {
    const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
    const entries = await this.readdirOf(dir, false, resolution);
    const out: Array<{ name: string; stat: VfsStat } | null> = entries.map(() => null);
    const statOne = async (i: number): Promise<void> => {
      const entry = entries[i];
      const at = prefix + entry.name;
      const child = resolution === undefined ? undefined : childOf(resolution, entry.name);
      let stat = entry.stat ?? null;
      if (stat === null) {
        // A mount point, or a directory above one, is the namespace's.
        if (this.isStructural(at)) stat = await this.statAt(at, false, false);
        else {
          const route = child === undefined ? this.locate(at) : this.routeOf(child);
          stat = await this.softStat(this.ops(route, false), route.rel, false);
        }
      }
      if (stat !== null) out[i] = { name: entry.name, stat: this.identify(at, stat, child === undefined ? at : this.identityOf(child)) };
    };
    for (let i = 0; i < entries.length; i += WALK_CONCURRENCY) {
      await Promise.all(entries.slice(i, i + WALK_CONCURRENCY).map((_, j) => statOne(i + j)));
    }
    return out.filter((entry): entry is { name: string; stat: VfsStat } => entry !== null);
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    return awaited({ syscall: 'mkdir', path }, () => this.mkdirAt(path, options, false));
  }

  async unlink(path: string): Promise<void> {
    return awaited({ syscall: 'unlink', path }, () => this.onMutation(path, false, false, 'unlinked', (ops, rel) => ops.unlink(rel)));
  }

  async rmdir(path: string): Promise<void> {
    return awaited({ syscall: 'rmdir', path }, () => this.rmdirAt(path, false));
  }

  async rename(from: string, to: string): Promise<void> {
    return awaited({ syscall: 'rename', path: from, dest: to }, () => this.renameAt(from, to, false));
  }

  async removeRecursive(path: string, options?: { keepVanishedAncestors?: boolean }): Promise<VfsRemoval> {
    return awaited({ syscall: 'rm', path }, () => this.removeAt(path, false, options?.keepVanishedAncestors === true));
  }

  async symlink(target: string, path: string): Promise<void> {
    return awaited({ syscall: 'symlink', path: target, dest: path }, () =>
      this.onMutation(path, false, false, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)));
  }

  async readlink(path: string): Promise<string> {
    return awaited({ syscall: 'readlink', path }, () => this.onFile(path, false, false, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)));
  }

  async chmod(path: string, mode: number): Promise<void> {
    return awaited({ syscall: 'chmod', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)));
  }

  async chown(path: string, uid: number | null, gid: number | null): Promise<void> {
    return awaited({ syscall: 'chown', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)));
  }

  async utimes(path: string, atime: FsTime, mtime: FsTime): Promise<void> {
    return awaited({ syscall: 'utime', path }, () =>
      this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, atime, mtime)));
  }

  async writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): Promise<VfsCasResult> {
    return awaited({ syscall: 'open', path }, () =>
      this.onCapability(path, false, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected), { written: data, creates: createsIfAbsent(expected) }));
  }

  async copy(from: string, to: string, options?: VfsCopyOptions): Promise<number> {
    return awaited({ syscall: options?.recursive ? 'cp' : 'copyfile', path: from, dest: to }, () => this.copyAt(from, to, options, false));
  }

  async readFileAtRevision(path: string, revision: VfsRevision, range?: { offset: number; length: number }): Promise<Uint8Array> {
    return awaited({ syscall: 'open', path }, () => this.onCapability(path, false, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range)));
  }

  describe(): VfsMountDescription {
    const root = this.backend(this.table.mounts.get(ROOT_POINT)!);
    return root?.describe?.() ?? { source: 'none', type: 'composite' };
  }

  private makeSync(): CompositeSyncVFS {
    return {
      stat: (path, options) => syncValue(reported({ syscall: options?.follow === false ? 'lstat' : 'stat', path }, () =>
        this.statAt(path, options?.follow !== false, true))),
      landedAt: (path) => syncValue(this.presentAt(normalizePath(path), false)),
      readFile: (path) => syncValue(reported({ syscall: 'open', path }, () => this.onFile(path, true, true, (ops, rel) => ops.readFile(rel)))),
      readRange: (path, offset, length) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onCapability(path, true, 'readRange', false, (fn, rel) => fn(rel, offset, length)))),
      writeFile: (path, data, options) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onMutation(path, true, true, 'written', (ops, rel) => ops.writeFile(rel, data, options), { written: data }))),
      writeRange: (path, offset, bytes) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes)))),
      truncate: (path, size) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onMutation(path, true, true, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)))),
      readdir: (path) => syncValue(reported({ syscall: 'scandir', path }, () => this.readdirAt(path, true))),
      mkdir: (path, options) => syncValue(reported({ syscall: 'mkdir', path }, () => this.mkdirAt(path, options, true))),
      unlink: (path) => syncValue(reported({ syscall: 'unlink', path }, () =>
        this.onMutation(path, false, true, 'unlinked', (ops, rel) => ops.unlink(rel)))),
      rmdir: (path) => syncValue(reported({ syscall: 'rmdir', path }, () => this.rmdirAt(path, true))),
      rename: (from, to) => syncValue(reported({ syscall: 'rename', path: from, dest: to }, () => this.renameAt(from, to, true))),
      removeRecursive: (path, options) => syncValue(reported({ syscall: 'rm', path }, () => this.removeAt(path, true, options?.keepVanishedAncestors === true))),
      symlink: (target, path) => syncValue(reported({ syscall: 'symlink', path: target, dest: path }, () =>
        this.onMutation(path, false, true, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)))),
      readlink: (path) => syncValue(reported({ syscall: 'readlink', path }, () =>
        this.onFile(path, false, true, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)))),
      chmod: (path, mode) => syncValue(reported({ syscall: 'chmod', path }, () =>
        this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)))),
      chown: (path, uid, gid) => syncValue(reported({ syscall: 'chown', path }, () =>
        this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)))),
      utimes: (path, a, m) => syncValue(reported({ syscall: 'utime', path }, () =>
        this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, a, m)))),
      copy: (from, to, options) => syncValue(reported({ syscall: options?.recursive ? 'cp' : 'copyfile', path: from, dest: to }, () =>
        this.copyAt(from, to, options, true))),
      writeFileIfRevision: (path, data, expected) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onCapability(path, true, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected), { written: data, creates: createsIfAbsent(expected) }))),
      readFileAtRevision: (path, revision, range) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onCapability(path, true, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range)))),
    };
  }
}
