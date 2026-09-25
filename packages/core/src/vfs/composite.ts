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
  Awaitable, SyncVFS, VFS, VfsCasResult, VfsCred, VfsDirent, VfsMountDescription, VfsRevision, VfsStat, VfsUsage,
} from './vfs.js';
import { VfsError, isVfsError } from './vfs-error.js';

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

interface Route {
  mount: Mount;
  /** The backend path, '/'-rooted. */
  rel: string;
  /** The namespace path, normalized. */
  path: string;
}

type Ops = VFS | SyncVFS;

const EPOCH_STAT: VfsStat = { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40555, uid: 0, gid: 0 };
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
  private readonly views: Map<string, CompositeVFS>;
  private readonly syncView: SyncVFS;

  constructor(root: VfsSource, options?: MountOptions);
  /** @internal a view over the same table. */
  constructor(root: VfsSource, options: MountOptions | undefined, shared: { table: Table; principal: Principal; views: Map<string, CompositeVFS> });
  constructor(root: VfsSource, options: MountOptions = {}, shared?: { table: Table; principal: Principal; views: Map<string, CompositeVFS> }) {
    if (shared) {
      this.table = shared.table;
      this.viewer = shared.principal;
      this.views = shared.views;
    } else {
      this.table = { mounts: new Map([[ROOT_POINT, { point: ROOT_POINT, source: root, options }]]), synthesized: new Map() };
      this.viewer = { cred: null };
      this.views = new Map();
    }
    this.syncView = this.makeSync();
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

  /** The same table as `cred` (and `actor`): sources are resolved for that principal. */
  as(cred: VfsCred, actor?: string): CompositeVFS {
    const principal: Principal = actor === undefined ? { cred } : { cred, actor };
    const key = principalKey(principal);
    let view = this.views.get(key);
    if (view === undefined) {
      view = new CompositeVFS(this.table.mounts.get(ROOT_POINT)!.source, undefined, {
        table: this.table, principal, views: this.views,
      });
      this.views.set(key, view);
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
  private resolve(input: string, follow: boolean, sync: boolean): Awaitable<string> {
    const walk = (path: string, hops: number): Awaitable<string> => {
      const parts = path === ROOT_POINT ? [] : path.slice(1).split('/');
      const step = (i: number): Awaitable<string> => {
        if (i > parts.length) return path;
        const prefix = `/${parts.slice(0, i).join('/')}`;
        if (this.isStructural(prefix)) return step(i + 1);
        const route = this.route(prefix);
        if (route.mount.point !== ROOT_POINT) return path;
        if (i === parts.length && !follow) return path;
        if (this.absentOn(prefix) !== null) return path;
        const ops = this.ops(route, sync) as SyncVFS;
        if (typeof ops.readlink !== 'function') return path;
        return then(this.softStat(ops, prefix, false), (stat) => {
          if (stat === null) return path;
          if (stat.type === 'symlink') {
            if (hops >= MAX_LINK_HOPS) throw new VfsError('ELOOP', 'too many levels of symbolic links', input);
            return then(ops.readlink!(prefix), (target) => {
              const base = target.startsWith('/') ? '' : parentOf(prefix);
              const rest = parts.slice(i).join('/');
              return walk(normalizePath(`${base}/${target}${rest ? `/${rest}` : ''}`), hops + 1);
            });
          }
          if (stat.type !== 'directory' && i < parts.length) return path;
          return step(i + 1);
        });
      };
      return step(1);
    };
    return walk(normalizePath(input), 0);
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
    return then(this.resolve(input, follow, sync), (path) => {
      if (this.absentOn(path) !== null) return null;
      // A live mount point and a directory above one are directories of this
      // namespace; the backend is not asked (some cannot stat their own root).
      if (path !== ROOT_POINT && this.isStructural(path)) return EPOCH_STAT;
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
      return then(this.reachable(path, sync), () => then((this.ops(route, sync) as SyncVFS).readdir(route.rel), finish));
    });
  }

  private emptyIfMissing(error: unknown): VfsDirent[] {
    if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR')) return [];
    throw error;
  }

  private onFile<T>(input: string, follow: boolean, sync: boolean, run: (ops: Ops, rel: string, path: string) => Awaitable<T>): Awaitable<T> {
    return then(this.resolve(input, follow, sync), (path) => {
      this.present(path);
      if (this.isStructural(path)) throw new VfsError('EISDIR', 'is a directory', path);
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
        throw new VfsError('EISDIR', 'is a directory', path);
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
    return then(this.resolve(input, false, sync), (path) => {
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

  private removeAt(input: string, sync: boolean): Awaitable<void> {
    return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
      if (this.hasLiveBelow(path)) throw new VfsError('EBUSY', 'something is mounted beneath it', path);
      const backend = ops as SyncVFS;
      if (typeof backend.removeRecursive === 'function') return backend.removeRecursive(rel);
      return this.walkRemove(backend, rel, path);
    });
  }

  /** Depth-first removal with base operations; a failure names what went and what is left. */
  private walkRemove(ops: SyncVFS, rel: string, path: string): Awaitable<void> {
    const order: Array<{ rel: string; dir: boolean }> = [];
    const visit = (at: string): Awaitable<void> => then(ops.stat(at, { follow: false }), (stat) => {
      if (stat === null) {
        if (at === rel) throw new VfsError('ENOENT', 'no such file or directory', path);
        return undefined;
      }
      order.push({ rel: at, dir: stat.type === 'directory' });
      if (stat.type !== 'directory') return undefined;
      return then(ops.readdir(at), (entries) => entries.reduce<Awaitable<void>>(
        (chain, entry) => then(chain, () => visit(at === '/' ? `/${entry.name}` : `${at}/${entry.name}`)),
        undefined,
      ));
    });
    return then(visit(rel), () => {
      order.reverse();
      const removed: string[] = [];
      return order.reduce<Awaitable<void>>((chain, entry, index) => then(chain, () => {
        const attempt = (): Awaitable<void> => (entry.dir && typeof ops.rmdir === 'function' ? ops.rmdir(entry.rel) : ops.unlink(entry.rel));
        const fail = (cause: unknown): void => {
          if (isVfsError(cause, 'ENOENT')) { removed.push(entry.rel); return; }
          const left = order.slice(index).map((e) => e.rel).join(', ');
          throw new VfsError(isVfsError(cause) ? cause.code : 'EIO',
            `removing ${entry.rel} failed (${cause instanceof Error ? cause.message : String(cause)}), so ${path} `
            + `was only partly removed: gone [${removed.join(', ') || 'none'}]; still present [${left}]`, path, { cause });
        };
        try {
          const out = attempt();
          if (isPromise(out)) return out.then(() => { removed.push(entry.rel); }, fail);
          removed.push(entry.rel);
          return undefined;
        } catch (cause) {
          fail(cause);
          return undefined;
        }
      }), undefined);
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
    return this.onFile(path, true, false, (ops, rel, at) => this.method(ops, 'readRange', at)(rel, offset, length));
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

  async removeRecursive(path: string): Promise<void> {
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
    return this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeFileIfRevision', at)(rel, data, expected));
  }

  async readFileAtRevision(path: string, revision: VfsRevision, range?: { offset: number; length: number }): Promise<Uint8Array> {
    return this.onFile(path, true, false, (ops, rel, at) => this.method(ops, 'readFileAtRevision', at)(rel, revision, range));
  }

  describe(): VfsMountDescription {
    const root = this.backend(this.table.mounts.get(ROOT_POINT)!);
    return root?.describe?.() ?? { source: 'none', type: 'composite' };
  }

  private makeSync(): SyncVFS {
    return {
      stat: (path, options) => this.statAt(path, options?.follow !== false, true) as VfsStat | null,
      readFile: (path) => this.onFile(path, true, true, (ops, rel) => (ops as SyncVFS).readFile(rel)) as Uint8Array,
      readRange: (path, offset, length) => this.onFile(path, true, true, (ops, rel, at) => this.method(ops, 'readRange', at)(rel, offset, length)) as Uint8Array,
      writeFile: (path, data, options) => this.onMutation(path, true, true, 'written', (ops, rel) => (ops as SyncVFS).writeFile(rel, data, options)) as void,
      writeRange: (path, offset, bytes) => this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes)) as void,
      truncate: (path, size) => this.onMutation(path, true, true, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)) as void,
      readdir: (path) => this.readdirAt(path, true) as VfsDirent[],
      mkdir: (path, options) => this.mkdirAt(path, options, true) as void,
      unlink: (path) => this.onMutation(path, false, true, 'unlinked', (ops, rel) => (ops as SyncVFS).unlink(rel)) as void,
      rmdir: (path) => this.rmdirAt(path, true) as void,
      rename: (from, to) => this.renameAt(from, to, true) as void,
      removeRecursive: (path) => this.removeAt(path, true) as void,
      symlink: (target, path) => this.onMutation(path, false, true, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)) as void,
      readlink: (path) => this.onFile(path, false, true, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)) as string,
      chmod: (path, mode) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)) as void,
      chown: (path, uid, gid) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)) as void,
      utimes: (path, a, m) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, a, m)) as void,
      copy: undefined,
      writeFileIfRevision: (path, data, expected) => this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeFileIfRevision', at)(rel, data, expected)) as VfsCasResult,
      readFileAtRevision: (path, revision, range) => this.onFile(path, true, true, (ops, rel, at) => this.method(ops, 'readFileAtRevision', at)(rel, revision, range)) as Uint8Array,
    };
  }
}

/**
 * Move a file between filesystems: the copy is confirmed before the source
 * goes, and a failure puts both sides back. Directories are refused before
 * any I/O. For callers that must move across mounts (mv does its own).
 */
export async function moveAcross(vfs: VFS, from: string, to: string): Promise<void> {
  const stat = await vfs.stat(from);
  if (stat === null) throw new VfsError('ENOENT', 'no such file or directory', from);
  if (stat.type === 'directory') throw new VfsError('EISDIR', 'only a file can be moved across filesystems', from);
  const payload = await vfs.readFile(from);
  const before = await vfs.stat(to);
  const previous = before !== null && before.type === 'file' ? await vfs.readFile(to) : null;
  await vfs.writeFile(to, payload, stat.mode === undefined ? undefined : { mode: stat.mode & 0o7777 });
  try {
    const landed = await vfs.stat(to);
    if (landed === null || landed.size !== payload.length) throw new VfsError('EIO', 'the copy is not there after writing it', to);
    await vfs.unlink(from);
  } catch (cause) {
    try {
      if (previous !== null) await vfs.writeFile(to, previous);
      else if ((await vfs.stat(to)) !== null) await vfs.unlink(to);
      if ((await vfs.stat(from)) === null) await vfs.writeFile(from, payload);
    } catch (rollback) {
      throw new VfsError('EIO', `the move failed and could not be undone: ${String(rollback)}`, to, { cause });
    }
    throw cause;
  }
}
