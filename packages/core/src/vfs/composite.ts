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
  Awaitable, Principal, SyncVFS, VFS, VfsCasResult, VfsChanges, VfsContentRef, VfsCred, VfsDirent, VfsMountDescription, VfsRemoval, VfsRemovalFailure,
  VfsRevision, VfsStat, VfsUsage, VfsWriteEvent, VfsWriteObserver,
} from './vfs.js';
import type { RuntimeVfsStat, VfsAcquireOptions, VfsInvalidatedPath, VfsListEntry } from '../runtime/os-contracts.js';
import { VfsError, VFS_DESCRIPTION, isVfsError, syscallError, type VfsErrorCode } from './vfs-error.js';
import { normalizeVfsPath } from './path.js';

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

/** Path order as SQLite's index keeps it: by UTF-8 bytes, which is code point order. */
export function comparePaths(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate half (a code point past U+FFFF) sorts after U+E000..U+FFFF.
    if (x >= 0xd800 && x <= 0xdfff && y >= 0xe000) return 1;
    if (y >= 0xd800 && y <= 0xdfff && x >= 0xe000) return -1;
    return x - y;
  }
  return a.length - b.length;
}

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

/** Identity of a mount's source object, for the table signature. */
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;
function sourceId(found: unknown): number {
  if (found === null || typeof found !== 'object') return 0;
  let id = sourceIds.get(found);
  if (id === undefined) sourceIds.set(found, id = nextSourceId++);
  return id;
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
  const typeBits = stat.type === 'directory' ? 0o040000 : stat.type === 'symlink' ? 0o120000 : 0o100000;
  const mode = stat.mode === undefined ? typeBits | (stat.type === 'directory' ? 0o755 : 0o644) : (stat.mode & 0o170000 ? stat.mode : typeBits | stat.mode);
  return {
    dev: stat.dev ?? 0, ino: stat.ino ?? 0, nlink: stat.nlink ?? 1, type: stat.type, size: stat.size,
    ctime: stat.ctimeMs ?? stat.mtimeMs, atime: stat.atimeMs ?? stat.mtimeMs, mtime: stat.mtimeMs,
    mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: 0,
  };
}

export type { Principal } from './vfs.js';

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
   * will not show, or a parent it makes on write. A `..` inside the mount is
   * taken lexically, so it leaves the mount only past its root. readlink
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
  /**
   * st_dev of what is mounted here: an anonymous device number (0x10000 + n,
   * as Linux gives a mount with no device of its own), clear of the small
   * ids a SQLite engine reports. Null for the root, whose backend's own is kept.
   */
  dev: number | null;
  /** Inode numbers for a backend that has none, by path, stable while mounted. */
  inos: Map<string, number>;
}

/** One observeWrites registration: its observer, and where it wants content read. */
interface WriteWatch {
  observer: VfsWriteObserver;
  wants: (path: string, principal: Principal) => boolean;
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
}

interface Table {
  mounts: Map<string, Mount>;
  /** observeWrites: who is told, and the mounts whose backends report their own writes, subscribed. */
  writes?: WriteWatches;
  /** Directory → names of mount points (or their missing ancestors) directly in it. */
  synthesized: Map<string, Set<string>>;
  /** Asked before a credentialed view's mutation reaches a backend (guardMutations). */
  guard?: MutationGuard;
}

/**
 * Why a mutation by `cred` at the namespace path `path` is refused (an
 * exclusive-mutation lease covers it), or null: CompositeVFS.guardMutations.
 */
export type MutationGuard = (cred: VfsCred, path: string) => { code: VfsErrorCode; detail: string } | null;

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
/** Where the namespace's own device numbers for mounts start (see Mount.dev). */
const ANONYMOUS_DEV = 0x10000;

/** Whether `error` is a synchronous caller's refusal by an asynchronous mount (one that can await may retry on the async face). */
export function isAsyncMountRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { asyncMount?: unknown }).asyncMount === true;
}
const ROOT_POINT = '/';
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;

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

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** `path` (at or under `point`) as the backend mounted at `point` names it: '/' at the point. */
function relativeTo(point: string, path: string): string {
  if (point === ROOT_POINT) return path;
  return path.length === point.length ? '/' : path.slice(point.length);
}

function isPromise<T>(value: Awaitable<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function syncValue<T>(value: Awaitable<T>): T {
  if (isPromise(value)) throw new Error('synchronous filesystem operation returned a promise');
  return value;
}

/** Apply `next` to a value that may or may not be a promise, staying synchronous when it is not. */
function then<T, U>(value: Awaitable<T>, next: (resolved: T) => Awaitable<U>): Awaitable<U> {
  return isPromise(value) ? value.then(next) : next(value);
}

/** An rm -r report (VfsRemoval). */
function isRemoval(value: unknown): value is VfsRemoval {
  return typeof value === 'object' && value !== null && Array.isArray((value as VfsRemoval).removed);
}

/** A compare-and-write that won (VfsCasResult ok). */
function casWon(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as VfsCasResult).ok === true;
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
}

function principalKey(principal: Principal): string {
  const { cred, actor } = principal;
  const id = cred === null ? '-' : `${cred.uid}:${cred.gid}:${[...cred.groups].join(',')}:${cred.umask}`;
  return actor === undefined ? id : `${id}@${actor}`;
}

export class CompositeVFS implements VFS {
  private readonly table: Table;
  /** The last st_dev a mount was given. */
  private nextDev = 0;
  private readonly viewer: Principal;
  /** Backends seen as this view's principal (a backend's `as` view is made once per view). */
  private readonly viewed: WeakMap<VFS, VFS>;
  /** Asked right before each of this view's mutations reaches a backend (scoped). */
  private readonly check: (() => void) | undefined;
  /**
   * Views per principal, held weakly: one per principal while someone holds
   * it, none once no one does (a table serving thousands of agents does not
   * keep a view per agent for its life).
   */
  private readonly views: Views;
  private readonly syncView: SyncVFS;

  constructor(root: VfsSource, options?: MountOptions);
  /** @internal a view over the same table. */
  constructor(root: VfsSource, options: MountOptions | undefined, shared: ViewShare);
  constructor(root: VfsSource, options: MountOptions = {}, shared?: ViewShare) {
    this.viewed = shared?.viewed ?? new WeakMap();
    this.check = shared?.check;
    if (shared) {
      this.table = shared.table;
      this.viewer = shared.principal;
      this.views = shared.views;
    } else {
      this.table = { mounts: new Map([[ROOT_POINT, { point: ROOT_POINT, source: root, options, dev: null, inos: new Map() }]]), synthesized: new Map() };
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
    const mount: Mount = { point: at, source, options, dev: ANONYMOUS_DEV + ++this.nextDev, inos: new Map() };
    this.table.mounts.set(at, mount);
    this.resynthesize();
    if (this.table.writes !== undefined) this.subscribeWrites(mount);
  }

  unmount(point: string): void {
    const at = normalizePath(point);
    const mount = this.table.mounts.get(at);
    if (at === ROOT_POINT || mount === undefined) throw syscallError('EINVAL', 'umount', point, { detail: 'nothing is mounted there' });
    this.table.mounts.delete(at);
    this.table.writes?.subscribed.get(mount)?.();
    this.table.writes?.subscribed.delete(mount);
    this.resynthesize();
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
   * where `wants` says (by default, everywhere), a read of its content
   * before and after.
   */
  observeWrites(observer: VfsWriteObserver, options?: { wants?: (path: string, principal: Principal) => boolean }): () => void {
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
    if (writes === undefined || writes.subscribed.has(spec.route.mount)) return run();
    const principal = this.viewer;
    let wanted = false;
    for (const watch of writes.watches) if (watch.wants(spec.path, principal)) { wanted = true; break; }
    const { path, route, ops, follow, kind, oldPath } = spec;
    const held: CapturedRef[] = [];
    const capture = (): Awaitable<VfsContentRef | null | false> => this.capture(ops, route.rel, wanted, follow, held);
    const release = (): void => { for (const ref of held) ref.release(); };
    const report = (): Awaitable<T> => {
      // A plain mkdir made what was not there (EEXIST otherwise); mkdir -p looks.
      const before = kind === 'create' && spec.existingIsNoop !== true ? null : capture();
      return then(before, (prior) => {
        // Nothing to make: mkdir -p of a directory that is there.
        if (kind === 'create' && prior !== null && prior !== false && prior.type === 'directory') {
          release();
          return run();
        }
        return then(run(), (result) => {
          const landed = spec.landed?.(result) ?? [path];
          if (landed.length === 0) { release(); return result; }
          const after = kind === 'remove' ? null : capture();
          return then(after, (now) => {
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
          });
        });
      });
    };
    if (sync) {
      // A caller that cannot wait cannot take a turn: while another's
      // section holds this backend, it is refused as an asynchronous mount
      // refuses it (a caller that can wait retries on the asynchronous face).
      if (writes.turn.busy) {
        throw Object.assign(
          new Refusal('EAGAIN', path, `${route.mount.point}: an observed write to this filesystem is in flight; this caller cannot wait for it`),
          { asyncMount: true as const },
        );
      }
      return report();
    }
    return this.takeTurn(writes, report);
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
  private capture(ops: Ops, rel: string, read: boolean, follow: boolean, held: CapturedRef[]): Awaitable<VfsContentRef | null | false> {
    const keep = (type: VfsContentRef['type'], bytes: Uint8Array | null): VfsContentRef => {
      const ref = capturedRef(type, bytes);
      held.push(ref);
      return ref;
    };
    return attempt(() => then(this.softStat(ops, rel, follow), (stat): Awaitable<VfsContentRef | null | false> => {
      if (stat === null) return null;
      if (stat.type === 'directory') return keep('directory', null);
      if (!read) return false;
      if (stat.type === 'symlink') return then((ops as SyncVFS).readlink!(rel), (target) => keep('symlink', utf8.encode(target)));
      return then((ops as SyncVFS).readFile(rel), (bytes) => keep('file', bytes));
    }), () => false);
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
   * last only with `follow`), and `..` inside a mount whose backend resolves
   * its own paths is lexical. A mount absent for this principal (any mount
   * on the path, rule 1) answers a null source, with its absentReason.
   * Rejects as the operation's lookup would: ENOENT, ENOTDIR, EACCES, ELOOP.
   */
  async route(path: string, options?: { follow?: boolean }): Promise<VfsRoute> {
    return reported({ syscall: 'route', path }, () => then(this.resolve(path, options?.follow === true, false), (at): Awaitable<VfsRoute> => {
      const gone = this.absentOn(at);
      if (gone !== null) return { point: gone.point, source: null, path: relativeTo(gone.point, at), absentReason: this.absentReason(gone) };
      const { mount } = this.locate(at);
      const source = this.backend(mount);
      if (source === null) return { point: mount.point, source, path: relativeTo(mount.point, at), absentReason: this.absentReason(mount) };
      // A path the namespace does not show (under a directory above a mount
      // that its holder does not hold as one) is refused as an operation on it is.
      return then(this.reachable(at, false), () => ({ point: mount.point, source, path: relativeTo(mount.point, at) }));
    }));
  }

  /**
   * Where a mutation of `path` lands: the namespace path its lookup resolves
   * (links on the way followed, the last only with `follow`), the mount
   * point it is on ('/' for the root), and whether that mount is read-only.
   * The lookup is the mutations' own (onMutation's), so a writer that asks
   * before it writes lands where the operation would. Rejects as that
   * lookup does: ENOENT, ENOTDIR, EACCES, ELOOP, ENXIO.
   */
  async mutationRoute(path: string, options?: { follow?: boolean }): Promise<{ readonly path: string; readonly point: string; readonly readOnly: boolean }> {
    return reported({ syscall: 'route', path }, () => then(this.resolve(path, options?.follow === true, false), (at) => {
      this.present(at);
      const { mount } = this.locate(at);
      return { path: at, point: mount.point, readOnly: mount.options.readOnly === true };
    }));
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
    return reported({ syscall: 'realpath', path }, () => this.realpathAt(path, false));
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
   * backend follows it) or takes what it leads to as unknown. Any other
   * link leads to its text. readlink answers the text, as written, so a
   * copied link is the same link.
   */
  linkLeadsTo(path: string, link: string): string | null {
    const route = this.locate(normalizePath(path));
    if (!route.mount.options.resolvesPaths) return link;
    const inBackend = normalizePath(link.startsWith('/') ? link : `${parentOf(route.rel)}/${link}`);
    const leads = inBackend === ROOT_POINT ? route.mount.point : `${route.mount.point}${inBackend}`;
    return this.locate(leads).mount === route.mount ? leads : null;
  }

  /**
   * `input` with every link the namespace follows resolved. Inside a mount
   * whose backend resolves its own paths the links are the backend's: the
   * rest is spelled as given (normalized), and the one stat that proves it
   * is there follows them.
   */
  private realpathAt(input: string, sync: boolean): Awaitable<string> {
    return then(this.resolve(input, true, sync), (resolved) => {
      const follow = this.locate(resolved).mount.options.resolvesPaths === true;
      return then(this.statAt(resolved, follow, sync), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', input);
        return resolved;
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

  /**
   * This view, for one holder: `check` is asked right before each mutation
   * reaches a backend, after every lookup and read the mutation waited on,
   * and refuses by throwing. A process's bridge passes its scope's liveness,
   * so a write whose lookup was still awaited when the process was released
   * or killed (or its host lease disposed) does not land. Shares this view's
   * table, principal and backend views; not cached, so the check is the
   * holder's alone.
   */
  scoped(check: () => void): CompositeVFS {
    return new CompositeVFS(this.table.mounts.get(ROOT_POINT)!.source, undefined, {
      table: this.table, principal: this.viewer, views: this.views, viewed: this.viewed, check,
    });
  }

  as(cred: VfsCred, actor?: string): CompositeVFS {
    const principal: Principal = actor === undefined ? { cred } : { cred, actor };
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

  get sync(): SyncVFS {
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

  /** Whether the backend `path` routes to can write a range in place (a descriptor needs no buffer). */
  writesInPlace(path: string): boolean {
    const route = this.locate(normalizePath(path));
    try {
      return typeof (this.ops(route, true) as { writeRange?: unknown }).writeRange === 'function';
    } catch {
      return false;
    }
  }

  /** The mount `path` (resolved, normalized) is on: the longest point at or above it. */
  private locate(path: string): Route {
    for (let at = path; ; at = parentOf(at)) {
      const mount = this.table.mounts.get(at);
      if (mount !== undefined) return { mount, path, rel: relativeTo(at, path) };
      if (at === ROOT_POINT) throw new Error('the root mount is missing');
    }
  }

  private backend(mount: Mount): VFS | null {
    const found = typeof mount.source === 'function' ? mount.source(this.viewer) : mount.source;
    if (found === null || found === undefined) return null;
    const cred = this.viewer.cred;
    if (cred === null || found.as === undefined) return found;
    let view = this.viewed.get(found);
    // The actor goes with the credential: a backend's write events name the principal (observeWrites).
    if (view === undefined) this.viewed.set(found, view = found.as(cred, this.viewer.actor));
    return view;
  }

  /** The shortest mount on `path` whose source answers null for this view (rule 1), or null. */
  private absentOn(path: string): Mount | null {
    let found: Mount | null = null;
    for (const mount of this.table.mounts.values()) {
      if (mount.point === ROOT_POINT) continue;
      if (path !== mount.point && !path.startsWith(`${mount.point}/`)) continue;
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
    if (!sync) return files;
    if (files.sync === undefined) {
      throw Object.assign(
        new Refusal('EAGAIN', route.path, `${route.mount.point} is an asynchronous mount; this caller cannot wait for it`),
        { asyncMount: true as const },
      );
    }
    return files.sync;
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
    ops: Ops, name: K, rel: string, path: string, run: (fn: NonNullable<SyncVFS[K]>) => Awaitable<T>,
  ): Awaitable<T> {
    return then(this.softStat(ops, rel, true), (stat) => {
      if (stat === null) throw new Refusal('ENOENT', path);
      const fn = (ops as SyncVFS)[name];
      if (typeof fn !== 'function') throw new Refusal('ENOTSUP', path, `this filesystem does not support ${String(name)}`);
      return run(fn.bind(ops) as NonNullable<SyncVFS[K]>);
    });
  }

  /**
   * readRange and the revision ops: `/` and a mount point are EISDIR;
   * anything else is the backend's, looked up before its capability is asked.
   */
  private onCapability<K extends keyof SyncVFS, T>(
    input: string, sync: boolean, name: K, write: boolean, run: (fn: NonNullable<SyncVFS[K]>, rel: string) => Awaitable<T>,
  ): Awaitable<T> {
    return then(this.resolve(input, true, sync), (path) => {
      this.present(path);
      if (this.isStructural(path)) {
        throw new Refusal('EISDIR', path);
      }
      const route = this.locate(path);
      if (write && route.mount.options.readOnly) throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
      return then(this.reachable(path, sync), () => {
        const ops = this.ops(route, sync);
        const call = (fn: NonNullable<SyncVFS[K]>): Awaitable<T> => {
          if (!write) return run(fn, route.rel);
          // A compare-and-write landed only when it won.
          return this.reportWrite<T>({ path, route, ops, follow: true, kind: 'write', landed: (result) => (casWon(result) ? [path] : []) }, () => {
            this.guardMutation([input, path]);
            return run(fn, route.rel);
          }, sync);
        };
        // A backend that resolves its own paths answers a missing path itself.
        if (route.mount.options.resolvesPaths && typeof (ops as SyncVFS)[name] === 'function') return call(this.method(ops, name, path));
        return this.capability(ops, name, route.rel, path, call);
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
   * that backend. ELOOP past MAX_LINK_HOPS.
   */
  /** `creating`: absent non-final components are allowed (mkdir -p makes them); a file among them is still ENOTDIR. */
  private resolve(input: string, follow: boolean, sync: boolean, creating = false): Awaitable<string> {
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
    const walk = (components: readonly string[], hops: number): Awaitable<string> => {
      const resolved: string[] = [];
      const lastIndex = components.length - 1;
      // Set after a structural directory its holder does not hold as a
      // directory: its other children are absent (they would be under a file).
      let shadowParent = false;
      const step = (i: number): Awaitable<string> => {
        for (; i < components.length; i++) {
          const component = components[i]!;
          if (component === '' || component === '.') continue;
          if (component === '..') { resolved.pop(); continue; }
          resolved.push(component);
          const prefix = `/${resolved.join('/')}`;
          const final = i === lastIndex;
          const at = i;
          if (this.isStructural(prefix)) {
            // Lookup through a mount point, or a directory above one, needs
            // search permission on what is there, as on Linux: the mounted
            // root, or the directory a backend holds at that path. A
            // backend that resolves its own paths checks its own, its root
            // included, when the path ends in it; on the way to a mount
            // nested in it, they are checked here, as any other backend's.
            shadowParent = false;
            if (final) continue;
            // `..` inside such a backend is lexical, so where the path ends is too.
            const holder = this.locate(prefix).mount;
            if (holder.options.resolvesPaths && this.locate(normalizePath(`${prefix}/${components.slice(at + 1).join('/')}`)).mount === holder) continue;
            const mount = this.table.mounts.get(prefix);
            return then(mount === undefined ? this.heldDirectory(prefix, sync) : this.mountRoot(mount, prefix, sync), (held) => {
              if (held !== null && !this.permits(held, 1)) throw new Refusal('EACCES', input);
              shadowParent = mount === undefined && held === null;
              return step(at + 1);
            });
          }
          if (shadowParent) {
            shadowParent = false;
            if (!final) throw new Refusal('ENOENT', input);
            continue;
          }
          if (this.absentOn(prefix) !== null) continue;
          const route = this.locate(prefix);
          if (final && !follow) continue;
          if (route.mount.options.resolvesPaths) continue;
          const ops = this.ops(route, sync) as SyncVFS;
          const canLink = typeof ops.readlink === 'function';
          const look = (): Awaitable<VfsStat | null> => {
            try {
              const out = ops.stat(route.rel, { follow: !canLink });
              return isPromise(out) ? out.catch((e: unknown) => this.walkMiss(e, prefix)) : out;
            } catch (e) {
              return this.walkMiss(e, prefix);
            }
          };
          return then(look(), (stat) => {
            if (stat !== null && stat.type === 'symlink' && canLink) {
              if (hops >= MAX_LINK_HOPS) throw new Refusal('ELOOP', input);
              return then(ops.readlink!(route.rel), (target) => walk([
                ...(target.startsWith('/') ? [] : resolved.slice(0, -1)),
                ...target.split('/'),
                ...components.slice(at + 1),
              ], hops + 1));
            }
            if (!final) {
              if (stat === null) {
                if (creating) return step(at + 1);
                throw new Refusal('ENOENT', input);
              }
              if (stat.type !== 'directory') throw new Refusal('ENOTDIR', input);
              if (!this.permits(stat, 1)) throw new Refusal('EACCES', input);
            }
            return step(at + 1);
          });
        }
        return `/${resolved.join('/')}`;
      };
      return step(0);
    };
    return walk(String(input).split('/'), 0);
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
    return then(this.heldDirectory(parent, sync), (above) => (above === null ? null : own()));
  }

  /** A mounted backend's root, or null when it cannot stat it. */
  private mountRoot(mount: Mount, point: string, sync: boolean): Awaitable<VfsStat | null> {
    const ops = this.ops({ mount, path: point, rel: '/' }, sync) as SyncVFS;
    try {
      const out = ops.stat('/', { follow: true });
      return isPromise(out) ? out.catch(() => null) : out;
    } catch {
      return null;
    }
  }

  /** Whether this view's principal has `want` (r=4, w=2, x=1) on a stat, by its mode bits. */
  private permits(stat: VfsStat, want: number): boolean {
    const cred = this.viewer.cred;
    if (cred === null || cred.uid === 0 || stat.mode === undefined) return true;
    const mode = stat.mode;
    const bits = cred.uid === stat.uid
      ? (mode >> 6) & 7
      : cred.gid === stat.gid || (cred.groups ?? []).includes(stat.gid ?? -1) ? (mode >> 3) & 7 : mode & 7;
    return (bits & want) === want;
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
        return then(this.heldDirectory(at, sync), (held) => held === null);
      }
    }
    return false;
  }

  /** ENOENT when `path` is shadowed. */
  private reachable(path: string, sync: boolean): Awaitable<void> {
    return then(this.shadowed(path, sync), (hidden) => {
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
   * here, per path, stable while it stays mounted.
   */
  private identify(path: string, stat: VfsStat): VfsStat {
    const mount = this.table.mounts.get(path) ?? this.locate(path).mount;
    const dev = mount.dev ?? stat.dev ?? 0;
    let ino = stat.ino;
    if (ino === undefined || ino === 0) {
      ino = mount.inos.get(path);
      if (ino === undefined) mount.inos.set(path, ino = mount.inos.size + 1);
    }
    return stat.dev === dev && stat.ino === ino ? stat : { ...stat, dev, ino };
  }

  private statAt(input: string, follow: boolean, sync: boolean): Awaitable<VfsStat | null> {
    // Nothing at a component on the way is "not there" too: stat answers null.
    const walked = (): Awaitable<string | null> => {
      const absent = (e: unknown): null => { if (isVfsError(e, 'ENOENT')) return null; throw e; };
      try {
        const out = this.resolve(input, follow, sync);
        return isPromise(out) ? out.catch(absent) : out;
      } catch (e) {
        return absent(e);
      }
    };
    return then(walked(), (path) => (path === null ? null : then(this.statResolved(path, follow, sync), (stat) => stat === null ? null : this.identify(path, stat))));
  }

  /** The stat of a resolved namespace path, before its identity is stamped. */
  private statResolved(path: string, follow: boolean, sync: boolean): Awaitable<VfsStat | null> {
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
        return then(this.heldDirectory(path, sync), (held) => {
          if (held === null) return EPOCH_STAT;
          return held.mode === undefined ? { ...held, mode: EPOCH_STAT.mode, uid: 0, gid: 0 } : held;
        });
      }
      const ops = this.ops({ mount, path, rel: '/' }, sync);
      const own = (): Awaitable<VfsStat | null> => {
        try {
          const out = (ops as SyncVFS).stat('/', { follow: true });
          return isPromise(out) ? out.catch(() => null) : out;
        } catch {
          return null;
        }
      };
      return then(own(), (stat) => {
        if (stat === null || stat.type !== 'directory') return EPOCH_STAT;
        // A backend with no modes has the namespace's own at its mount point.
        return stat.mode === undefined ? { ...stat, mode: EPOCH_STAT.mode, uid: 0, gid: 0 } : stat;
      });
    }
    return then(this.shadowed(path, sync), (hidden) => {
      if (hidden) return null;
      const route = this.locate(path);
      return this.softStat(this.ops(route, sync), route.rel, follow);
    });
  }

  /** stat, with ENOENT/ENOTDIR from the backend read as "not there". */
  private softStat(ops: Ops, rel: string, follow: boolean): Awaitable<VfsStat | null> {
    try {
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
    return then(this.resolve(input, true, sync), (path) => this.readdirOf(path, sync));
  }

  /** readdir of a path already resolved in this namespace. */
  private readdirOf(path: string, sync: boolean): Awaitable<VfsDirent[]> {
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
          const out = this.ops(route, sync).readdir(route.rel);
          return isPromise(out) ? out.catch((e: unknown) => this.emptyIfMissing(e)) : out;
        } catch (e) {
          return this.emptyIfMissing(e);
        }
      };
      return then(this.reachable(path, sync), () => then(route.mount.options.resolvesPaths
        ? own()
        : then(this.heldDirectory(path, sync), (held) => (held === null ? [] : own())), finish));
    }
    const route = this.locate(path);
    const ops = this.ops(route, sync);
    // opendir(O_DIRECTORY) answers ENOTDIR before a permission check (a
    // backend that resolves its own paths answers in its own order).
    const notDirectoryFirst = (error: unknown): Awaitable<VfsDirent[]> => {
      if (!isVfsError(error, 'EACCES') || route.mount.options.resolvesPaths) throw error;
      return then(this.softStat(ops, route.rel, true), (stat) => {
        if (stat !== null && stat.type !== 'directory') throw new Refusal('ENOTDIR', path);
        throw error;
      });
    };
    const listed = (): Awaitable<VfsDirent[]> => {
      try {
        const out = ops.readdir(route.rel);
        return isPromise(out) ? out.catch(notDirectoryFirst) : out;
      } catch (error) {
        return notDirectoryFirst(error);
      }
    };
    return then(this.reachable(path, sync), () => then(listed(), finish));
  }

  private emptyIfMissing(error: unknown): VfsDirent[] {
    if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR')) return [];
    throw error;
  }

  private onFile<T>(input: string, follow: boolean, sync: boolean, run: (ops: Ops, rel: string, path: string) => Awaitable<T>): Awaitable<T> {
    return then(this.resolve(input, follow, sync), (path) => {
      this.present(path);
      if (this.isStructural(path)) {
        // open(2) checks read permission before a read answers EISDIR.
        return then(this.statAt(path, true, sync), (stat) => {
          if (stat !== null && !this.permits(stat, 4)) throw new Refusal('EACCES', path);
          throw new Refusal('EISDIR', path);
        });
      }
      const route = this.locate(path);
      return then(this.reachable(path, sync), () => run(this.ops(route, sync), route.rel, path));
    });
  }

  /** `parents`: missing directories on the way are made first (makeTree), where the lookup lands. */
  private onMutation<T>(
    input: string, follow: boolean, sync: boolean, what: string,
    run: (ops: Ops, rel: string, path: string) => Awaitable<T>,
    parents = false,
  ): Awaitable<T> {
    return then(this.resolve(input, follow, sync, parents), (path) => {
      this.present(path);
      // unlink(2) refuses a directory before anything else (Linux), and a
      // mount point is one.
      if (what === 'unlinked' && (path === ROOT_POINT || this.isStructural(path))) {
        // may_delete: write and search on the parent, then EISDIR.
        if (path === ROOT_POINT) throw new Refusal('EISDIR', path);
        return then(this.statAt(parentOf(path), true, sync), (parent) => {
          if (parent !== null && !this.permits(parent, 3)) throw new Refusal('EACCES', path);
          throw new Refusal('EISDIR', path);
        });
      }
      const route = this.locate(path);
      // chmod, chown and utimes of a mount point change the mounted root, as
      // on Linux; only a directory above a mount point has no backend to ask.
      const metadataOnly = what === 'changed' && (path === ROOT_POINT || this.table.mounts.get(path) !== undefined);
      if (this.isStructural(path) && !metadataOnly) throw new Refusal('EBUSY', path, `a mount point cannot be ${what}`);
      if (route.mount.options.readOnly) throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
      return then(this.reachable(path, sync), () => then(parents ? this.makeTree(parentOf(path), undefined, sync) : undefined, () => {
        const ops = this.ops(route, sync);
        const removes = what === 'unlinked' || what === 'removed';
        return this.reportWrite<T>({
          path, route, ops, follow, kind: removes ? 'remove' : 'write',
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
   * and the namespace paths it lands at) by the table's guard
   * (guardMutations), for a view with a credential. Called right before the
   * backend is, on the path this namespace resolved.
   */
  private guardMutation(paths: readonly string[]): void {
    this.check?.();
    const guard = this.table.guard;
    const cred = this.viewer.cred;
    if (guard === undefined || cred === null) return;
    for (const path of paths) {
      const refusal = guard(cred, normalizePath(path));
      if (refusal !== null) throw new Refusal(refusal.code, path, refusal.detail);
    }
  }

  private mkdirAt(input: string, options: { recursive?: boolean; mode?: number } | undefined, sync: boolean): Awaitable<void> {
    return then(this.resolve(input, false, sync, options?.recursive === true), (path) => {
      this.present(path);
      if (this.isStructural(path)) {
        // mkdir -p of a live mount point (or a directory above one) has nothing to do.
        if (options?.recursive) return undefined;
        throw new Refusal('EBUSY', path, 'a mount point cannot be created');
      }
      const route = this.locate(path);
      if (route.mount.options.readOnly) throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
      if (!options?.recursive) {
        return then(this.reachable(path, sync), () => {
          const ops = this.ops(route, sync);
          return this.reportWrite({ path, route, ops, follow: false, kind: 'create' }, () => {
            this.guardMutation([input, path]);
            return (ops as SyncVFS).mkdir(route.rel, options);
          }, sync);
        });
      }
      this.guardMutation([input, path]);
      return this.makeTree(path, options.mode, sync);
    });
  }

  /**
   * mkdir -p of a resolved namespace path, across mounts: each missing
   * component in the filesystem it lives on, each checked by the mutation
   * guard right before it is made.
   */
  private makeTree(path: string, mode: number | undefined, sync: boolean): Awaitable<void> {
    const parts = path === ROOT_POINT ? [] : path.slice(1).split('/');
    const make = (i: number): Awaitable<void> => {
      if (i > parts.length) return undefined;
      const at = `/${parts.slice(0, i).join('/')}`;
      if (this.isStructural(at)) return make(i + 1);
      const r = this.locate(at);
      if (i === 1 || this.isStructural(`/${parts.slice(0, i - 1).join('/')}`)) {
        return then(this.reachable(at, sync), () => step(r, at, i));
      }
      return step(r, at, i);
    };
    const step = (r: Route, at: string, i: number): Awaitable<void> => {
      const ops = this.ops(r, sync) as SyncVFS;
      // Nothing is mounted below a directory that is not structural, so
      // a backend that resolves its own paths makes the rest in one call.
      if (r.mount.options.resolvesPaths) {
        const whole = this.locate(path);
        return this.reportWrite({ path, route: whole, ops, follow: true, kind: 'create', existingIsNoop: true }, () => {
          this.guardMutation([at, path]);
          return ops.mkdir(whole.rel, { recursive: true, mode });
        }, sync);
      }
      return then(this.softStat(ops, r.rel, true), (stat) => {
        if (stat !== null) {
          if (stat.type !== 'directory') {
            throw new Refusal(i === parts.length ? 'EEXIST' : 'ENOTDIR', at);
          }
          return make(i + 1);
        }
        return then(this.reportWrite({ path: at, route: r, ops, follow: false, kind: 'create' }, () => {
          this.guardMutation([at]);
          return ops.mkdir(r.rel, { mode });
        }, sync), () => make(i + 1));
      });
    };
    return make(1);
  }

  private renameAt(fromInput: string, toInput: string, sync: boolean): Awaitable<void> {
    return then(this.resolve(fromInput, false, sync), (from) => then(this.resolve(toInput, false, sync), (to) => {
      this.present(from);
      this.present(to);
      const source = this.locate(from);
      const target = this.locate(to);
      if (this.isStructural(from)) throw new Refusal('EBUSY', from, 'a mount point cannot be renamed');
      if (this.isStructural(to)) throw new Refusal('EBUSY', to, 'a mount point cannot be replaced');
      if (source.mount !== target.mount) {
        throw new Refusal('EXDEV', from, `${source.mount.point} and ${target.mount.point} are different filesystems`);
      }
      if (source.mount.options.readOnly) throw new Refusal('EROFS', from, `${source.mount.point} is mounted read-only`);
      return then(this.reachable(from, sync), () => then(this.reachable(to, sync), () => {
        const move = (): Awaitable<void> => {
          this.guardMutation([fromInput, from, toInput, to]);
          return this.renameIn(source, target, from, sync);
        };
        // A name renamed onto itself changes nothing.
        if (from === to) return move();
        return this.reportWrite({ path: to, route: target, ops: this.ops(target, sync), follow: false, kind: 'write', oldPath: from }, move, sync);
      }));
    }));
  }

  private renameIn(source: Route, target: Route, from: string, sync: boolean): Awaitable<void> {
    const ops = this.ops(source, sync) as SyncVFS;
    // A backend with no rename cannot move a name in place; EXDEV tells mv
    // to copy. A source that is not there is ENOENT first, as rename(2) says.
    if (typeof ops.rename !== 'function') {
      return then(this.softStat(ops, source.rel, false), (stat) => {
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
  private copyAt(fromInput: string, toInput: string, options: { recursive?: boolean; preserve?: boolean } | undefined, sync: boolean): Awaitable<number> {
    return then(this.resolve(fromInput, false, sync), (from) => { this.present(from); return then(this.resolve(toInput, false, sync), (to) => {
      this.present(to);
      const fromMount = this.table.mounts.get(from);
      if (from === ROOT_POINT || (this.isStructural(from) && fromMount === undefined) || (fromMount === undefined && this.hasLiveBelow(from))) {
        throw new Refusal('ENOTSUP', from, 'a tree holding another filesystem is copied by cp -r, not by this primitive');
      }
      if (to === ROOT_POINT || this.isStructural(to)) throw new Refusal('EBUSY', to, 'a mount point cannot be replaced');
      const source = this.locate(from);
      const target = this.locate(to);
      if (target.mount.options.readOnly) throw new Refusal('EROFS', to, `${target.mount.point} is mounted read-only`);
      const sourceOps = this.ops(source, sync) as SyncVFS;
      return then(this.statAt(from, false, sync), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', from);
        const dir = stat.type === 'directory';
        if (dir && !options?.recursive) throw new Refusal('EISDIR', from, 'a tree needs recursive');
        // The copy itself, at `at` (its namespace path): guarded right before
        // the backend is called, there and at the name given.
        const write = (at: string): Awaitable<number> => {
          const route = this.locate(at);
          if (route.mount.options.readOnly) throw new Refusal('EROFS', at, `${route.mount.point} is mounted read-only`);
          // A regular file is written through a link at its destination, as
          // cp opens it; a copied link or tree is made at the name.
          const follow = stat.type === 'file';
          if (source.mount === route.mount && typeof sourceOps.copy === 'function') {
            return this.reportWrite({ path: at, route, ops: sourceOps, follow, kind: 'write' }, () => {
              this.guardMutation([toInput, at]);
              return sourceOps.copy!(source.rel, route.rel, options);
            }, sync);
          }
          const targetOps = this.ops(route, sync);
          return this.reportWrite({ path: at, route, ops: targetOps, follow, kind: 'write' }, () => {
            this.guardMutation([toInput]);
            return this.copyBytes(sourceOps, source.rel, stat, targetOps as SyncVFS, route.rel, at);
          }, sync);
        };
        // The target's parent is a directory, unless its backend resolves its own paths and answers for it (it may make it).
        return then(target.mount.options.resolvesPaths ? undefined : then(this.statAt(parentOf(to), true, sync), (parent) => {
          if (parent === null) throw new Refusal('ENOENT', to);
          if (parent.type !== 'directory') throw new Refusal('ENOTDIR', to);
        }), () => {
          if (dir && (to === from || to.startsWith(`${from}/`))) throw new Refusal('EINVAL', to, 'a tree cannot be copied into itself');
          return then(this.statAt(to, false, sync), (existing) => {
            if (existing !== null) {
              if (dir) throw new Refusal('EEXIST', to);
              if (existing.type === 'directory') throw new Refusal('EISDIR', to);
            }
            if (stat.type !== 'file' || existing?.type !== 'symlink') return write(to);
            // A file is written through a link at the destination, as cp
            // opens it: where that write lands, the link followed, is what is
            // checked and written. (A link or a tree is made at the name.)
            return then(this.resolve(toInput, true, sync), (through) => {
              this.present(through);
              if (this.isStructural(through)) throw new Refusal('EBUSY', through, 'a mount point cannot be replaced');
              return then(this.statAt(through, false, sync), (landing) => {
                if (landing?.type === 'directory') throw new Refusal('EISDIR', to);
                return write(through);
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
   * after the reads it waited on.
   */
  private copyBytes(from: SyncVFS, fromRel: string, stat: VfsStat, to: SyncVFS, toRel: string, toAt: string): Awaitable<number> {
    const mode = stat.mode === undefined ? undefined : stat.mode & 0o7777;
    if (stat.type === 'symlink') {
      if (typeof from.readlink !== 'function' || typeof to.symlink !== 'function') {
        throw new Refusal('ENOTSUP', toRel, 'a link cannot be copied between these filesystems');
      }
      return then(from.readlink(fromRel), (target) => {
        this.guardMutation([toAt]);
        return then(to.symlink!(target, toRel), () => 1);
      });
    }
    if (stat.type === 'file') {
      return then(from.readFile(fromRel), (bytes) => {
        this.guardMutation([toAt]);
        return then(to.writeFile(toRel, bytes, mode === undefined ? undefined : { mode }), () => 1);
      });
    }
    this.guardMutation([toAt]);
    return then(to.mkdir(toRel, mode === undefined ? undefined : { mode }), () => then(from.readdir(fromRel), (entries) =>
      entries.reduce<Awaitable<number>>((count, entry) => then(count, (n) => {
        const child = fromRel === '/' ? `/${entry.name}` : `${fromRel}/${entry.name}`;
        const dest = toRel === '/' ? `/${entry.name}` : `${toRel}/${entry.name}`;
        return then(entry.stat ?? from.stat(child, { follow: false }), (childStat) => (childStat === null
          ? n
          : then(this.copyBytes(from, child, childStat, to, dest, `${toAt}/${entry.name}`), (m) => n + m)));
      }), 1)));
  }

  /** rmdir, or on a backend without it, an emptiness check and unlink. */
  private rmdirAt(input: string, sync: boolean): Awaitable<void> {
    return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
      const backend = ops as SyncVFS;
      if (typeof backend.rmdir === 'function') return backend.rmdir(rel);
      return then(backend.stat(rel, { follow: false }), (stat) => {
        if (stat === null) throw new Refusal('ENOENT', path);
        if (stat.type !== 'directory') throw new Refusal('ENOTDIR', path);
        return then(backend.readdir(rel), (entries) => {
          if (entries.length > 0) throw new Refusal('ENOTEMPTY', path);
          // Guarded again after the reads it waited on, right before the unlink.
          this.guardMutation([path]);
          return backend.unlink(rel);
        });
      });
    });
  }

  /**
   * rm -r of one tree, with an exact report. `removed` lists the maximal
   * removed subtrees (so a native removal is just the operand), `kept` every
   * entry still there: one whose own removal failed, and the directories
   * holding it. A walked removal carries on past a failure, as rm -r does,
   * and `failures` says why each one stayed.
   */
  private removeAt(input: string, sync: boolean): Awaitable<VfsRemoval> {
    return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
      if (this.hasLiveBelow(path)) throw new Refusal('EBUSY', path, 'something is mounted beneath it');
      const backend = ops as SyncVFS;
      if (typeof backend.removeRecursive === 'function') {
        const at = (r: string): string => (r === rel ? path : path + r.slice(rel === '/' ? 0 : rel.length));
        return then(backend.removeRecursive(rel), (report) => (report
          ? {
            removed: report.removed.map(at),
            kept: report.kept.map(at),
            // Each failure named as Node names the call that met it, on the namespace's path.
            failures: report.failures.map((f) => ({
              path: at(f.path),
              error: syscallError(f.error.code, f.error.syscall ?? 'rm', at(f.path), { detail: f.error.detail, cause: f.error }),
            })),
          }
          : { removed: [path], kept: [], failures: [] }));
      }
      return this.walkRemove(backend, rel, path);
    });
  }

  private walkRemove(ops: SyncVFS, rel: string, path: string): Awaitable<VfsRemoval> {
    const at = (r: string): string => (r === rel ? path : path + r.slice(rel === '/' ? 0 : rel.length));
    const order: Array<{ rel: string; dir: boolean }> = [];
    const visit = (r: string): Awaitable<void> => then(ops.stat(r, { follow: false }), (stat) => {
      if (stat === null) {
        if (r === rel) throw new Refusal('ENOENT', path);
        return undefined;
      }
      order.push({ rel: r, dir: stat.type === 'directory' });
      if (stat.type !== 'directory') return undefined;
      return then(ops.readdir(r), (entries) => entries.reduce<Awaitable<void>>(
        (chain, entry) => then(chain, () => visit(r === '/' ? `/${entry.name}` : `${r}/${entry.name}`)),
        undefined,
      ));
    });
    return then(visit(rel), () => {
      order.reverse();
      const kept = new Set<string>();
      const gone = new Set<string>();
      const failures: VfsRemovalFailure[] = [];
      const keepWithAncestors = (r: string): void => {
        for (let k = r; ; k = parentOf(k)) {
          kept.add(k);
          if (k === rel || k === '/') break;
        }
      };
      return then(order.reduce<Awaitable<void>>((chain, entry) => then(chain, () => {
        if (kept.has(entry.rel)) return undefined;
        const fail = (cause: unknown): void => {
          if (isVfsError(cause, 'ENOENT')) { gone.add(entry.rel); return; }
          keepWithAncestors(entry.rel);
          failures.push({
            path: at(entry.rel),
            error: syscallError(isVfsError(cause) ? cause.code : 'EIO', entry.dir ? 'rmdir' : 'unlink', at(entry.rel), {
              detail: isVfsError(cause) ? cause.detail : String(cause), cause,
            }),
          });
        };
        try {
          // Each entry guarded right before it is removed, after the walk's
          // reads: a refusal keeps it (and the directories holding it).
          this.guardMutation([at(entry.rel)]);
          const out = entry.dir && typeof ops.rmdir === 'function' ? ops.rmdir(entry.rel) : ops.unlink(entry.rel);
          if (isPromise(out)) return out.then(() => { gone.add(entry.rel); }, fail);
          gone.add(entry.rel);
          return undefined;
        } catch (cause) {
          fail(cause);
          return undefined;
        }
      }), undefined), () => {
        const removed = [...gone].filter((r) => r === rel || !gone.has(parentOf(r))).map(at).sort();
        return { removed, kept: [...kept].map(at).sort(), failures };
      });
    });
  }

  // ── the VFS surface ──────────────────────────────────────────────────
  //
  // Asynchronous throughout: a refusal is a rejected promise, never a throw
  // from the call itself, whatever the backend. \`sync\` is the synchronous face.

  async stat(path: string, options?: { follow?: boolean }): Promise<VfsStat | null> {
    return reported({ syscall: options?.follow === false ? 'lstat' : 'stat', path }, () => this.statAt(path, options?.follow !== false, false));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return reported({ syscall: 'open', path }, () => this.onFile(path, true, false, (ops, rel) => ops.readFile(rel)));
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return reported({ syscall: 'open', path }, () => this.onCapability(path, false, 'readRange', false, (fn, rel) => fn(rel, offset, length)));
  }

  /** `parents`: make the missing directories above where the write lands first (mkdir -p), as the write's own lookup resolves it. */
  async writeFile(path: string, data: Uint8Array, options?: { mode?: number; parents?: boolean }): Promise<void> {
    const mode = options?.mode === undefined ? undefined : { mode: options.mode };
    return reported({ syscall: 'open', path }, () =>
      this.onMutation(path, true, false, 'written', (ops, rel) => ops.writeFile(rel, data, mode), options?.parents === true));
  }

  /** `parents`: as writeFile's. */
  async writeRange(path: string, offset: number, bytes: Uint8Array, options?: { parents?: boolean }): Promise<void> {
    return reported({ syscall: 'open', path }, () =>
      this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes), options?.parents === true));
  }

  async truncate(path: string, size: number): Promise<void> {
    return reported({ syscall: 'open', path }, () => this.onMutation(path, true, false, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)));
  }

  async readdir(path: string): Promise<VfsDirent[]> {
    return reported({ syscall: 'scandir', path }, () => this.readdirAt(path, false));
  }

  /**
   * `readdir` with each entry's own stat (links not followed), identified as
   * `stat` identifies it: the stat the backend's listing carries, else one
   * asked of the backend that holds the name. A name gone between the two
   * is left out.
   */
  async readdirStat(path: string): Promise<Array<{ name: string; stat: VfsStat }>> {
    return reported({ syscall: 'scandir', path }, async () => this.statEntries(await this.resolve(path, true, false)));
  }

  /**
   * readdirStat of a directory already resolved in this namespace: the
   * directory is looked up once, and each entry's stat (when its listing
   * does not carry one) is one call to the backend that holds it, a few at
   * a time.
   */
  private async statEntries(dir: string): Promise<Array<{ name: string; stat: VfsStat }>> {
    const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
    const entries = await this.readdirOf(dir, false);
    const out: Array<{ name: string; stat: VfsStat } | null> = entries.map(() => null);
    const statOne = async (i: number): Promise<void> => {
      const entry = entries[i];
      const at = prefix + entry.name;
      let stat = entry.stat ?? null;
      if (stat === null) {
        // A mount point, or a directory above one, is the namespace's.
        if (this.isStructural(at)) stat = await this.statAt(at, false, false);
        else {
          const route = this.locate(at);
          stat = await this.softStat(this.ops(route, false), route.rel, false);
        }
      }
      if (stat !== null) out[i] = { name: entry.name, stat: this.identify(at, stat) };
    };
    for (let i = 0; i < entries.length; i += WALK_CONCURRENCY) {
      await Promise.all(entries.slice(i, i + WALK_CONCURRENCY).map((_, j) => statOne(i + j)));
    }
    return out.filter((entry): entry is { name: string; stat: VfsStat } => entry !== null);
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    return reported({ syscall: 'mkdir', path }, () => this.mkdirAt(path, options, false));
  }

  async unlink(path: string): Promise<void> {
    return reported({ syscall: 'unlink', path }, () => this.onMutation(path, false, false, 'unlinked', (ops, rel) => ops.unlink(rel)));
  }

  async rmdir(path: string): Promise<void> {
    return reported({ syscall: 'rmdir', path }, () => this.rmdirAt(path, false));
  }

  async rename(from: string, to: string): Promise<void> {
    return reported({ syscall: 'rename', path: from, dest: to }, () => this.renameAt(from, to, false));
  }

  async removeRecursive(path: string): Promise<VfsRemoval> {
    return reported({ syscall: 'rm', path }, () => this.removeAt(path, false));
  }

  async symlink(target: string, path: string): Promise<void> {
    return reported({ syscall: 'symlink', path: target, dest: path }, () =>
      this.onMutation(path, false, false, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)));
  }

  async readlink(path: string): Promise<string> {
    return reported({ syscall: 'readlink', path }, () => this.onFile(path, false, false, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)));
  }

  async chmod(path: string, mode: number): Promise<void> {
    return reported({ syscall: 'chmod', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)));
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    return reported({ syscall: 'chown', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)));
  }

  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    return reported({ syscall: 'utime', path }, () =>
      this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, atimeMs, mtimeMs)));
  }

  async writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): Promise<VfsCasResult> {
    return reported({ syscall: 'open', path }, () => this.onCapability(path, false, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected)));
  }

  async copy(from: string, to: string, options?: { recursive?: boolean; preserve?: boolean }): Promise<number> {
    return reported({ syscall: options?.recursive ? 'cp' : 'copyfile', path: from, dest: to }, () => this.copyAt(from, to, options, false));
  }

  async readFileAtRevision(path: string, revision: VfsRevision, range?: { offset: number; length: number }): Promise<Uint8Array> {
    return reported({ syscall: 'open', path }, () => this.onCapability(path, false, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range)));
  }

  describe(): VfsMountDescription {
    const root = this.backend(this.table.mounts.get(ROOT_POINT)!);
    return root?.describe?.() ?? { source: 'none', type: 'composite' };
  }

  private makeSync(): SyncVFS {
    return {
      stat: (path, options) => syncValue(reported({ syscall: options?.follow === false ? 'lstat' : 'stat', path }, () =>
        this.statAt(path, options?.follow !== false, true))),
      readFile: (path) => syncValue(reported({ syscall: 'open', path }, () => this.onFile(path, true, true, (ops, rel) => ops.readFile(rel)))),
      readRange: (path, offset, length) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onCapability(path, true, 'readRange', false, (fn, rel) => fn(rel, offset, length)))),
      writeFile: (path, data, options) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onMutation(path, true, true, 'written', (ops, rel) => ops.writeFile(rel, data, options)))),
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
      removeRecursive: (path) => syncValue(reported({ syscall: 'rm', path }, () => this.removeAt(path, true))),
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
        this.onCapability(path, true, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected)))),
      readFileAtRevision: (path, revision, range) => syncValue(reported({ syscall: 'open', path }, () =>
        this.onCapability(path, true, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range)))),
    };
  }
}
