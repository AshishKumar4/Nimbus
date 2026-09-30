import { VfsError, VFS_DESCRIPTION, isVfsError, syscallError } from './vfs-error.js';
/** Path order as SQLite's index keeps it: by UTF-8 bytes, which is code point order. */
export function comparePaths(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a.charCodeAt(i), y = b.charCodeAt(i);
        if (x === y)
            continue;
        // A surrogate half (a code point past U+FFFF) sorts after U+E000..U+FFFF.
        if (x >= 0xd800 && x <= 0xdfff && y >= 0xe000)
            return 1;
        if (y >= 0xd800 && y <= 0xdfff && x >= 0xe000)
            return -1;
        return x - y;
    }
    return a.length - b.length;
}
/** `entries` in path order: as given when they already are (a backend's listing is), else sorted. */
function inPathOrder(entries) {
    for (let i = 1; i < entries.length; i++) {
        if (comparePaths(entries[i - 1].path, entries[i].path) > 0)
            return [...entries].sort((a, b) => comparePaths(a.path, b.path));
    }
    return entries;
}
/** The first `limit` entries of two runs in path order, in path order. */
function mergeByPath(a, b, limit) {
    const out = [];
    for (let i = 0, j = 0; out.length < limit && (i < a.length || j < b.length);) {
        if (j >= b.length || (i < a.length && comparePaths(a[i].path, b[j].path) <= 0))
            out.push(a[i++]);
        else
            out.push(b[j++]);
    }
    return out;
}
/** Directories a walk (or a readdir's stats) reads at once. */
const WALK_CONCURRENCY = 8;
/** Identity of a mount's source object, for the table signature. */
const sourceIds = new WeakMap();
let nextSourceId = 1;
function sourceId(found) {
    if (found === null || typeof found !== 'object')
        return 0;
    let id = sourceIds.get(found);
    if (id === undefined)
        sourceIds.set(found, id = nextSourceId++);
    return id;
}
const SYNTH_RUNTIME_STAT = {
    dev: 0, ino: 0, nlink: 1, type: 'directory', size: 0, ctime: 0, atime: 0, mtime: 0, mode: 0o40755, uid: 0, gid: 0, revision: 0,
};
/**
 * A namespace entry's stat in the runtime contract's shape: its identity
 * (dev, ino) is the namespace's, and a mounted backend's entries carry no
 * SQLite revision.
 */
export function runtimeStatOf(stat) {
    const typeBits = stat.type === 'directory' ? 0o040000 : stat.type === 'symlink' ? 0o120000 : 0o100000;
    const mode = stat.mode === undefined ? typeBits | (stat.type === 'directory' ? 0o755 : 0o644) : (stat.mode & 0o170000 ? stat.mode : typeBits | stat.mode);
    return {
        dev: stat.dev ?? 0, ino: stat.ino ?? 0, nlink: stat.nlink ?? 1, type: stat.type, size: stat.size,
        ctime: stat.ctimeMs ?? stat.mtimeMs, atime: stat.atimeMs ?? stat.mtimeMs, mtime: stat.mtimeMs,
        mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: 0,
    };
}
/** A directory this namespace makes (above a mount point, or a backend root with no stat). */
const EPOCH_STAT = { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40755, uid: 0, gid: 0 };
/** Where the namespace's own device numbers for mounts start (see Mount.dev). */
const ANONYMOUS_DEV = 0x10000;
/** Whether `error` is a synchronous caller's refusal by an asynchronous mount (one that can await may retry on the async face). */
export function isAsyncMountRefusal(error) {
    return typeof error === 'object' && error !== null && error.asyncMount === true;
}
const ROOT_POINT = '/';
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;
/** An absolute path's first component when it is spelled plainly (not empty, `.` or `..`). */
function firstComponent(path) {
    if (path.charCodeAt(0) !== 47)
        return undefined;
    const end = path.indexOf('/', 1);
    const first = end === -1 ? path.slice(1) : path.slice(1, end);
    return first === '' || first === '.' || first === '..' ? undefined : first;
}
/** `/a/b`, from any spelling; `..` stops at the root. */
export function normalizePath(path) {
    const out = [];
    for (const segment of String(path).split('/')) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..')
            out.pop();
        else
            out.push(segment);
    }
    return `/${out.join('/')}`;
}
function parentOf(path) {
    const cut = path.lastIndexOf('/');
    return cut <= 0 ? '/' : path.slice(0, cut);
}
function isPromise(value) {
    return typeof value?.then === 'function';
}
/** Apply `next` to a value that may or may not be a promise, staying synchronous when it is not. */
function then(value, next) {
    return isPromise(value) ? value.then(next) : next(value);
}
/**
 * A refusal the namespace makes while it resolves or routes a path, before
 * it knows which call it refuses. The call that met it reports it
 * (`reported`), as Node reports a failed syscall. `detail` is the reason
 * where the namespace knows more than the code says.
 */
class Refusal extends VfsError {
    detail;
    constructor(code, path, detail) {
        super(code, detail ?? VFS_DESCRIPTION[code], path);
        this.detail = detail;
    }
}
/** `run`, a refusal it meets reported as Node's error for `call`: `ENOENT: no such file or directory, open '/x'`. */
function reported(call, run) {
    const report = (error) => {
        if (!(error instanceof Refusal))
            throw error;
        const out = syscallError(error.code, call.syscall, call.path, { detail: error.detail, dest: call.dest, cause: error });
        throw isAsyncMountRefusal(error) ? Object.assign(out, { asyncMount: true }) : out;
    };
    try {
        const out = run();
        return isPromise(out) ? out.catch(report) : out;
    }
    catch (error) {
        return report(error);
    }
}
function principalKey(principal) {
    const { cred, actor } = principal;
    const id = cred === null ? '-' : `${cred.uid}:${cred.gid}:${[...cred.groups].join(',')}:${cred.umask}`;
    return actor === undefined ? id : `${id}@${actor}`;
}
export class CompositeVFS {
    table;
    /** The last st_dev a mount was given. */
    nextDev = 0;
    viewer;
    /** Backends seen as this view's principal (a backend's `as` view is made once per view). */
    viewed = new WeakMap();
    /**
     * Views per principal, held weakly: one per principal while someone holds
     * it, none once no one does (a table serving thousands of agents does not
     * keep a view per agent for its life).
     */
    views;
    syncView;
    constructor(root, options = {}, shared) {
        if (shared) {
            this.table = shared.table;
            this.viewer = shared.principal;
            this.views = shared.views;
        }
        else {
            this.table = { mounts: new Map([[ROOT_POINT, { point: ROOT_POINT, source: root, options, dev: null, inos: new Map() }]]), synthesized: new Map() };
            this.viewer = { cred: null };
            const refs = new Map();
            this.views = { refs, gone: new FinalizationRegistry((key) => {
                    if (refs.get(key)?.deref() === undefined)
                        refs.delete(key);
                }) };
        }
        this.syncView = this.makeSync();
    }
    // ── the feed ───────────────────────────────────────────────────────────
    /** This principal's namespace feed. */
    get feed() {
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
    feedSignature() {
        const parts = [];
        for (const mount of this.table.mounts.values()) {
            const found = typeof mount.source === 'function' ? mount.source(this.viewer) : mount.source;
            const live = mount.point === ROOT_POINT || this.live(mount);
            const files = live ? this.backend(mount) : null;
            parts.push(`${mount.point}\u0000${live ? 1 : 0}\u0000${files?.changes ? 1 : 0}\u0000${sourceId(found)}`);
        }
        return parts.join('\u0001');
    }
    /** Live mounts with their backend's feed (none: only the point is staged). */
    feedSources() {
        const out = [];
        for (const mount of this.table.mounts.values()) {
            if (mount.point !== ROOT_POINT && !this.live(mount))
                continue;
            const files = this.backend(mount);
            if (files !== null)
                out.push({ mount, changes: files.changes });
        }
        return out;
    }
    feedPosition(table, sources) {
        const feeds = {};
        for (const { mount, changes } of sources) {
            if (changes)
                feeds[mount.point] = { epoch: changes.epoch, cursor: changes.revision() };
        }
        return { table, feeds };
    }
    static reroot(point, path) {
        if (point === ROOT_POINT)
            return path;
        return path === '/' ? point : point + path;
    }
    /** Whether the namespace shows `path` from `mount`: routed there, not covered, reachable. */
    feedShows(path, mount) {
        if (this.route(path).mount !== mount || this.absentOn(path) !== null)
            return false;
        return !this.isStructural(path) || this.table.mounts.get(path) === mount;
    }
    feedSince(position, options) {
        const table = this.feedSignature();
        const sources = this.feedSources();
        const poison = () => ({ position: this.feedPosition(table, sources), poison: true, paths: [] });
        if (position.table !== table)
            return poison();
        const feeds = {};
        const paths = [];
        for (const { mount, changes } of sources) {
            if (!changes)
                continue;
            const held = position.feeds[mount.point];
            if (held === undefined)
                return poison();
            const delta = changes.since(held.epoch, held.cursor, options);
            if (delta.poison)
                return poison();
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
     * namespace makes (mount points and their ancestors) and with `walked`
     * (the names a walk of the mounts without a feed found, which stand for
     * those mounts). A mount without a feed shows only its point otherwise.
     * Take `position()` before the first page.
     */
    feedList(after, limit, walked = []) {
        const want = Math.max(1, limit);
        const past = (path) => after === null || comparePaths(path, after) > 0;
        const streams = [];
        const walkedPaths = new Set(walked.map((entry) => entry.path));
        const made = [];
        for (const point of [...this.table.mounts.keys(), ...this.table.synthesized.keys()]) {
            if (point === ROOT_POINT || !this.isStructural(point) || !past(point) || walkedPaths.has(point))
                continue;
            if (made.some((entry) => entry.path === point))
                continue;
            made.push({ path: point, kind: 'directory', size: 0, rev: 0, stat: this.madeStat(point) });
        }
        streams.push({ entries: made, more: false });
        streams.push({ entries: walked.filter((entry) => past(entry.path)), more: false });
        for (const { mount, changes } of this.feedSources()) {
            if (!changes)
                continue;
            const point = mount.point;
            let from;
            if (point === ROOT_POINT || after === null || comparePaths(after, `${point}/`) < 0)
                from = point === ROOT_POINT ? after : null;
            else if (after.startsWith(`${point}/`))
                from = after.slice(point.length);
            else
                continue;
            const entries = [];
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
        let merged = [];
        for (const stream of streams)
            merged = mergeByPath(merged, inPathOrder(stream.entries), want + 1);
        const entries = merged.slice(0, want);
        const more = merged.length > want || streams.some((stream) => stream.more);
        return { entries, next: more && entries.length > 0 ? entries[entries.length - 1].path : null };
    }
    /**
     * A directory the namespace makes, as a listing entry: its stat as `stat`
     * answers it (the mounted root's own, or the directory the backend beneath
     * holds there), where that can be answered without waiting.
     */
    madeStat(point) {
        try {
            const stat = this.statAt(point, false, true);
            if (stat === null || isPromise(stat) || stat.type !== 'directory')
                return SYNTH_RUNTIME_STAT;
            return runtimeStatOf(stat);
        }
        catch {
            return SYNTH_RUNTIME_STAT;
        }
    }
    /** The mounts without a feed that this principal reaches: a point under a directory it cannot search is left out, as a listing leaves out a name there. */
    async unfedPoints() {
        const reached = new Map();
        await Promise.all([...this.table.mounts.values()].map(async (mount) => {
            if (mount.point === ROOT_POINT || !this.live(mount) || this.backend(mount)?.changes !== undefined)
                return;
            const stat = await (async () => this.statAt(mount.point, true, false))().catch(() => null);
            if (stat !== null && stat.type === 'directory')
                reached.set(mount.point, stat);
        }));
        return reached;
    }
    /** CompositeFeed.walk. */
    async walkUnfed(named, limit) {
        const found = new Map();
        const stats = new Map();
        const put = (path, stat, linkTarget) => {
            stats.set(path, stat);
            found.set(path, {
                path, kind: stat.type, size: stat.size, rev: 0, stat: runtimeStatOf(stat),
                ...(linkTarget === undefined ? {} : { linkTarget }),
            });
        };
        const points = await this.unfedPoints();
        for (const [point, stat] of points)
            put(point, stat);
        // Where the names lead: each one's directory and those above it, down
        // from its mount point; a name the listings show as a directory, whole.
        const levels = new Set();
        const wanted = new Set();
        for (const name of named) {
            const path = normalizePath(name);
            const point = this.route(path).mount.point;
            if (!points.has(point))
                continue;
            wanted.add(path);
            if (path === point)
                continue;
            for (let dir = parentOf(path);; dir = parentOf(dir)) {
                levels.add(dir);
                if (dir === point)
                    break;
            }
        }
        let room = limit;
        const listed = new Set();
        const tried = new Set();
        /** One directory, whole, when this principal may search it and its names fit: its child directories. */
        const list = async (dir) => {
            if (tried.has(dir))
                return [];
            tried.add(dir);
            const held = stats.get(dir);
            if (room <= 0 || held === undefined || held.type !== 'directory' || !this.permits(held, 1))
                return [];
            let entries;
            try {
                entries = await this.statEntries(dir);
            }
            catch {
                return [];
            }
            const fresh = entries.filter(({ name }) => !found.has(`${dir}/${name}`));
            if (fresh.length > room)
                return [];
            room -= fresh.length;
            const links = fresh.filter(({ stat }) => stat.type === 'symlink');
            for (const { name, stat } of fresh)
                if (stat.type !== 'symlink')
                    put(`${dir}/${name}`, stat);
            for (let i = 0; i < links.length; i += WALK_CONCURRENCY) {
                await Promise.all(links.slice(i, i + WALK_CONCURRENCY).map(async ({ name, stat }) => {
                    const target = await this.readlink(`${dir}/${name}`).catch(() => null);
                    if (target !== null)
                        put(`${dir}/${name}`, stat, target);
                }));
            }
            listed.add(dir);
            return entries.filter(({ stat }) => stat.type === 'directory').map(({ name }) => `${dir}/${name}`);
        };
        // Top down, a depth at a time: each directory is named by its parent's listing before its own.
        const depth = (path) => path.split('/').length;
        const ordered = [...levels].sort((a, b) => depth(a) - depth(b) || comparePaths(a, b));
        for (let i = 0; i < ordered.length;) {
            const batch = [ordered[i++]];
            while (i < ordered.length && batch.length < WALK_CONCURRENCY && depth(ordered[i]) === depth(batch[0]))
                batch.push(ordered[i++]);
            await Promise.all(batch.map(list));
        }
        const queue = [...wanted].filter((path) => found.get(path)?.kind === 'directory').sort(comparePaths);
        while (queue.length > 0 && room > 0) {
            for (const dirs of await Promise.all(queue.splice(0, WALK_CONCURRENCY).map(list)))
                queue.push(...dirs);
        }
        for (const entry of found.values()) {
            if (entry.kind === 'directory' && !listed.has(entry.path))
                entry.unlisted = this.route(entry.path).mount.point;
        }
        return [...found.values()].sort((a, b) => comparePaths(a.path, b.path));
    }
    // ── the table ──────────────────────────────────────────────────────────
    mount(point, source, options = {}) {
        const at = normalizePath(point);
        if (at === ROOT_POINT)
            throw syscallError('EBUSY', 'mount', point, { detail: 'the root is mounted at construction' });
        if (this.table.mounts.has(at))
            throw syscallError('EBUSY', 'mount', point, { detail: 'something is already mounted there' });
        this.table.mounts.set(at, { point: at, source, options, dev: ANONYMOUS_DEV + ++this.nextDev, inos: new Map() });
        this.resynthesize();
    }
    unmount(point) {
        const at = normalizePath(point);
        if (at === ROOT_POINT || !this.table.mounts.delete(at))
            throw syscallError('EINVAL', 'umount', point, { detail: 'nothing is mounted there' });
        this.resynthesize();
    }
    /** The mounts this view's principal has now, root first, in mount order. */
    mounts() {
        const out = [];
        for (const mount of this.table.mounts.values()) {
            const files = this.backend(mount);
            if (files === null)
                continue;
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
    mountOf(path) {
        return this.route(normalizePath(path)).mount.point;
    }
    /**
     * Whether the namespace answers `path` itself rather than the root
     * backend alone: a path on another mount, a directory above a mount point
     * (whose listing includes the mount's name), or a path under such a
     * directory that the root holds none of (absent there, whatever the root
     * holds through a link or file higher up).
     */
    composes(path) {
        // A path whose first component is no mount point's first component is
        // the root backend's alone: no mount, and no directory above one, is on
        // it or above it. Only a spelling that `..` could move is normalized.
        const first = firstComponent(path);
        if (first !== undefined && !path.includes('/..') && this.table.synthesized.get(ROOT_POINT)?.has(first) !== true)
            return false;
        const at = normalizePath(path);
        if (this.route(at).mount.point !== ROOT_POINT)
            return true;
        if (at === ROOT_POINT)
            return false;
        if (this.isStructural(at))
            return true;
        for (let dir = at.slice(0, at.lastIndexOf('/')); dir !== ''; dir = dir.slice(0, dir.lastIndexOf('/'))) {
            if (!this.isStructural(dir))
                continue;
            const held = this.heldDirectory(dir, true);
            return !isPromise(held) && held === null;
        }
        return false;
    }
    /** The path with every link resolved, as this principal sees the namespace (ENOENT when absent). */
    realpath(path) {
        return reported({ syscall: 'realpath', path }, () => {
            const resolved = this.resolve(path, true, true);
            if (this.statAt(resolved, false, true) === null)
                throw new Refusal('ENOENT', path);
            return resolved;
        });
    }
    /** `realpath` for a caller that can wait: links on an asynchronous mount are awaited. */
    async realpathAsync(path) {
        return reported({ syscall: 'realpath', path }, async () => {
            const resolved = await this.resolve(path, true, false);
            if ((await this.statAt(resolved, false, false)) === null)
                throw new Refusal('ENOENT', path);
            return resolved;
        });
    }
    /** The same table as `cred` (and `actor`): sources are resolved for that principal. */
    as(cred, actor) {
        const principal = actor === undefined ? { cred } : { cred, actor };
        const key = principalKey(principal);
        let view = this.views.refs.get(key)?.deref();
        if (view === undefined) {
            view = new CompositeVFS(this.table.mounts.get(ROOT_POINT).source, undefined, {
                table: this.table, principal, views: this.views,
            });
            this.views.refs.set(key, new WeakRef(view));
            this.views.gone.register(view, key);
        }
        return view;
    }
    /** Who this view acts as. */
    get principal() {
        return this.viewer;
    }
    get sync() {
        return this.syncView;
    }
    resynthesize() {
        this.table.synthesized.clear();
        for (const point of this.table.mounts.keys()) {
            if (point === ROOT_POINT)
                continue;
            let child = point;
            while (child !== ROOT_POINT) {
                const dir = parentOf(child);
                let names = this.table.synthesized.get(dir);
                if (!names)
                    this.table.synthesized.set(dir, names = new Set());
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
    /** Whether the backend `path` routes to can write a range in place (a descriptor needs no buffer). */
    writesInPlace(path) {
        const route = this.route(normalizePath(path));
        try {
            return typeof this.ops(route, true).writeRange === 'function';
        }
        catch {
            return false;
        }
    }
    route(path) {
        for (let at = path;; at = parentOf(at)) {
            const mount = this.table.mounts.get(at);
            if (mount !== undefined) {
                return { mount, path, rel: at === ROOT_POINT ? path : path.length === at.length ? '/' : path.slice(at.length) };
            }
            if (at === ROOT_POINT)
                throw new Error('the root mount is missing');
        }
    }
    backend(mount) {
        const found = typeof mount.source === 'function' ? mount.source(this.viewer) : mount.source;
        if (found === null || found === undefined)
            return null;
        const cred = this.viewer.cred;
        if (cred === null || found.as === undefined)
            return found;
        let view = this.viewed.get(found);
        if (view === undefined)
            this.viewed.set(found, view = found.as(cred));
        return view;
    }
    /** The shortest mount on `path` whose source answers null for this view (rule 1), or null. */
    absentOn(path) {
        let found = null;
        for (const mount of this.table.mounts.values()) {
            if (mount.point === ROOT_POINT)
                continue;
            if (path !== mount.point && !path.startsWith(`${mount.point}/`))
                continue;
            if (found !== null && found.point.length <= mount.point.length)
                continue;
            if (this.backend(mount) === null)
                found = mount;
        }
        return found;
    }
    absent(mount, path) {
        const reason = mount.options.absentReason?.(this.viewer) ?? 'nothing is mounted there now';
        return new Refusal('ENXIO', path, `${mount.point} — ${reason}`);
    }
    /** ENXIO when `path` is absent for this view. */
    present(path) {
        const gone = this.absentOn(path);
        if (gone !== null)
            throw this.absent(gone, path);
    }
    /** Whether `point` is a mount this view reaches (rule 1). */
    live(mount) {
        return this.absentOn(mount.point) === null;
    }
    /** The operations the backend at `route` offers, synchronous or not. */
    ops(route, sync) {
        const files = this.backend(route.mount);
        if (files === null)
            throw this.absent(route.mount, route.path);
        if (!sync)
            return files;
        if (files.sync === undefined) {
            throw Object.assign(new Refusal('EAGAIN', route.path, `${route.mount.point} is an asynchronous mount; this caller cannot wait for it`), { asyncMount: true });
        }
        return files.sync;
    }
    /** The root, a live mount point, or a directory above one (rule 2): this namespace's, not a backend's. */
    isStructural(path) {
        if (path === ROOT_POINT)
            return true;
        const mount = this.table.mounts.get(path);
        if (mount !== undefined)
            return this.live(mount);
        return this.table.synthesized.has(path) && this.hasLiveBelow(path);
    }
    hasLiveBelow(dir) {
        const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
        for (const mount of this.table.mounts.values()) {
            if (mount.point !== ROOT_POINT && mount.point.startsWith(prefix) && this.live(mount))
                return true;
        }
        return false;
    }
    /**
     * A capability the backend may lack, asked after lookup (Linux order): a
     * path that is not there is ENOENT, and ENOTSUP is for a path that exists
     * on a backend without the capability. (FormalModelsLane
     * `Vfs/CompositeOps`, unsupported_is_enotsup.)
     */
    capability(ops, name, rel, path, run) {
        return then(this.softStat(ops, rel, true), (stat) => {
            if (stat === null)
                throw new Refusal('ENOENT', path);
            const fn = ops[name];
            if (typeof fn !== 'function')
                throw new Refusal('ENOTSUP', path, `this filesystem does not support ${String(name)}`);
            return run(fn.bind(ops));
        });
    }
    /**
     * readRange and the revision ops: `/` and a mount point are EISDIR;
     * anything else is the backend's, looked up before its capability is asked.
     */
    onCapability(input, sync, name, write, run) {
        return then(this.resolve(input, true, sync), (path) => {
            this.present(path);
            if (this.isStructural(path)) {
                throw new Refusal('EISDIR', path);
            }
            const route = this.route(path);
            if (write && route.mount.options.readOnly)
                throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
            return then(this.reachable(path, sync), () => this.capability(this.ops(route, sync), name, route.rel, path, (fn) => run(fn, route.rel)));
        });
    }
    method(ops, name, path) {
        const fn = ops[name];
        if (typeof fn !== 'function')
            throw new Refusal('ENOTSUP', path, `this filesystem does not support ${String(name)}`);
        return fn.bind(ops);
    }
    /**
     * `input` with every root link on it followed (the last only when
     * `follow`), normalized in this namespace. A mount point or a directory
     * above one is never a link (rule 2); a component inside a mount is left to
     * that backend. ELOOP past MAX_LINK_HOPS.
     */
    /** `creating`: absent non-final components are allowed (mkdir -p makes them); a file among them is still ENOTDIR. */
    resolve(input, follow, sync, creating = false) {
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
        const walk = (components, hops) => {
            const resolved = [];
            const lastIndex = components.length - 1;
            // Set after a structural directory its holder does not hold as a
            // directory: its other children are absent (they would be under a file).
            let shadowParent = false;
            const step = (i) => {
                for (; i < components.length; i++) {
                    const component = components[i];
                    if (component === '' || component === '.')
                        continue;
                    if (component === '..') {
                        resolved.pop();
                        continue;
                    }
                    resolved.push(component);
                    const prefix = `/${resolved.join('/')}`;
                    const final = i === lastIndex;
                    const at = i;
                    if (this.isStructural(prefix)) {
                        // Lookup through a mount point, or a directory above one, needs
                        // search permission on what is there, as on Linux: the mounted
                        // root, or the directory a backend holds at that path.
                        shadowParent = false;
                        if (final)
                            continue;
                        const mount = this.table.mounts.get(prefix);
                        return then(mount === undefined ? this.heldDirectory(prefix, sync) : this.mountRoot(mount, prefix, sync), (held) => {
                            if (held !== null && !this.permits(held, 1))
                                throw new Refusal('EACCES', input);
                            shadowParent = mount === undefined && held === null;
                            return step(at + 1);
                        });
                    }
                    if (shadowParent) {
                        shadowParent = false;
                        if (!final)
                            throw new Refusal('ENOENT', input);
                        continue;
                    }
                    if (this.absentOn(prefix) !== null)
                        continue;
                    const route = this.route(prefix);
                    if (final && !follow)
                        continue;
                    const ops = this.ops(route, sync);
                    const canLink = typeof ops.readlink === 'function';
                    const look = () => {
                        try {
                            const out = ops.stat(route.rel, { follow: !canLink });
                            return isPromise(out) ? out.catch((e) => this.walkMiss(e, prefix)) : out;
                        }
                        catch (e) {
                            return this.walkMiss(e, prefix);
                        }
                    };
                    return then(look(), (stat) => {
                        if (stat !== null && stat.type === 'symlink' && canLink) {
                            if (hops >= MAX_LINK_HOPS)
                                throw new Refusal('ELOOP', input);
                            return then(ops.readlink(route.rel), (target) => walk([
                                ...(target.startsWith('/') ? [] : resolved.slice(0, -1)),
                                ...target.split('/'),
                                ...components.slice(at + 1),
                            ], hops + 1));
                        }
                        if (!final) {
                            if (stat === null) {
                                if (creating)
                                    return step(at + 1);
                                throw new Refusal('ENOENT', input);
                            }
                            if (stat.type !== 'directory')
                                throw new Refusal('ENOTDIR', input);
                            if (!this.permits(stat, 1))
                                throw new Refusal('EACCES', input);
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
     */
    heldDirectory(path, sync) {
        const route = this.route(path);
        const parent = path.slice(0, path.lastIndexOf('/')) || ROOT_POINT;
        const own = () => {
            const held = (stat) => (stat !== null && stat.type === 'directory' ? stat : null);
            // A file above it (ENOTDIR) or no stat at all (ENOTSUP): the backend holds no directory there.
            const unsupported = (error) => { if (isVfsError(error, 'ENOTSUP') || isVfsError(error, 'ENOTDIR'))
                return null; throw error; };
            try {
                const out = this.softStat(this.ops(route, sync), route.rel, false);
                return isPromise(out) ? out.then(held, unsupported) : held(out);
            }
            catch (error) {
                return unsupported(error);
            }
        };
        if (parent === route.mount.point)
            return own();
        return then(this.heldDirectory(parent, sync), (above) => (above === null ? null : own()));
    }
    /** A mounted backend's root, or null when it cannot stat it. */
    mountRoot(mount, point, sync) {
        const ops = this.ops({ mount, path: point, rel: '/' }, sync);
        try {
            const out = ops.stat('/', { follow: true });
            return isPromise(out) ? out.catch(() => null) : out;
        }
        catch {
            return null;
        }
    }
    /** Whether this view's principal has `want` (r=4, w=2, x=1) on a stat, by its mode bits. */
    permits(stat, want) {
        const cred = this.viewer.cred;
        if (cred === null || cred.uid === 0 || stat.mode === undefined)
            return true;
        const mode = stat.mode;
        const bits = cred.uid === stat.uid
            ? (mode >> 6) & 7
            : cred.gid === stat.gid || (cred.groups ?? []).includes(stat.gid ?? -1) ? (mode >> 3) & 7 : mode & 7;
        return (bits & want) === want;
    }
    /** A stat that failed during the walk: absent (ENOENT) reads as nothing there; other errors stand. */
    walkMiss(error, _path) {
        if (isVfsError(error, 'ENOENT'))
            return null;
        if (isVfsError(error, 'ENOTDIR'))
            return { type: 'file', size: 0, mtimeMs: 0 };
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
    shadowed(path, sync) {
        if (this.isStructural(path))
            return false;
        // Only directories the path's own backend serves: one above the path's
        // mount point belongs to another filesystem, which the mount covers.
        const point = this.route(path).mount.point;
        for (let at = parentOf(path); at !== ROOT_POINT && at !== point && at.length > point.length; at = parentOf(at)) {
            if (this.isStructural(at) && !this.table.mounts.has(at)) {
                // heldDirectory checks every directory above it in turn.
                return then(this.heldDirectory(at, sync), (held) => held === null);
            }
        }
        return false;
    }
    /** ENOENT when `path` is shadowed. */
    reachable(path, sync) {
        return then(this.shadowed(path, sync), (hidden) => {
            if (hidden)
                throw new Refusal('ENOENT', path);
        });
    }
    /**
     * The names the namespace itself puts in `dir` (mount points and the
     * directories above them), as directory entries, whatever `dir`'s own
     * backend holds.
     */
    mountedNames(dir) {
        const names = this.table.synthesized.get(normalizePath(dir));
        return names === undefined ? [] : [...names].map((name) => ({ name, type: 'directory' }));
    }
    /**
     * An entry's identity in the namespace: st_dev is its mount's (the root
     * keeps its backend's), and a backend that numbers no inodes gets numbers
     * here, per path, stable while it stays mounted.
     */
    identify(path, stat) {
        if (stat === null)
            return null;
        const mount = this.table.mounts.get(path) ?? this.route(path).mount;
        const dev = mount.dev ?? stat.dev ?? 0;
        let ino = stat.ino;
        if (ino === undefined || ino === 0) {
            ino = mount.inos.get(path);
            if (ino === undefined)
                mount.inos.set(path, ino = mount.inos.size + 1);
        }
        return stat.dev === dev && stat.ino === ino ? stat : { ...stat, dev, ino };
    }
    statAt(input, follow, sync) {
        // Nothing at a component on the way is "not there" too: stat answers null.
        const walked = () => {
            const absent = (e) => { if (isVfsError(e, 'ENOENT'))
                return null; throw e; };
            try {
                const out = this.resolve(input, follow, sync);
                return isPromise(out) ? out.catch(absent) : out;
            }
            catch (e) {
                return absent(e);
            }
        };
        return then(walked(), (path) => (path === null ? null : then(this.statResolved(path, follow, sync), (stat) => this.identify(path, stat))));
    }
    /** The stat of a resolved namespace path, before its identity is stamped. */
    statResolved(path, follow, sync) {
        if (this.absentOn(path) !== null)
            return null;
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
                    if (held === null)
                        return EPOCH_STAT;
                    return held.mode === undefined ? { ...held, mode: EPOCH_STAT.mode, uid: 0, gid: 0 } : held;
                });
            }
            const ops = this.ops({ mount, path, rel: '/' }, sync);
            const own = () => {
                try {
                    const out = ops.stat('/', { follow: true });
                    return isPromise(out) ? out.catch(() => null) : out;
                }
                catch {
                    return null;
                }
            };
            return then(own(), (stat) => {
                if (stat === null || stat.type !== 'directory')
                    return EPOCH_STAT;
                // A backend with no modes has the namespace's own at its mount point.
                return stat.mode === undefined ? { ...stat, mode: EPOCH_STAT.mode, uid: 0, gid: 0 } : stat;
            });
        }
        return then(this.shadowed(path, sync), (hidden) => {
            if (hidden)
                return null;
            const route = this.route(path);
            return this.softStat(this.ops(route, sync), route.rel, follow);
        });
    }
    /** stat, with ENOENT/ENOTDIR from the backend read as "not there". */
    softStat(ops, rel, follow) {
        try {
            const out = ops.stat(rel, { follow });
            return isPromise(out) ? out.catch((e) => this.absentOrThrow(e)) : out;
        }
        catch (e) {
            return this.absentOrThrow(e);
        }
    }
    absentOrThrow(error) {
        if (isVfsError(error, 'ENOENT'))
            return null;
        throw error;
    }
    /** Mount points (and directories above live ones) directly in `dir` that this view reaches. */
    liveNamesIn(dir) {
        const names = this.table.synthesized.get(dir);
        if (!names)
            return [];
        const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
        return [...names].filter((name) => this.isStructural(prefix + name));
    }
    readdirAt(input, sync) {
        return then(this.resolve(input, true, sync), (path) => this.readdirOf(path, sync));
    }
    /** readdir of a path already resolved in this namespace. */
    readdirOf(path, sync) {
        this.present(path);
        const prefix = path === ROOT_POINT ? '/' : `${path}/`;
        const extra = this.liveNamesIn(path);
        const finish = (entries) => {
            // A mount point covers whatever its parent holds under that name, and
            // a name absent for this view is not listed (rule 1).
            const merged = entries.filter((entry) => !extra.includes(entry.name) && this.absentOn(prefix + entry.name) === null);
            for (const name of extra)
                merged.push({ name, type: 'directory' });
            return merged;
        };
        if (this.isStructural(path) && this.table.mounts.get(path) === undefined) {
            // A directory above a live mount: the backend's own entries if it
            // holds a directory there, else only the mount points.
            const route = this.route(path);
            const listed = () => then(this.heldDirectory(path, sync), (held) => {
                if (held === null)
                    return [];
                try {
                    const out = this.ops(route, sync).readdir(route.rel);
                    return isPromise(out) ? out.catch((e) => this.emptyIfMissing(e)) : out;
                }
                catch (e) {
                    return this.emptyIfMissing(e);
                }
            });
            return then(this.reachable(path, sync), () => then(listed(), finish));
        }
        const route = this.route(path);
        const ops = this.ops(route, sync);
        // opendir(O_DIRECTORY) answers ENOTDIR before a permission check.
        const notDirectoryFirst = (error) => {
            if (!isVfsError(error, 'EACCES'))
                throw error;
            return then(this.softStat(ops, route.rel, true), (stat) => {
                if (stat !== null && stat.type !== 'directory')
                    throw new Refusal('ENOTDIR', path);
                throw error;
            });
        };
        const listed = () => {
            try {
                const out = ops.readdir(route.rel);
                return isPromise(out) ? out.catch(notDirectoryFirst) : out;
            }
            catch (error) {
                return notDirectoryFirst(error);
            }
        };
        return then(this.reachable(path, sync), () => then(listed(), finish));
    }
    emptyIfMissing(error) {
        if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR'))
            return [];
        throw error;
    }
    onFile(input, follow, sync, run) {
        return then(this.resolve(input, follow, sync), (path) => {
            this.present(path);
            if (this.isStructural(path)) {
                // open(2) checks read permission before a read answers EISDIR.
                return then(this.statAt(path, true, sync), (stat) => {
                    if (stat !== null && !this.permits(stat, 4))
                        throw new Refusal('EACCES', path);
                    throw new Refusal('EISDIR', path);
                });
            }
            const route = this.route(path);
            return then(this.reachable(path, sync), () => run(this.ops(route, sync), route.rel, path));
        });
    }
    onMutation(input, follow, sync, what, run) {
        return then(this.resolve(input, follow, sync), (path) => {
            this.present(path);
            // unlink(2) refuses a directory before anything else (Linux), and a
            // mount point is one.
            if (what === 'unlinked' && (path === ROOT_POINT || this.isStructural(path))) {
                // may_delete: write and search on the parent, then EISDIR.
                if (path === ROOT_POINT)
                    throw new Refusal('EISDIR', path);
                return then(this.statAt(parentOf(path), true, sync), (parent) => {
                    if (parent !== null && !this.permits(parent, 3))
                        throw new Refusal('EACCES', path);
                    throw new Refusal('EISDIR', path);
                });
            }
            const route = this.route(path);
            // chmod, chown and utimes of a mount point change the mounted root, as
            // on Linux; only a directory above a mount point has no backend to ask.
            const metadataOnly = what === 'changed' && (path === ROOT_POINT || this.table.mounts.get(path) !== undefined);
            if (this.isStructural(path) && !metadataOnly)
                throw new Refusal('EBUSY', path, `a mount point cannot be ${what}`);
            if (route.mount.options.readOnly)
                throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
            return then(this.reachable(path, sync), () => run(this.ops(route, sync), route.rel, path));
        });
    }
    mkdirAt(input, options, sync) {
        return then(this.resolve(input, false, sync, options?.recursive === true), (path) => {
            this.present(path);
            if (this.isStructural(path)) {
                // mkdir -p of a live mount point (or a directory above one) has nothing to do.
                if (options?.recursive)
                    return undefined;
                throw new Refusal('EBUSY', path, 'a mount point cannot be created');
            }
            const route = this.route(path);
            if (route.mount.options.readOnly)
                throw new Refusal('EROFS', path, `${route.mount.point} is mounted read-only`);
            if (!options?.recursive) {
                return then(this.reachable(path, sync), () => this.ops(route, sync).mkdir(route.rel, options));
            }
            // -p across mounts: each missing component in the filesystem it lives on.
            const parts = path.slice(1).split('/');
            const make = (i) => {
                if (i > parts.length)
                    return undefined;
                const at = `/${parts.slice(0, i).join('/')}`;
                if (this.isStructural(at))
                    return make(i + 1);
                const r = this.route(at);
                if (i === 1 || this.isStructural(`/${parts.slice(0, i - 1).join('/')}`)) {
                    return then(this.reachable(at, sync), () => step(r, at, i));
                }
                return step(r, at, i);
            };
            const step = (r, at, i) => {
                const ops = this.ops(r, sync);
                return then(this.softStat(ops, r.rel, true), (stat) => {
                    if (stat !== null) {
                        if (stat.type !== 'directory') {
                            throw new Refusal(i === parts.length ? 'EEXIST' : 'ENOTDIR', at);
                        }
                        return make(i + 1);
                    }
                    return then(ops.mkdir(r.rel, { mode: options.mode }), () => make(i + 1));
                });
            };
            return make(1);
        });
    }
    renameAt(fromInput, toInput, sync) {
        return then(this.resolve(fromInput, false, sync), (from) => then(this.resolve(toInput, false, sync), (to) => {
            this.present(from);
            this.present(to);
            const source = this.route(from);
            const target = this.route(to);
            if (this.isStructural(from))
                throw new Refusal('EBUSY', from, 'a mount point cannot be renamed');
            if (this.isStructural(to))
                throw new Refusal('EBUSY', to, 'a mount point cannot be replaced');
            if (source.mount !== target.mount) {
                throw new Refusal('EXDEV', from, `${source.mount.point} and ${target.mount.point} are different filesystems`);
            }
            if (source.mount.options.readOnly)
                throw new Refusal('EROFS', from, `${source.mount.point} is mounted read-only`);
            return then(this.reachable(from, sync), () => then(this.reachable(to, sync), () => this.renameIn(source, target, from, sync)));
        }));
    }
    renameIn(source, target, from, sync) {
        const ops = this.ops(source, sync);
        // A backend with no rename cannot move a name in place; EXDEV tells mv
        // to copy. A source that is not there is ENOENT first, as rename(2) says.
        if (typeof ops.rename !== 'function') {
            return then(this.softStat(ops, source.rel, false), (stat) => {
                if (stat === null)
                    throw new Refusal('ENOENT', from);
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
    copyAt(fromInput, toInput, options, sync) {
        return then(this.resolve(fromInput, false, sync), (from) => {
            this.present(from);
            return then(this.resolve(toInput, false, sync), (to) => {
                this.present(to);
                const fromMount = this.table.mounts.get(from);
                if (from === ROOT_POINT || (this.isStructural(from) && fromMount === undefined) || (fromMount === undefined && this.hasLiveBelow(from))) {
                    throw new Refusal('ENOTSUP', from, 'a tree holding another filesystem is copied by cp -r, not by this primitive');
                }
                if (to === ROOT_POINT || this.isStructural(to))
                    throw new Refusal('EBUSY', to, 'a mount point cannot be replaced');
                const source = this.route(from);
                const target = this.route(to);
                if (target.mount.options.readOnly)
                    throw new Refusal('EROFS', to, `${target.mount.point} is mounted read-only`);
                const sourceOps = this.ops(source, sync);
                return then(this.statAt(from, false, sync), (stat) => {
                    if (stat === null)
                        throw new Refusal('ENOENT', from);
                    const dir = stat.type === 'directory';
                    if (dir && !options?.recursive)
                        throw new Refusal('EISDIR', from, 'a tree needs recursive');
                    return then(this.statAt(parentOf(to), true, sync), (parent) => {
                        if (parent === null)
                            throw new Refusal('ENOENT', to);
                        if (parent.type !== 'directory')
                            throw new Refusal('ENOTDIR', to);
                        if (dir && (to === from || to.startsWith(`${from}/`)))
                            throw new Refusal('EINVAL', to, 'a tree cannot be copied into itself');
                        return then(this.statAt(to, false, sync), (existing) => {
                            if (existing !== null) {
                                if (dir)
                                    throw new Refusal('EEXIST', to);
                                if (existing.type === 'directory')
                                    throw new Refusal('EISDIR', to);
                            }
                            if (source.mount === target.mount && typeof sourceOps.copy === 'function') {
                                return sourceOps.copy(source.rel, target.rel, options);
                            }
                            return this.copyBytes(sourceOps, source.rel, stat, this.ops(target, sync), target.rel);
                        });
                    });
                });
            });
        });
    }
    /** Copy an entry (a tree when it is a directory) between backends, links as links. */
    copyBytes(from, fromRel, stat, to, toRel) {
        const mode = stat.mode === undefined ? undefined : stat.mode & 0o7777;
        if (stat.type === 'symlink') {
            if (typeof from.readlink !== 'function' || typeof to.symlink !== 'function') {
                throw new Refusal('ENOTSUP', toRel, 'a link cannot be copied between these filesystems');
            }
            return then(from.readlink(fromRel), (target) => then(to.symlink(target, toRel), () => 1));
        }
        if (stat.type === 'file') {
            return then(from.readFile(fromRel), (bytes) => then(to.writeFile(toRel, bytes, mode === undefined ? undefined : { mode }), () => 1));
        }
        return then(to.mkdir(toRel, mode === undefined ? undefined : { mode }), () => then(from.readdir(fromRel), (entries) => entries.reduce((count, entry) => then(count, (n) => {
            const child = fromRel === '/' ? `/${entry.name}` : `${fromRel}/${entry.name}`;
            const dest = toRel === '/' ? `/${entry.name}` : `${toRel}/${entry.name}`;
            return then(entry.stat ?? from.stat(child, { follow: false }), (childStat) => (childStat === null
                ? n
                : then(this.copyBytes(from, child, childStat, to, dest), (m) => n + m)));
        }), 1)));
    }
    /** rmdir, or on a backend without it, an emptiness check and unlink. */
    rmdirAt(input, sync) {
        return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
            const backend = ops;
            if (typeof backend.rmdir === 'function')
                return backend.rmdir(rel);
            return then(backend.stat(rel, { follow: false }), (stat) => {
                if (stat === null)
                    throw new Refusal('ENOENT', path);
                if (stat.type !== 'directory')
                    throw new Refusal('ENOTDIR', path);
                return then(backend.readdir(rel), (entries) => {
                    if (entries.length > 0)
                        throw new Refusal('ENOTEMPTY', path);
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
    removeAt(input, sync) {
        return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
            if (this.hasLiveBelow(path))
                throw new Refusal('EBUSY', path, 'something is mounted beneath it');
            const backend = ops;
            if (typeof backend.removeRecursive === 'function') {
                const at = (r) => (r === rel ? path : path + r.slice(rel === '/' ? 0 : rel.length));
                return then(backend.removeRecursive(rel), (report) => (report
                    ? { removed: report.removed.map(at), kept: report.kept.map(at), failures: report.failures.map((f) => ({ ...f, path: at(f.path) })) }
                    : { removed: [path], kept: [], failures: [] }));
            }
            return this.walkRemove(backend, rel, path);
        });
    }
    walkRemove(ops, rel, path) {
        const at = (r) => (r === rel ? path : path + r.slice(rel === '/' ? 0 : rel.length));
        const order = [];
        const visit = (r) => then(ops.stat(r, { follow: false }), (stat) => {
            if (stat === null) {
                if (r === rel)
                    throw new Refusal('ENOENT', path);
                return undefined;
            }
            order.push({ rel: r, dir: stat.type === 'directory' });
            if (stat.type !== 'directory')
                return undefined;
            return then(ops.readdir(r), (entries) => entries.reduce((chain, entry) => then(chain, () => visit(r === '/' ? `/${entry.name}` : `${r}/${entry.name}`)), undefined));
        });
        return then(visit(rel), () => {
            order.reverse();
            const kept = new Set();
            const gone = new Set();
            const failures = [];
            const keepWithAncestors = (r) => {
                for (let k = r;; k = parentOf(k)) {
                    kept.add(k);
                    if (k === rel || k === '/')
                        break;
                }
            };
            return then(order.reduce((chain, entry) => then(chain, () => {
                if (kept.has(entry.rel))
                    return undefined;
                const fail = (cause) => {
                    if (isVfsError(cause, 'ENOENT')) {
                        gone.add(entry.rel);
                        return;
                    }
                    keepWithAncestors(entry.rel);
                    failures.push({
                        path: at(entry.rel),
                        error: isVfsError(cause) ? cause : syscallError('EIO', entry.dir ? 'rmdir' : 'unlink', at(entry.rel), { detail: String(cause) }),
                    });
                };
                try {
                    const out = entry.dir && typeof ops.rmdir === 'function' ? ops.rmdir(entry.rel) : ops.unlink(entry.rel);
                    if (isPromise(out))
                        return out.then(() => { gone.add(entry.rel); }, fail);
                    gone.add(entry.rel);
                    return undefined;
                }
                catch (cause) {
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
    async stat(path, options) {
        return reported({ syscall: options?.follow === false ? 'lstat' : 'stat', path }, () => this.statAt(path, options?.follow !== false, false));
    }
    async readFile(path) {
        return reported({ syscall: 'open', path }, () => this.onFile(path, true, false, (ops, rel) => ops.readFile(rel)));
    }
    async readRange(path, offset, length) {
        return reported({ syscall: 'open', path }, () => this.onCapability(path, false, 'readRange', false, (fn, rel) => fn(rel, offset, length)));
    }
    async writeFile(path, data, options) {
        return reported({ syscall: 'open', path }, () => this.onMutation(path, true, false, 'written', (ops, rel) => ops.writeFile(rel, data, options)));
    }
    async writeRange(path, offset, bytes) {
        return reported({ syscall: 'open', path }, () => this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes)));
    }
    async truncate(path, size) {
        return reported({ syscall: 'open', path }, () => this.onMutation(path, true, false, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)));
    }
    async readdir(path) {
        return reported({ syscall: 'scandir', path }, () => this.readdirAt(path, false));
    }
    /**
     * `readdir` with each entry's own stat (links not followed), identified as
     * `stat` identifies it: the stat the backend's listing carries, else one
     * asked of the backend that holds the name. A name gone between the two
     * is left out.
     */
    async readdirStat(path) {
        return reported({ syscall: 'scandir', path }, async () => this.statEntries(await this.resolve(path, true, false)));
    }
    /**
     * readdirStat of a directory already resolved in this namespace: the
     * directory is looked up once, and each entry's stat (when its listing
     * does not carry one) is one call to the backend that holds it, a few at
     * a time.
     */
    async statEntries(dir) {
        const prefix = dir === ROOT_POINT ? '/' : `${dir}/`;
        const entries = await this.readdirOf(dir, false);
        const out = entries.map(() => null);
        const statOne = async (i) => {
            const entry = entries[i];
            const at = prefix + entry.name;
            let stat = entry.stat ?? null;
            if (stat === null) {
                // A mount point, or a directory above one, is the namespace's.
                if (this.isStructural(at))
                    stat = await this.statAt(at, false, false);
                else {
                    const route = this.route(at);
                    stat = await this.softStat(this.ops(route, false), route.rel, false);
                }
            }
            if (stat !== null)
                out[i] = { name: entry.name, stat: this.identify(at, stat) };
        };
        for (let i = 0; i < entries.length; i += WALK_CONCURRENCY) {
            await Promise.all(entries.slice(i, i + WALK_CONCURRENCY).map((_, j) => statOne(i + j)));
        }
        return out.filter((entry) => entry !== null);
    }
    async mkdir(path, options) {
        return reported({ syscall: 'mkdir', path }, () => this.mkdirAt(path, options, false));
    }
    async unlink(path) {
        return reported({ syscall: 'unlink', path }, () => this.onMutation(path, false, false, 'unlinked', (ops, rel) => ops.unlink(rel)));
    }
    async rmdir(path) {
        return reported({ syscall: 'rmdir', path }, () => this.rmdirAt(path, false));
    }
    async rename(from, to) {
        return reported({ syscall: 'rename', path: from, dest: to }, () => this.renameAt(from, to, false));
    }
    async removeRecursive(path) {
        return reported({ syscall: 'rm', path }, () => this.removeAt(path, false));
    }
    async symlink(target, path) {
        return reported({ syscall: 'symlink', path: target, dest: path }, () => this.onMutation(path, false, false, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)));
    }
    async readlink(path) {
        return reported({ syscall: 'readlink', path }, () => this.onFile(path, false, false, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)));
    }
    async chmod(path, mode) {
        return reported({ syscall: 'chmod', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)));
    }
    async chown(path, uid, gid) {
        return reported({ syscall: 'chown', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)));
    }
    async utimes(path, atimeMs, mtimeMs) {
        return reported({ syscall: 'utime', path }, () => this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, atimeMs, mtimeMs)));
    }
    async writeFileIfRevision(path, data, expected) {
        return reported({ syscall: 'open', path }, () => this.onCapability(path, false, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected)));
    }
    async copy(from, to, options) {
        return reported({ syscall: options?.recursive ? 'cp' : 'copyfile', path: from, dest: to }, () => this.copyAt(from, to, options, false));
    }
    async readFileAtRevision(path, revision, range) {
        return reported({ syscall: 'open', path }, () => this.onCapability(path, false, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range)));
    }
    describe() {
        const root = this.backend(this.table.mounts.get(ROOT_POINT));
        return root?.describe?.() ?? { source: 'none', type: 'composite' };
    }
    makeSync() {
        return {
            stat: (path, options) => reported({ syscall: options?.follow === false ? 'lstat' : 'stat', path }, () => this.statAt(path, options?.follow !== false, true)),
            readFile: (path) => reported({ syscall: 'open', path }, () => this.onFile(path, true, true, (ops, rel) => ops.readFile(rel))),
            readRange: (path, offset, length) => reported({ syscall: 'open', path }, () => this.onCapability(path, true, 'readRange', false, (fn, rel) => fn(rel, offset, length))),
            writeFile: (path, data, options) => reported({ syscall: 'open', path }, () => this.onMutation(path, true, true, 'written', (ops, rel) => ops.writeFile(rel, data, options))),
            writeRange: (path, offset, bytes) => reported({ syscall: 'open', path }, () => this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes))),
            truncate: (path, size) => reported({ syscall: 'open', path }, () => this.onMutation(path, true, true, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size))),
            readdir: (path) => reported({ syscall: 'scandir', path }, () => this.readdirAt(path, true)),
            mkdir: (path, options) => reported({ syscall: 'mkdir', path }, () => this.mkdirAt(path, options, true)),
            unlink: (path) => reported({ syscall: 'unlink', path }, () => this.onMutation(path, false, true, 'unlinked', (ops, rel) => ops.unlink(rel))),
            rmdir: (path) => reported({ syscall: 'rmdir', path }, () => this.rmdirAt(path, true)),
            rename: (from, to) => reported({ syscall: 'rename', path: from, dest: to }, () => this.renameAt(from, to, true)),
            removeRecursive: (path) => { reported({ syscall: 'rm', path }, () => this.removeAt(path, true)); },
            symlink: (target, path) => reported({ syscall: 'symlink', path: target, dest: path }, () => this.onMutation(path, false, true, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel))),
            readlink: (path) => reported({ syscall: 'readlink', path }, () => this.onFile(path, false, true, (ops, rel, at) => this.method(ops, 'readlink', at)(rel))),
            chmod: (path, mode) => reported({ syscall: 'chmod', path }, () => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode))),
            chown: (path, uid, gid) => reported({ syscall: 'chown', path }, () => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid))),
            utimes: (path, a, m) => reported({ syscall: 'utime', path }, () => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, a, m))),
            copy: (from, to, options) => reported({ syscall: options?.recursive ? 'cp' : 'copyfile', path: from, dest: to }, () => this.copyAt(from, to, options, true)),
            writeFileIfRevision: (path, data, expected) => reported({ syscall: 'open', path }, () => this.onCapability(path, true, 'writeFileIfRevision', true, (fn, rel) => fn(rel, data, expected))),
            readFileAtRevision: (path, revision, range) => reported({ syscall: 'open', path }, () => this.onCapability(path, true, 'readFileAtRevision', false, (fn, rel) => fn(rel, revision, range))),
        };
    }
}
