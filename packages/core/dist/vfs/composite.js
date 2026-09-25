import { VfsError, isVfsError } from './vfs-error.js';
const EPOCH_STAT = { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40555, uid: 0, gid: 0 };
const ROOT_POINT = '/';
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;
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
function principalKey(principal) {
    const { cred, actor } = principal;
    const id = cred === null ? '-' : `${cred.uid}:${cred.gid}:${[...cred.groups].join(',')}:${cred.umask}`;
    return actor === undefined ? id : `${id}@${actor}`;
}
export class CompositeVFS {
    table;
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
            this.table = { mounts: new Map([[ROOT_POINT, { point: ROOT_POINT, source: root, options }]]), synthesized: new Map() };
            this.viewer = { cred: null };
            const refs = new Map();
            this.views = { refs, gone: new FinalizationRegistry((key) => {
                    if (refs.get(key)?.deref() === undefined)
                        refs.delete(key);
                }) };
        }
        this.syncView = this.makeSync();
    }
    // ── the table ──────────────────────────────────────────────────────────
    mount(point, source, options = {}) {
        const at = normalizePath(point);
        if (at === ROOT_POINT)
            throw new VfsError('EBUSY', 'the root is mounted at construction', point);
        if (this.table.mounts.has(at))
            throw new VfsError('EBUSY', 'something is already mounted there', point);
        this.table.mounts.set(at, { point: at, source, options });
        this.resynthesize();
    }
    unmount(point) {
        const at = normalizePath(point);
        if (at === ROOT_POINT || !this.table.mounts.delete(at))
            throw new VfsError('EINVAL', 'nothing is mounted there', point);
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
        return new VfsError('ENXIO', `${mount.point} — ${reason}`, path);
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
            throw new VfsError('EAGAIN', `${route.mount.point} is an asynchronous mount; this caller cannot wait for it`, route.path);
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
    method(ops, name, path) {
        const fn = ops[name];
        if (typeof fn !== 'function')
            throw new VfsError('ENOTSUP', `this filesystem does not support ${String(name)}`, path);
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
        // Inside a mounted backend the backend follows its own links.
        const walk = (components, hops) => {
            const resolved = [];
            const lastIndex = components.length - 1;
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
                    if (this.isStructural(prefix))
                        continue;
                    if (this.absentOn(prefix) !== null)
                        continue;
                    const route = this.route(prefix);
                    const inRoot = route.mount.point === ROOT_POINT;
                    if (final && (!inRoot || !follow))
                        continue;
                    const ops = this.ops(route, sync);
                    const canLink = inRoot && typeof ops.readlink === 'function';
                    const at = i;
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
                                throw new VfsError('ELOOP', 'too many levels of symbolic links', input);
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
                                throw new VfsError('ENOENT', 'no such file or directory', input);
                            }
                            if (stat.type !== 'directory')
                                throw new VfsError('ENOTDIR', 'not a directory', input);
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
     * Whether the backend holds a directory that exists only above a mount
     * point (not a mount point) as something else, a link or a file. Then that
     * directory holds only its mount names (rule 2 applied to ancestors: a
     * mount covers everything under its path).
     */
    coversNonDirectory(dir, sync) {
        const route = this.route(dir);
        return then(this.softStat(this.ops(route, sync), route.rel, false), (stat) => stat !== null && stat.type !== 'directory');
    }
    /** Whether `path` lies under such a covered directory (and is not itself a mount name there). */
    shadowed(path, sync) {
        if (this.isStructural(path))
            return false;
        // Only directories the path's own backend serves: one above the path's
        // mount point belongs to another filesystem, which the mount covers.
        const point = this.route(path).mount.point;
        const covered = [];
        for (let at = parentOf(path); at !== ROOT_POINT && at !== point && at.length > point.length; at = parentOf(at)) {
            if (this.isStructural(at) && !this.table.mounts.has(at))
                covered.push(at);
        }
        const next = (i) => (i >= covered.length
            ? false
            : then(this.coversNonDirectory(covered[i], sync), (hidden) => hidden || next(i + 1)));
        return next(0);
    }
    /** ENOENT when `path` is shadowed. */
    reachable(path, sync) {
        return then(this.shadowed(path, sync), (hidden) => {
            if (hidden)
                throw new VfsError('ENOENT', 'no such file or directory', path);
        });
    }
    statAt(input, follow, sync) {
        return then(this.resolve(input, follow, sync), (path) => {
            if (this.absentOn(path) !== null)
                return null;
            // A live mount point is the mounted backend's root: its mode, owner
            // and times are the backend's (chmod of /tmp reaches it, so stat must
            // too). Only a backend that cannot stat its own root (a container that
            // derives stat from a parent listing) gets a synthesized directory, as
            // does a directory that exists only above a mount point.
            if (path !== ROOT_POINT && this.isStructural(path)) {
                const mount = this.table.mounts.get(path);
                if (mount === undefined)
                    return EPOCH_STAT;
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
                return then(own(), (stat) => (stat !== null && stat.type === 'directory' ? stat : EPOCH_STAT));
            }
            return then(this.shadowed(path, sync), (hidden) => {
                if (hidden)
                    return null;
                const route = this.route(path);
                return this.softStat(this.ops(route, sync), route.rel, follow);
            });
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
        return then(this.resolve(input, true, sync), (path) => {
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
                const listed = () => then(this.coversNonDirectory(path, sync), (covers) => {
                    if (covers)
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
            return then(this.reachable(path, sync), () => then(this.ops(route, sync).readdir(route.rel), finish));
        });
    }
    emptyIfMissing(error) {
        if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR'))
            return [];
        throw error;
    }
    onFile(input, follow, sync, run) {
        return then(this.resolve(input, follow, sync), (path) => {
            this.present(path);
            if (this.isStructural(path))
                throw new VfsError('EISDIR', 'is a directory', path);
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
                throw new VfsError('EISDIR', 'is a directory', path);
            }
            const route = this.route(path);
            // chmod, chown and utimes of a mount point change the mounted root, as
            // on Linux; only a directory above a mount point has no backend to ask.
            const metadataOnly = what === 'changed' && (path === ROOT_POINT || this.table.mounts.get(path) !== undefined);
            if (this.isStructural(path) && !metadataOnly)
                throw new VfsError('EBUSY', `a mount point cannot be ${what}`, path);
            if (route.mount.options.readOnly)
                throw new VfsError('EROFS', `${route.mount.point} is mounted read-only`, path);
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
                throw new VfsError('EBUSY', 'a mount point cannot be created', path);
            }
            const route = this.route(path);
            if (route.mount.options.readOnly)
                throw new VfsError('EROFS', `${route.mount.point} is mounted read-only`, path);
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
    renameAt(fromInput, toInput, sync) {
        return then(this.resolve(fromInput, false, sync), (from) => then(this.resolve(toInput, false, sync), (to) => {
            this.present(from);
            this.present(to);
            const source = this.route(from);
            const target = this.route(to);
            if (this.isStructural(from))
                throw new VfsError('EBUSY', 'a mount point cannot be renamed', from);
            if (this.isStructural(to))
                throw new VfsError('EBUSY', 'a mount point cannot be replaced', to);
            if (source.mount !== target.mount) {
                throw new VfsError('EXDEV', `${source.mount.point} and ${target.mount.point} are different filesystems`, from);
            }
            if (source.mount.options.readOnly)
                throw new VfsError('EROFS', `${source.mount.point} is mounted read-only`, from);
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
                    throw new VfsError('ENOENT', 'no such file or directory', from);
                throw new VfsError('EXDEV', `${source.mount.point} cannot rename in place`, from);
            });
        }
        return ops.rename(source.rel, target.rel);
    }
    /**
     * A copy inside one filesystem is that backend's own (SQLite copies rows);
     * across filesystems, or where the backend has none, ENOTSUP/EXDEV tell the
     * caller to copy bytes, as cp does.
     */
    copyAt(fromInput, toInput, options, sync) {
        return then(this.resolve(fromInput, true, sync), (from) => then(this.resolve(toInput, false, sync), (to) => {
            this.present(from);
            this.present(to);
            if (this.isStructural(to))
                throw new VfsError('EBUSY', 'a mount point cannot be replaced', to);
            const source = this.route(from);
            const target = this.route(to);
            if (source.mount !== target.mount) {
                throw new VfsError('EXDEV', `${source.mount.point} and ${target.mount.point} are different filesystems`, from);
            }
            if (target.mount.options.readOnly)
                throw new VfsError('EROFS', `${target.mount.point} is mounted read-only`, to);
            return then(this.reachable(from, sync), () => then(this.reachable(to, sync), () => this.method(this.ops(source, sync), 'copy', from)(source.rel, target.rel, options)));
        }));
    }
    /** rmdir, or on a backend without it, an emptiness check and unlink. */
    rmdirAt(input, sync) {
        return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
            const backend = ops;
            if (typeof backend.rmdir === 'function')
                return backend.rmdir(rel);
            return then(backend.stat(rel, { follow: false }), (stat) => {
                if (stat === null)
                    throw new VfsError('ENOENT', 'no such file or directory', path);
                if (stat.type !== 'directory')
                    throw new VfsError('ENOTDIR', 'not a directory', path);
                return then(backend.readdir(rel), (entries) => {
                    if (entries.length > 0)
                        throw new VfsError('ENOTEMPTY', 'directory not empty', path);
                    return backend.unlink(rel);
                });
            });
        });
    }
    removeAt(input, sync) {
        return this.onMutation(input, false, sync, 'removed', (ops, rel, path) => {
            if (this.hasLiveBelow(path))
                throw new VfsError('EBUSY', 'something is mounted beneath it', path);
            const backend = ops;
            if (typeof backend.removeRecursive === 'function')
                return backend.removeRecursive(rel);
            return this.walkRemove(backend, rel, path);
        });
    }
    /** Depth-first removal with base operations; a failure names what went and what is left. */
    walkRemove(ops, rel, path) {
        const order = [];
        const visit = (at) => then(ops.stat(at, { follow: false }), (stat) => {
            if (stat === null) {
                if (at === rel)
                    throw new VfsError('ENOENT', 'no such file or directory', path);
                return undefined;
            }
            order.push({ rel: at, dir: stat.type === 'directory' });
            if (stat.type !== 'directory')
                return undefined;
            return then(ops.readdir(at), (entries) => entries.reduce((chain, entry) => then(chain, () => visit(at === '/' ? `/${entry.name}` : `${at}/${entry.name}`)), undefined));
        });
        return then(visit(rel), () => {
            order.reverse();
            const removed = [];
            return order.reduce((chain, entry, index) => then(chain, () => {
                const attempt = () => (entry.dir && typeof ops.rmdir === 'function' ? ops.rmdir(entry.rel) : ops.unlink(entry.rel));
                const fail = (cause) => {
                    if (isVfsError(cause, 'ENOENT')) {
                        removed.push(entry.rel);
                        return;
                    }
                    const left = order.slice(index).map((e) => e.rel).join(', ');
                    throw new VfsError(isVfsError(cause) ? cause.code : 'EIO', `removing ${entry.rel} failed (${cause instanceof Error ? cause.message : String(cause)}), so ${path} `
                        + `was only partly removed: gone [${removed.join(', ') || 'none'}]; still present [${left}]`, path, { cause });
                };
                try {
                    const out = attempt();
                    if (isPromise(out))
                        return out.then(() => { removed.push(entry.rel); }, fail);
                    removed.push(entry.rel);
                    return undefined;
                }
                catch (cause) {
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
    async stat(path, options) {
        return this.statAt(path, options?.follow !== false, false);
    }
    async readFile(path) {
        return this.onFile(path, true, false, (ops, rel) => ops.readFile(rel));
    }
    async readRange(path, offset, length) {
        return this.onFile(path, true, false, (ops, rel, at) => this.method(ops, 'readRange', at)(rel, offset, length));
    }
    async writeFile(path, data, options) {
        return this.onMutation(path, true, false, 'written', (ops, rel) => ops.writeFile(rel, data, options));
    }
    async writeRange(path, offset, bytes) {
        return this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes));
    }
    async truncate(path, size) {
        return this.onMutation(path, true, false, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size));
    }
    async readdir(path) {
        return this.readdirAt(path, false);
    }
    async mkdir(path, options) {
        return this.mkdirAt(path, options, false);
    }
    async unlink(path) {
        return this.onMutation(path, false, false, 'unlinked', (ops, rel) => ops.unlink(rel));
    }
    async rmdir(path) {
        return this.rmdirAt(path, false);
    }
    async rename(from, to) {
        return this.renameAt(from, to, false);
    }
    async removeRecursive(path) {
        return this.removeAt(path, false);
    }
    async symlink(target, path) {
        return this.onMutation(path, false, false, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel));
    }
    async readlink(path) {
        return this.onFile(path, false, false, (ops, rel, at) => this.method(ops, 'readlink', at)(rel));
    }
    async chmod(path, mode) {
        return this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode));
    }
    async chown(path, uid, gid) {
        return this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid));
    }
    async utimes(path, atimeMs, mtimeMs) {
        return this.onMutation(path, true, false, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, atimeMs, mtimeMs));
    }
    async writeFileIfRevision(path, data, expected) {
        return this.onMutation(path, true, false, 'written', (ops, rel, at) => this.method(ops, 'writeFileIfRevision', at)(rel, data, expected));
    }
    async copy(from, to, options) {
        return this.copyAt(from, to, options, false);
    }
    async readFileAtRevision(path, revision, range) {
        return this.onFile(path, true, false, (ops, rel, at) => this.method(ops, 'readFileAtRevision', at)(rel, revision, range));
    }
    describe() {
        const root = this.backend(this.table.mounts.get(ROOT_POINT));
        return root?.describe?.() ?? { source: 'none', type: 'composite' };
    }
    makeSync() {
        return {
            stat: (path, options) => this.statAt(path, options?.follow !== false, true),
            readFile: (path) => this.onFile(path, true, true, (ops, rel) => ops.readFile(rel)),
            readRange: (path, offset, length) => this.onFile(path, true, true, (ops, rel, at) => this.method(ops, 'readRange', at)(rel, offset, length)),
            writeFile: (path, data, options) => this.onMutation(path, true, true, 'written', (ops, rel) => ops.writeFile(rel, data, options)),
            writeRange: (path, offset, bytes) => this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeRange', at)(rel, offset, bytes)),
            truncate: (path, size) => this.onMutation(path, true, true, 'truncated', (ops, rel, at) => this.method(ops, 'truncate', at)(rel, size)),
            readdir: (path) => this.readdirAt(path, true),
            mkdir: (path, options) => this.mkdirAt(path, options, true),
            unlink: (path) => this.onMutation(path, false, true, 'unlinked', (ops, rel) => ops.unlink(rel)),
            rmdir: (path) => this.rmdirAt(path, true),
            rename: (from, to) => this.renameAt(from, to, true),
            removeRecursive: (path) => this.removeAt(path, true),
            symlink: (target, path) => this.onMutation(path, false, true, 'replaced', (ops, rel, at) => this.method(ops, 'symlink', at)(target, rel)),
            readlink: (path) => this.onFile(path, false, true, (ops, rel, at) => this.method(ops, 'readlink', at)(rel)),
            chmod: (path, mode) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chmod', at)(rel, mode)),
            chown: (path, uid, gid) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'chown', at)(rel, uid, gid)),
            utimes: (path, a, m) => this.onMutation(path, true, true, 'changed', (ops, rel, at) => this.method(ops, 'utimes', at)(rel, a, m)),
            copy: (from, to, options) => this.copyAt(from, to, options, true),
            writeFileIfRevision: (path, data, expected) => this.onMutation(path, true, true, 'written', (ops, rel, at) => this.method(ops, 'writeFileIfRevision', at)(rel, data, expected)),
            readFileAtRevision: (path, revision, range) => this.onFile(path, true, true, (ops, rel, at) => this.method(ops, 'readFileAtRevision', at)(rel, revision, range)),
        };
    }
}
/**
 * Move a file between filesystems: the copy is confirmed before the source
 * goes, and a failure puts both sides back. Directories are refused before
 * any I/O. For callers that must move across mounts (mv does its own).
 */
export async function moveAcross(vfs, from, to) {
    const stat = await vfs.stat(from);
    if (stat === null)
        throw new VfsError('ENOENT', 'no such file or directory', from);
    if (stat.type === 'directory')
        throw new VfsError('EISDIR', 'only a file can be moved across filesystems', from);
    const payload = await vfs.readFile(from);
    const before = await vfs.stat(to);
    const previous = before !== null && before.type === 'file' ? await vfs.readFile(to) : null;
    await vfs.writeFile(to, payload, stat.mode === undefined ? undefined : { mode: stat.mode & 0o7777 });
    try {
        const landed = await vfs.stat(to);
        if (landed === null || landed.size !== payload.length)
            throw new VfsError('EIO', 'the copy is not there after writing it', to);
        await vfs.unlink(from);
    }
    catch (cause) {
        try {
            if (previous !== null)
                await vfs.writeFile(to, previous);
            else if ((await vfs.stat(to)) !== null)
                await vfs.unlink(to);
            if ((await vfs.stat(from)) === null)
                await vfs.writeFile(from, payload);
        }
        catch (rollback) {
            throw new VfsError('EIO', `the move failed and could not be undone: ${String(rollback)}`, to, { cause });
        }
        throw cause;
    }
}
