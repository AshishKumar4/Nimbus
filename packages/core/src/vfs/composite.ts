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
  Awaitable, SyncVFS, VFS, VfsCasResult, VfsChanges, VfsCred, VfsDirent, VfsMountDescription, VfsRemoval, VfsRemovalFailure, VfsRevision, VfsStat, VfsUsage,
} from './vfs.js';
import type { RuntimeVfsStat, VfsAcquireOptions, VfsInvalidatedPath, VfsListEntry } from '../runtime/os-contracts.js';
import { VfsError, isVfsError } from './vfs-error.js';

/**
 * Where a reader of a namespace's feed stands: the mount table as its
 * principal saw it, and each change feed's epoch and cursor.
 */
export interface FeedPosition {
  readonly table: string;
  readonly feeds: Readonly<Record<string, { readonly epoch: string; readonly cursor: number }>>;
}

/** One answer of the feed: every path changed since the position, or a poison (relist). */
export interface FeedAnswer {
  readonly position: FeedPosition;
  readonly poison: boolean;
  readonly paths: VfsInvalidatedPath[];
}

/**
 * The change feed of a principal's namespace (FormalModelsLane
 * `Vfs/CompositeFeed`): each backend's feed re-rooted under its mount point
 * and filtered to the paths the namespace routes to it, so a root row a
 * mount covers is never staged. A reader takes `position()`, then lists,
 * then asks `since` at every barrier. Entries carry their backend's `rev`.
 */
export interface CompositeFeed {
  position(): FeedPosition;
  since(position: FeedPosition, options?: VfsAcquireOptions): FeedAnswer;
  list(after: string | null, limit: number): { entries: VfsListEntry[]; next: string | null };
}

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
const ROOT_POINT = '/';
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;

/** `/a/b`, from any spelling; `..` stops at the root. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of String(path).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function isPromise<T>(value: Awaitable<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** Apply `next` to a value that may or may not be a promise, staying synchronous when it is not. */
function then<T, U>(value: Awaitable<T>, next: (resolved: T) => Awaitable<U>): Awaitable<U> {
  return isPromise(value) ? value.then(next) : next(value);
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
  private readonly viewed = new WeakMap<VFS, VFS>();
  /**
   * Views per principal, held weakly: one per principal while someone holds
   * it, none once no one does (a table serving thousands of agents does not
   * keep a view per agent for its life).
   */
  private readonly views: Views;
  private readonly syncView: SyncVFS;

  constructor(root: VfsSource, options?: MountOptions);
  /** @internal a view over the same table. */
  constructor(root: VfsSource, options: MountOptions | undefined, shared: { table: Table; principal: Principal; views: Views });
  constructor(root: VfsSource, options: MountOptions = {}, shared?: { table: Table; principal: Principal; views: Views }) {
    if (shared) {
      this.table = shared.table;
      this.viewer = shared.principal;
      this.views = shared.views;
    } else {
      this.table = { mounts: new Map([[ROOT_POINT, { point: ROOT_POINT, source: root, options }]]), synthesized: new Map() };
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
      list: (after, limit) => this.feedList(after, limit),
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
    if (this.route(path).mount !== mount || this.absentOn(path) !== null) return false;
    return !this.isStructural(path) || this.table.mounts.get(path) === mount;
  }

  private feedSince(position: FeedPosition, options?: VfsAcquireOptions): FeedAnswer {
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
        if (this.isStructural(at) && this.route(at).mount === mount && (entry.subtree === true || entry.structural === true)) {
          return poison();
        }
      }
    }
    return { position: { table, feeds }, poison: false, paths };
  }

  /**
   * One page of every name the namespace shows, in path order: each feed's
   * listing re-rooted and filtered, merged with the directories the
   * namespace makes (mount points and their ancestors). A mount without a
   * feed shows only its point. Take `position()` before the first page.
   */
  private feedList(after: string | null, limit: number): { entries: VfsListEntry[]; next: string | null } {
    const want = Math.max(1, limit);
    const streams: Array<{ entries: VfsListEntry[]; more: boolean }> = [];
    const made: VfsListEntry[] = [];
    for (const point of [...this.table.mounts.keys(), ...this.table.synthesized.keys()]) {
      if (point === ROOT_POINT || !this.isStructural(point) || (after !== null && point <= after)) continue;
      if (made.some((entry) => entry.path === point)) continue;
      made.push({ path: point, kind: 'directory', size: 0, rev: 0, stat: this.madeStat(point) });
    }
    made.sort((a, b) => (a.path < b.path ? -1 : 1));
    streams.push({ entries: made, more: false });
    for (const { mount, changes } of this.feedSources()) {
      if (!changes) continue;
      const point = mount.point;
      let from: string | null;
      if (point === ROOT_POINT || after === null || after < `${point}/`) from = point === ROOT_POINT ? after : null;
      else if (after.startsWith(`${point}/`)) from = after.slice(point.length);
      else continue;
      const entries: VfsListEntry[] = [];
      let more = true;
      while (entries.length < want && more) {
        const page = changes.list(from, want);
        for (const entry of page.entries) {
          const at = CompositeVFS.reroot(point, entry.path);
          if ((after === null || at > after) && this.feedShows(at, mount) && at !== point) {
            entries.push(at === entry.path ? entry : { ...entry, path: at });
          }
        }
        more = page.next !== null;
        from = page.next;
      }
      streams.push({ entries, more });
    }
    const merged = streams.flatMap((stream) => stream.entries).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const entries = merged.slice(0, want);
    const more = merged.length > want || streams.some((stream) => stream.more);
    return { entries, next: more && entries.length > 0 ? entries[entries.length - 1].path : null };
  }

  /** A directory the namespace makes, as a listing entry: the mounted root's own stat where it answers one. */
  private madeStat(point: string): RuntimeVfsStat {
    const mount = this.table.mounts.get(point);
    if (mount === undefined) return SYNTH_RUNTIME_STAT;
    try {
      const stat = this.statAt(point, false, true);
      if (stat === null || isPromise(stat) || stat.type !== 'directory') return SYNTH_RUNTIME_STAT;
      return {
        ...SYNTH_RUNTIME_STAT,
        mode: stat.mode ?? SYNTH_RUNTIME_STAT.mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0,
        mtime: stat.mtimeMs ?? 0, atime: stat.atimeMs ?? stat.mtimeMs ?? 0, ctime: stat.ctimeMs ?? stat.mtimeMs ?? 0,
      };
    } catch {
      return SYNTH_RUNTIME_STAT;
    }
  }

  // ── the table ──────────────────────────────────────────────────────────

  mount(point: string, source: VfsSource, options: MountOptions = {}): void {
    const at = normalizePath(point);
    if (at === ROOT_POINT) throw new VfsError('EBUSY', 'the root is mounted at construction', point);
    if (this.table.mounts.has(at)) throw new VfsError('EBUSY', 'something is already mounted there', point);
    this.table.mounts.set(at, { point: at, source, options });
    this.resynthesize();
  }

  unmount(point: string): void {
    const at = normalizePath(point);
    if (at === ROOT_POINT || !this.table.mounts.delete(at)) throw new VfsError('EINVAL', 'nothing is mounted there', point);
    this.resynthesize();
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
    return this.route(normalizePath(path)).mount.point;
  }

  /**
   * Whether the namespace answers `path` itself rather than the root
   * backend alone: a path on another mount, or a directory above a mount
   * point (whose listing includes the mount's name).
   */
  composes(path: string): boolean {
    const at = normalizePath(path);
    return this.route(at).mount.point !== ROOT_POINT || (at !== ROOT_POINT && this.isStructural(at));
  }

  /** The path with every link resolved, as this principal sees the namespace (ENOENT when absent). */
  realpath(path: string): string {
    const resolved = this.resolve(path, true, true) as string;
    if (this.statAt(resolved, false, true) === null) throw new VfsError('ENOENT', path);
    return resolved;
  }

  /** The same table as `cred` (and `actor`): sources are resolved for that principal. */
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
  // that backend's.

  private route(path: string): Route {
    for (let at = path; ; at = parentOf(at)) {
      const mount = this.table.mounts.get(at);
      if (mount !== undefined) {
        return { mount, path, rel: at === ROOT_POINT ? path : path.length === at.length ? '/' : path.slice(at.length) };
      }
      if (at === ROOT_POINT) throw new Error('the root mount is missing');
    }
  }

  private backend(mount: Mount): VFS | null {
    const found = typeof mount.source === 'function' ? mount.source(this.viewer) : mount.source;
    if (found === null || found === undefined) return null;
    const cred = this.viewer.cred;
    if (cred === null || found.as === undefined) return found;
    let view = this.viewed.get(found);
    if (view === undefined) this.viewed.set(found, view = found.as(cred));
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
    const reason = mount.options.absentReason?.(this.viewer) ?? 'nothing is mounted there now';
    return new VfsError('ENXIO', `${mount.point} — ${reason}`, path);
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
      throw new VfsError('EAGAIN', `${route.mount.point} is an asynchronous mount; this caller cannot wait for it`, route.path);
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
      if (stat === null) throw new VfsError('ENOENT', 'no such file or directory', path);
      const fn = (ops as SyncVFS)[name];
      if (typeof fn !== 'function') throw new VfsError('ENOTSUP', `this filesystem does not support ${String(name)}`, path);
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
        throw new VfsError('EISDIR', 'is a directory', path);
      }
      const route = this.route(path);
      if (write && route.mount.options.readOnly) throw new VfsError('EROFS', `${route.mount.point} is mounted read-only`, path);
      return then(this.reachable(path, sync), () =>
        this.capability(this.ops(route, sync), name, route.rel, path, (fn) => run(fn, route.rel)));
    });
  }

  private method<K extends keyof SyncVFS>(ops: Ops, name: K, path: string): NonNullable<SyncVFS[K]> {
    const fn = (ops as SyncVFS)[name];
    if (typeof fn !== 'function') throw new VfsError('ENOTSUP', `this filesystem does not support ${String(name)}`, path);
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
            // root, or the directory a backend holds at that path.
            shadowParent = false;
            if (final) continue;
            const mount = this.table.mounts.get(prefix);
            return then(mount === undefined ? this.heldDirectory(prefix, sync) : this.mountRoot(mount, prefix, sync), (held) => {
              if (held !== null && !this.permits(held, 1)) throw new VfsError('EACCES', 'permission denied', input);
              shadowParent = mount === undefined && held === null;
              return step(at + 1);
            });
          }
          if (shadowParent) {
            shadowParent = false;
            if (!final) throw new VfsError('ENOENT', 'no such file or directory', input);
            continue;
          }
          if (this.absentOn(prefix) !== null) continue;
          const route = this.route(prefix);
          if (final && !follow) continue;
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
              if (hops >= MAX_LINK_HOPS) throw new VfsError('ELOOP', 'too many levels of symbolic links', input);
              return then(ops.readlink!(route.rel), (target) => walk([
                ...(target.startsWith('/') ? [] : resolved.slice(0, -1)),
                ...target.split('/'),
                ...components.slice(at + 1),
              ], hops + 1));
            }
            if (!final) {
              if (stat === null) {
                if (creating) return step(at + 1);
                throw new VfsError('ENOENT', 'no such file or directory', input);
              }
              if (stat.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', input);
              if (!this.permits(stat, 1)) throw new VfsError('EACCES', 'permission denied', input);
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
   */
  private heldDirectory(path: string, sync: boolean): Awaitable<VfsStat | null> {
    const route = this.route(path);
    const held = (stat: VfsStat | null): VfsStat | null => (stat !== null && stat.type === 'directory' ? stat : null);
    // A file above it (ENOTDIR) or no stat at all (ENOTSUP): the backend holds no directory there.
    const unsupported = (error: unknown): null => { if (isVfsError(error, 'ENOTSUP') || isVfsError(error, 'ENOTDIR')) return null; throw error; };
    try {
      const out = this.softStat(this.ops(route, sync), route.rel, false);
      return isPromise(out) ? out.then(held, unsupported) : held(out);
    } catch (error) {
      return unsupported(error);
    }
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
   * Whether the backend holds a directory that exists only above a mount
   * point (not a mount point) as something else, a link or a file. Then that
   * directory holds only its mount names (rule 2 applied to ancestors: a
   * mount covers everything under its path).
   */
  private coversNonDirectory(dir: string, sync: boolean): Awaitable<boolean> {
    const route = this.route(dir);
    return then(this.softStat(this.ops(route, sync), route.rel, false), (stat) => stat !== null && stat.type !== 'directory');
  }

  /** Whether `path` lies under such a covered directory (and is not itself a mount name there). */
  private shadowed(path: string, sync: boolean): Awaitable<boolean> {
    if (this.isStructural(path)) return false;
    // Only directories the path's own backend serves: one above the path's
    // mount point belongs to another filesystem, which the mount covers.
    const point = this.route(path).mount.point;
    const covered: string[] = [];
    for (let at = parentOf(path); at !== ROOT_POINT && at !== point && at.length > point.length; at = parentOf(at)) {
      if (this.isStructural(at) && !this.table.mounts.has(at)) covered.push(at);
    }
    const next = (i: number): Awaitable<boolean> => (i >= covered.length
      ? false
      : then(this.coversNonDirectory(covered[i]!, sync), (hidden) => hidden || next(i + 1)));
    return next(0);
  }

  /** ENOENT when `path` is shadowed. */
  private reachable(path: string, sync: boolean): Awaitable<void> {
    return then(this.shadowed(path, sync), (hidden) => {
      if (hidden) throw new VfsError('ENOENT', 'no such file or directory', path);
    });
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
    return then(walked(), (path) => {
      if (path === null) return null;
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
        const route = this.route(path);
        return this.softStat(this.ops(route, sync), route.rel, follow);
      });
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
    return then(this.resolve(input, true, sync), (path) => {
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
        // holds a directory there, else only the mount points.
        const route = this.route(path);
        const listed = (): Awaitable<VfsDirent[]> => then(this.coversNonDirectory(path, sync), (covers) => {
          if (covers) return [];
          try {
            const out = (this.ops(route, sync) as SyncVFS).readdir(route.rel);
            return isPromise(out) ? out.catch((e: unknown) => this.emptyIfMissing(e)) : out;
          } catch (e) {
            return this.emptyIfMissing(e);
          }
        });
        return then(this.reachable(path, sync), () => then(listed(), finish));
      }
      const route = this.route(path);
      const ops = this.ops(route, sync) as SyncVFS;
      // opendir(O_DIRECTORY) answers ENOTDIR before a permission check.
      const notDirectoryFirst = (error: unknown): Awaitable<VfsDirent[]> => {
        if (!isVfsError(error, 'EACCES')) throw error;
        return then(this.softStat(ops, route.rel, true), (stat) => {
          if (stat !== null && stat.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', path);
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
    });
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
          if (stat !== null && !this.permits(stat, 4)) throw new VfsError('EACCES', 'permission denied', path);
          throw new VfsError('EISDIR', 'is a directory', path);
        });
      }
      const route = this.route(path);
      return then(this.reachable(path, sync), () => run(this.ops(route, sync), route.rel, path));
    });
  }

  private onMutation<T>(
    input: string, follow: boolean, sync: boolean, what: string,
    run: (ops: Ops, rel: string, path: string) => Awaitable<T>,
  ): Awaitable<T> {
    return then(this.resolve(input, follow, sync), (path) => {
      this.present(path);
      // unlink(2) refuses a directory before anything else (Linux), and a
      // mount point is one.
      if (what === 'unlinked' && (path === ROOT_POINT || this.isStructural(path))) {
        // may_delete: write and search on the parent, then EISDIR.
        if (path === ROOT_POINT) throw new VfsError('EISDIR', 'is a directory', path);
        return then(this.statAt(parentOf(path), true, sync), (parent) => {
          if (parent !== null && !this.permits(parent, 3)) throw new VfsError('EACCES', 'permission denied', path);
          throw new VfsError('EISDIR', 'is a directory', path);
        });
      }
      const route = this.route(path);
      // chmod, chown and utimes of a mount point change the mounted root, as
      // on Linux; only a directory above a mount point has no backend to ask.
      const metadataOnly = what === 'changed' && (path === ROOT_POINT || this.table.mounts.get(path) !== undefined);
      if (this.isStructural(path) && !metadataOnly) throw new VfsError('EBUSY', `a mount point cannot be ${what}`, path);
      if (route.mount.options.readOnly) throw new VfsError('EROFS', `${route.mount.point} is mounted read-only`, path);
      return then(this.reachable(path, sync), () => run(this.ops(route, sync), route.rel, path));
    });
  }

  private mkdirAt(input: string, options: { recursive?: boolean; mode?: number } | undefined, sync: boolean): Awaitable<void> {
    return then(this.resolve(input, false, sync, options?.recursive === true), (path) => {
      this.present(path);
      if (this.isStructural(path)) {
        // mkdir -p of a live mount point (or a directory above one) has nothing to do.
        if (options?.recursive) return undefined;
        throw new VfsError('EBUSY', 'a mount point cannot be created', path);
      }
      const route = this.route(path);
      if (route.mount.options.readOnly) throw new VfsError('EROFS', `${route.mount.point} is mounted read-only`, path);
      if (!options?.recursive) {
        return then(this.reachable(path, sync), () => (this.ops(route, sync) as SyncVFS).mkdir(route.rel, options));
      }
      // -p across mounts: each missing component in the filesystem it lives on.
      const parts = path.slice(1).split('/');
      const make = (i: number): Awaitable<void> => {
        if (i > parts.length) return undefined;
        const at = `/${parts.slice(0, i).join('/')}`;
        if (this.isStructural(at)) return make(i + 1);
        const r = this.route(at);
        if (i === 1 || this.isStructural(`/${parts.slice(0, i - 1).join('/')}`)) {
          return then(this.reachable(at, sync), () => step(r, at, i));
        }
        return step(r, at, i);
      };
      const step = (r: Route, at: string, i: number): Awaitable<void> => {
        const ops = this.ops(r, sync) as SyncVFS;
        return then(this.softStat(ops, r.rel, true), (stat) => {
          if (stat !== null) {
            if (stat.type !== 'directory') {
              throw new VfsError(i === parts.length ? 'EEXIST' : 'ENOTDIR', i === parts.length ? 'file exists' : 'not a directory', at);
            }
            return make(i + 1);
          }
          return then(ops.mkdir(r.rel, { mode: options.mode }), () => make(i + 1));
        });
      };
      return make(1);
    });
  }

  private renameAt(fromInput: string, toInput: string, sync: boolean): Awaitable<void> {
    return then(this.resolve(fromInput, false, sync), (from) => then(this.resolve(toInput, false, sync), (to) => {
      this.present(from);
      this.present(to);
      const source = this.route(from);
      const target = this.route(to);
      if (this.isStructural(from)) throw new VfsError('EBUSY', 'a mount point cannot be renamed', from);
      if (this.isStructural(to)) throw new VfsError('EBUSY', 'a mount point cannot be replaced', to);
      if (source.mount !== target.mount) {
        throw new VfsError('EXDEV', `${source.mount.point} and ${target.mount.point} are different filesystems`, from);
      }
      if (source.mount.options.readOnly) throw new VfsError('EROFS', `${source.mount.point} is mounted read-only`, from);
      return then(this.reachable(from, sync), () => then(this.reachable(to, sync), () => this.renameIn(source, target, from, sync)));
    }));
  }

  private renameIn(source: Route, target: Route, from: string, sync: boolean): Awaitable<void> {
    const ops = this.ops(source, sync) as SyncVFS;
    // A backend with no rename cannot move a name in place; EXDEV tells mv
    // to copy. A source that is not there is ENOENT first, as rename(2) says.
    if (typeof ops.rename !== 'function') {
      return then(this.softStat(ops, source.rel, false), (stat) => {
        if (stat === null) throw new VfsError('ENOENT', 'no such file or directory', from);
        throw new VfsError('EXDEV', `${source.mount.point} cannot rename in place`, from);
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
        throw new VfsError('ENOTSUP', 'a tree holding another filesystem is copied by cp -r, not by this primitive', from);
      }
      if (to === ROOT_POINT || this.isStructural(to)) throw new VfsError('EBUSY', 'a mount point cannot be replaced', to);
      const source = this.route(from);
      const target = this.route(to);
      if (target.mount.options.readOnly) throw new VfsError('EROFS', `${target.mount.point} is mounted read-only`, to);
      const sourceOps = this.ops(source, sync) as SyncVFS;
      return then(this.statAt(from, false, sync), (stat) => {
        if (stat === null) throw new VfsError('ENOENT', 'no such file or directory', from);
        const dir = stat.type === 'directory';
        if (dir && !options?.recursive) throw new VfsError('EISDIR', 'is a directory (a tree needs recursive)', from);
        return then(this.statAt(parentOf(to), true, sync), (parent) => {
          if (parent === null) throw new VfsError('ENOENT', 'no such file or directory', to);
          if (parent.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', to);
          if (dir && (to === from || to.startsWith(`${from}/`))) throw new VfsError('EINVAL', 'a tree cannot be copied into itself', to);
          return then(this.statAt(to, false, sync), (existing) => {
            if (existing !== null) {
              if (dir) throw new VfsError('EEXIST', 'file exists', to);
              if (existing.type === 'directory') throw new VfsError('EISDIR', 'is a directory', to);
            }
            if (source.mount === target.mount && typeof sourceOps.copy === 'function') {
              return sourceOps.copy(source.rel, target.rel, options);
            }
            return this.copyBytes(sourceOps, source.rel, stat, this.ops(target, sync) as SyncVFS, target.rel);
          });
        });
      });
    }); });
  }

  /** Copy an entry (a tree when it is a directory) between backends, links as links. */
  private copyBytes(from: SyncVFS, fromRel: string, stat: VfsStat, to: SyncVFS, toRel: string): Awaitable<number> {
    const mode = stat.mode === undefined ? undefined : stat.mode & 0o7777;
    if (stat.type === 'symlink') {
      if (typeof from.readlink !== 'function' || typeof to.symlink !== 'function') {
        throw new VfsError('ENOTSUP', 'a link cannot be copied between these filesystems', toRel);
      }
      return then(from.readlink(fromRel), (target) => then(to.symlink!(target, toRel), () => 1));
    }
    if (stat.type === 'file') {
      return then(from.readFile(fromRel), (bytes) => then(to.writeFile(toRel, bytes, mode === undefined ? undefined : { mode }), () => 1));
    }
    return then(to.mkdir(toRel, mode === undefined ? undefined : { mode }), () => then(from.readdir(fromRel), (entries) =>
      entries.reduce<Awaitable<number>>((count, entry) => then(count, (n) => {
        const child = fromRel === '/' ? `/${entry.name}` : `${fromRel}/${entry.name}`;
        const dest = toRel === '/' ? `/${entry.name}` : `${toRel}/${entry.name}`;
        return then(entry.stat ?? from.stat(child, { follow: false }), (childStat) => (childStat === null
          ? n
          : then(this.copyBytes(from, child, childStat, to, dest), (m) => n + m)));
      }), 1)));
  }

  /** rmdir, or on a backend without it, an emptiness check and unlink. */
  private rmdirAt(input: string, sync: boolean): Awaitable<void> {
    return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
      const backend = ops as SyncVFS;
      if (typeof backend.rmdir === 'function') return backend.rmdir(rel);
      return then(backend.stat(rel, { follow: false }), (stat) => {
        if (stat === null) throw new VfsError('ENOENT', 'no such file or directory', path);
        if (stat.type !== 'directory') throw new VfsError('ENOTDIR', 'not a directory', path);
        return then(backend.readdir(rel), (entries) => {
          if (entries.length > 0) throw new VfsError('ENOTEMPTY', 'directory not empty', path);
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
      if (this.hasLiveBelow(path)) throw new VfsError('EBUSY', 'something is mounted beneath it', path);
      const backend = ops as SyncVFS;
      if (typeof backend.removeRecursive === 'function') {
        const at = (r: string): string => (r === rel ? path : path + r.slice(rel === '/' ? 0 : rel.length));
        return then(backend.removeRecursive(rel), (report) => (report
          ? { removed: report.removed.map(at), kept: report.kept.map(at), failures: report.failures.map((f) => ({ ...f, path: at(f.path) })) }
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
        if (r === rel) throw new VfsError('ENOENT', 'no such file or directory', path);
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
          failures.push({ path: at(entry.rel), error: isVfsError(cause) ? cause : new VfsError('EIO', String(cause), at(entry.rel)) });
        };
        try {
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
    return this.statAt(path, options?.follow !== false, false);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.onFile(path, true, false, (ops, rel) => (ops as SyncVFS).readFile(rel));
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.onCapability(path, false, 'readRange', false, (fn, rel) => fn(rel, offset, length));
  }

  async writeFile(path: string, data: Uint8Array, options?: { mode?: number }): Promise<void> {
    return this.onMutation(path, true, false, 'written', (ops, rel) => (ops as SyncVFS).writeFile(rel, data, options));
  }

  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    return this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes));
  }

  async truncate(path: string, size: number): Promise<void> {
    return this.onMutation(path, true, false, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size));
  }

  async readdir(path: string): Promise<VfsDirent[]> {
    return this.readdirAt(path, false);
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    return this.mkdirAt(path, options, false);
  }

  async unlink(path: string): Promise<void> {
    return this.onMutation(path, false, false, 'unlinked', (ops, rel) => (ops as SyncVFS).unlink(rel));
  }

  async rmdir(path: string): Promise<void> {
    return this.rmdirAt(path, false);
  }

  async rename(from: string, to: string): Promise<void> {
    return this.renameAt(from, to, false);
  }

  async removeRecursive(path: string): Promise<VfsRemoval> {
    return this.removeAt(path, false);
  }

  async symlink(target: string, path: string): Promise<void> {
    return this.onMutation(path, false, false, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel));
  }

  async readlink(path: string): Promise<string> {
    return this.onFile(path, false, false, (ops, rel, at) => this.method(ops, 'readlink', at)(rel));
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode));
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    return this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid));
  }

  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    return this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, atimeMs, mtimeMs));
  }

  async writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): Promise<VfsCasResult> {
    return this.onCapability(path, false, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected));
  }

  async copy(from: string, to: string, options?: { recursive?: boolean; preserve?: boolean }): Promise<number> {
    return this.copyAt(from, to, options, false);
  }

  async readFileAtRevision(path: string, revision: VfsRevision, range?: { offset: number; length: number }): Promise<Uint8Array> {
    return this.onCapability(path, false, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range));
  }

  describe(): VfsMountDescription {
    const root = this.backend(this.table.mounts.get(ROOT_POINT)!);
    return root?.describe?.() ?? { source: 'none', type: 'composite' };
  }

  private makeSync(): SyncVFS {
    return {
      stat: (path, options) => this.statAt(path, options?.follow !== false, true) as VfsStat | null,
      readFile: (path) => this.onFile(path, true, true, (ops, rel) => (ops as SyncVFS).readFile(rel)) as Uint8Array,
      readRange: (path, offset, length) => this.onCapability(path, true, 'readRange', false, (fn, rel) => fn(rel, offset, length)) as Uint8Array,
      writeFile: (path, data, options) => this.onMutation(path, true, true, 'written', (ops, rel) => (ops as SyncVFS).writeFile(rel, data, options)) as void,
      writeRange: (path, offset, bytes) => this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes)) as void,
      truncate: (path, size) => this.onMutation(path, true, true, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)) as void,
      readdir: (path) => this.readdirAt(path, true) as VfsDirent[],
      mkdir: (path, options) => this.mkdirAt(path, options, true) as void,
      unlink: (path) => this.onMutation(path, false, true, 'unlinked', (ops, rel) => (ops as SyncVFS).unlink(rel)) as void,
      rmdir: (path) => this.rmdirAt(path, true) as void,
      rename: (from, to) => this.renameAt(from, to, true) as void,
      removeRecursive: (path) => { this.removeAt(path, true); },
      symlink: (target, path) => this.onMutation(path, false, true, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)) as void,
      readlink: (path) => this.onFile(path, false, true, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)) as string,
      chmod: (path, mode) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)) as void,
      chown: (path, uid, gid) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)) as void,
      utimes: (path, a, m) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, a, m)) as void,
      copy: (from, to, options) => this.copyAt(from, to, options, true) as number,
      writeFileIfRevision: (path, data, expected) => this.onCapability(path, true, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected)) as VfsCasResult,
      readFileAtRevision: (path, revision, range) => this.onCapability(path, true, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range)) as Uint8Array,
    };
  }
}
