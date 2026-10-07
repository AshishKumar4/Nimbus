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
import { isPendingChunkError, listPageBudget } from '../vfs/sqlite-vfs.js';
import { Hydrator } from './hydration.js';
import { CompositeVFS, isAsyncMountRefusal, normalizePath, runtimeStatOf } from '../vfs/composite.js';
import { FS_LIST_PAGE_LIMIT, MOUNT_LIST_NAME_LIMIT } from '../constants.js';
import { DevVFS } from '../vfs/dev-vfs.js';
import { standardProc } from '../vfs/proc-vfs.js';
import { sqliteFiles } from '../vfs/sqlite-files.js';
import { isVfsError, syscallError, toVfsError, VfsError } from '../vfs/vfs-error.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { readDeclaredSource, readRangeOrWhole, readText } from '../vfs/vfs.js';
import { formatProcMounts } from '../shell/mount-commands.js';
import { CRED_KERNEL, requireVfsCred, } from './os-contracts.js';
import { closeDescriptions, createSqliteDescriptorScope, fsError, modeAllows, reportLost, SqliteRuntimeFsBridge, walkBeneath, } from './sqlite-runtime-fs-bridge.js';
function immutableCredential(cred) {
    const checked = requireVfsCred(cred, 'filesystem binding');
    return Object.freeze({ uid: checked.uid, gid: checked.gid, groups: Object.freeze([...checked.groups]), umask: checked.umask });
}
/**
 * Abort a stream commit when ANY of the given signals fires. AbortSignal.any
 * is not in every runtime this code ships to, so the combination is a small
 * linked controller instead.
 */
function linkedSignal(signals) {
    const controller = new AbortController();
    const listeners = [];
    for (const signal of signals) {
        if (!signal)
            continue;
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', onAbort));
    }
    return { signal: controller.signal, dispose: () => { for (const remove of listeners)
            remove(); } };
}
/**
 * A scope still held: its caller's signal not aborted (that abort's reason),
 * and the scope not closed (EBADF: released, killed, or its lease disposed).
 */
function assertScopeLive(scope, signal) {
    signal?.throwIfAborted();
    if (scope.closed)
        throw fsError('EBADF', 'fd', 'filesystem scope closed');
}
/**
 * A process's bridge with three checks at the door: abort first (the caller
 * revoked), then a closed scope (EBADF, the POSIX answer for an operation on
 * a released descriptor table), then the append-process identity (a bound
 * process may only speak for its own pid).
 */
class GuardedProcessBridge {
    target;
    scope;
    signal;
    pid;
    hydrator;
    constructor(target, scope, signal, pid, 
    /** N17: the lazy-import hydration job, when there is one. */
    hydrator) {
        this.target = target;
        this.scope = scope;
        this.signal = signal;
        this.pid = pid;
        this.hydrator = hydrator;
    }
    gateLaunch(named) {
        return this.hydrator === null ? Promise.resolve() : this.hydrator.gate([...named]);
    }
    /** A read that met pending bytes moves them to the front of hydration, and still fails (EIO). */
    reading(read) {
        try {
            return read();
        }
        catch (error) {
            if (this.hydrator !== null && isPendingChunkError(error)) {
                // Failed for good: say so, with the cause. Otherwise it goes first.
                const failure = this.hydrator.failureOf(error.path);
                if (failure !== null)
                    throw failure;
                this.hydrator.missed(error.path);
            }
            throw error;
        }
    }
    get synchronous() { return this; }
    guard() {
        this.signal?.throwIfAborted();
        if (this.scope.closed)
            throw Object.assign(new Error('EBADF: filesystem scope closed'), { code: 'EBADF' });
    }
    ownPid(pid) {
        if (this.pid === undefined || pid !== this.pid) {
            throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
        }
    }
    stat(path, options) { this.guard(); return this.target.stat(path, options); }
    readFile(path, options) { this.guard(); return this.reading(() => this.target.readFile(path, options)); }
    writeFile(path, bytes, options) {
        this.guard();
        return this.target.writeFile(path, bytes, options);
    }
    readRange(path, offset, length, options) {
        this.guard();
        return this.reading(() => this.target.readRange(path, offset, length, options));
    }
    writeRange(path, offset, bytes, options) {
        this.guard();
        return this.target.writeRange(path, offset, bytes, options);
    }
    writeFileFrom(path, size, source) {
        this.guard();
        // A released process stops writing at the next piece, as a stream it
        // wrote would stop committing.
        const guard = () => this.guard();
        return this.target.writeFileFrom(path, size, (async function* () {
            for await (const piece of source) {
                guard();
                yield piece;
            }
            // Released after its last piece, before the file is published.
            guard();
        })());
    }
    truncate(path, size, options) { this.guard(); return this.target.truncate(path, size, options); }
    utimes(path, atimeMs, mtimeMs, options) {
        this.guard();
        return this.target.utimes(path, atimeMs, mtimeMs, options);
    }
    chmod(path, mode) { this.guard(); return this.target.chmod(path, mode); }
    access(path, mode) { this.guard(); return this.target.access(path, mode); }
    chown(path, uid, gid, options) {
        this.guard();
        return this.target.chown(path, uid, gid, options);
    }
    open(path, flags) { this.guard(); return this.target.open(path, flags); }
    read(handleId, offset, length) { this.guard(); return this.reading(() => this.target.read(handleId, offset, length)); }
    write(handleId, offset, bytes) { this.guard(); return this.target.write(handleId, offset, bytes); }
    close(handleId) { return this.target.close(handleId); }
    readdir(path, options) { this.guard(); return this.target.readdir(path, options); }
    mkdir(path, options) { this.guard(); return this.target.mkdir(path, options); }
    unlink(path) { this.guard(); return this.target.unlink(path); }
    rmdir(path) { this.guard(); return this.target.rmdir(path); }
    rename(from, to, options) { this.guard(); return this.target.rename(from, to, options); }
    readlink(path) { this.guard(); return this.target.readlink(path); }
    linkLeadsTo(path, link) { this.guard(); return this.target.linkLeadsTo(path, link); }
    symlink(target, path) { this.guard(); return this.target.symlink(target, path); }
    fsync(handleId) { this.guard(); return this.target.fsync(handleId); }
    revision(path) { this.guard(); return this.target.revision(path); }
    acquire(epoch, cursor, options) { this.guard(); return this.target.acquire(epoch, cursor, options); }
    list(after, limit) { this.guard(); return this.target.list(after, limit); }
    subscribe(path, listener) {
        this.guard();
        const unsubscribe = this.target.subscribe(path, listener);
        const dispose = () => { unsubscribe(); this.scope.subscriptions.delete(dispose); };
        this.scope.subscriptions.add(dispose);
        return dispose;
    }
    realpath(path) { this.guard(); return this.target.realpath(path); }
    remove(path, options) { this.guard(); return this.target.remove(path, options); }
    copyFile(from, to) { this.guard(); return this.target.copyFile(from, to); }
    copyTree(from, to, options) {
        this.guard();
        return this.target.copyTree(from, to, options);
    }
    fstat(handleId) { this.guard(); return this.target.fstat(handleId); }
    descriptorPath(handleId) { this.guard(); return this.target.descriptorPath(handleId); }
    dup(handleId) { this.guard(); return this.target.dup(handleId); }
    seek(handleId, offset, whence) { this.guard(); return this.target.seek(handleId, offset, whence); }
    setStatus(handleId, status) { this.guard(); return this.target.setStatus(handleId, status); }
    readdirHandle(handleId) { this.guard(); return this.target.readdirHandle(handleId); }
    ftruncate(handleId, size) { this.guard(); return this.target.ftruncate(handleId, size); }
    fchmod(handleId, mode) { this.guard(); return this.target.fchmod(handleId, mode); }
    fchown(handleId, uid, gid) { this.guard(); return this.target.fchown(handleId, uid, gid); }
    futimes(handleId, atimeMs, mtimeMs) { this.guard(); return this.target.futimes(handleId, atimeMs, mtimeMs); }
    appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes) {
        this.guard();
        this.ownPid(pid);
        return this.target.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes);
    }
    acknowledgeAppend(pid, writerId, moduleId, operationId) {
        this.guard();
        this.ownPid(pid);
        return this.target.acknowledgeAppend(pid, writerId, moduleId, operationId);
    }
    writeBatch(payload) { this.guard(); return this.target.writeBatch(payload); }
    writeStream(stream, options) {
        this.guard();
        // Closing the scope cancels the commit, so a released process cannot keep
        // publishing groups into a filesystem it no longer holds descriptors on.
        const linked = linkedSignal([options?.signal, this.signal, this.scope.abort.signal]);
        return this.target.writeStream(stream, { ...options, signal: linked.signal }).finally(linked.dispose);
    }
    acquireExclusiveMutation(path, options) {
        this.guard();
        return this.target.acquireExclusiveMutation(path, options);
    }
    releaseExclusiveMutation(owner) { this.guard(); return this.target.releaseExclusiveMutation(owner); }
}
/** The session's namespace and the processes bound to it. */
export class ProcessFiles {
    engine;
    namespace;
    /** The mount table: SQLite at `/`, `/proc`, `/dev`, and the embedder's. */
    vfs;
    /** `/proc`: the host registers generated files here (`mounts` is ProcessFiles'). */
    proc;
    processes = new Map();
    /** Each scope's descriptors on asynchronous mounts: a process's, whichever bridge it binds per call. */
    awaitedDescriptors = new WeakMap();
    namespaces = new Map();
    retired = new Set();
    /** Per process: where its listings of the mounts beyond SQLite stand (MountListing). */
    listings = new Map();
    /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
    /** N17: the lazy-import hydration job, when the embedder supplies a fetch. */
    hydrator;
    /** Bytes one buffered mount handle holds before EFBIG (VFS-PF-001). */
    bufferedWriteBytes;
    constructor(engine, options = {}) {
        this.engine = engine;
        this.hydrator = options.hydration === undefined ? null : new Hydrator(engine, options.hydration);
        this.bufferedWriteBytes = options.bufferedWriteBytes;
        this.namespace = engine.namespace;
        this.vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
        // An exclusive-mutation lease holds wherever a process's mutation lands,
        // on a mount as on SQLite: checked by the namespace on the route it
        // resolved, right before the backend is called.
        this.vfs.guardMutations((cred, path) => engine.mutationRefusal(path, cred));
        this.proc = standardProc();
        this.proc.register('mounts', (cred) => formatProcMounts(this.mounts(cred ?? CRED_KERNEL)));
        this.vfs.mount('/proc', this.proc);
        this.vfs.mount('/dev', new DevVFS());
        // A wave's records the namespace answers itself (a mount, a directory
        // above one, or a name whose parent resolves into one) are applied by
        // its own operations, whoever streams the wave: a process's binding, or
        // a command holding the engine.
        engine.setWaveRouter({
            composes: (path) => this.vfs.composes(path),
            apply: (record, cred) => applyRoutedRecord(this.vfs.as(immutableCredential(cred)), record),
        });
    }
    /**
     * An import page (N16); with `lazy` (N17) the chunks it lacks stay pending
     * and are queued for hydration, in the order the page names them.
     */
    importPage(dst, page, chunks = [], options = {}) {
        if (options.lazy && this.hydrator === null)
            throw syscallError('EINVAL', 'import', dst, { detail: 'a lazy import needs a hydration fetch (ProcessFiles hydration option)' });
        const result = this.engine.importPage(dst, page, chunks, options);
        if (result.pending.length > 0) {
            this.hydrator.enqueue(result.pending);
            void this.hydrator.run();
        }
        return result;
    }
    /**
     * N17: a launch that reads synchronously (WASI) waits for the paths it
     * names (program, argv paths, a cwd inside an import) to be local, at most
     * the hydration deadline; EIO naming the first that is not, after it. A
     * launch naming nothing pending starts at once.
     */
    /** Resolves once `path`'s bytes are hydrated (at once, for a path with none pending). */
    hydrated(path) {
        return this.hydrator === null ? Promise.resolve() : this.hydrator.whenLocal(path);
    }
    gateLaunch(named) {
        return this.hydrator === null ? Promise.resolve() : this.hydrator.gate([...named]);
    }
    /**
     * What a process's launch names — its working directory, program and
     * arguments, the literal paths its code names, the files its module map
     * was read from — which is where its listing (`list`) walks mounts without
     * a change feed (CompositeFeed.walk, MOUNT_LIST_NAME_LIMIT). `names` is
     * asked only when the process's credential sees a mount beyond SQLite and
     * the kernel's, so a launch computes nothing for a namespace that is
     * SQLite alone. Adds to what was named.
     */
    nameLaunch({ pid, cred }, names) {
        if (this.retired.has(pid))
            return;
        const view = this.vfs.as(immutableCredential(cred));
        if (!mountsBeyondSqlite(view))
            return;
        const { named } = this.createListing(pid);
        for (const name of names()) {
            if (name === '')
                continue;
            const path = normalizePath(name.startsWith('/') ? name : `/${name}`);
            if (isEmbedderMount(view.mountOf(path)))
                named.add(path);
        }
    }
    /** Where `pid`'s listings of the mounts beyond SQLite stand (made when `create`), or undefined. */
    listingOf(pid, create) {
        let listing = this.listings.get(pid);
        if (listing === undefined && create && !this.retired.has(pid)) {
            listing = this.createListing(pid);
        }
        return listing;
    }
    createListing(pid) {
        let listing = this.listings.get(pid);
        if (listing === undefined) {
            listing = { named: new Set(), table: null, held: null };
            this.listings.set(pid, listing);
        }
        return listing;
    }
    bind({ pid, cred, signal }) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw new Error('filesystem binding requires a process pid');
        if (this.retired.has(pid))
            throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
        let scope = this.processes.get(pid);
        if (!scope) {
            scope = createSqliteDescriptorScope();
            this.processes.set(pid, scope);
        }
        return this.bridgeFor(scope, immutableCredential(cred), signal, pid);
    }
    openHost(cred, options = {}) {
        const scope = createSqliteDescriptorScope();
        const fs = this.bridgeFor(scope, immutableCredential(cred), options.signal);
        return { fs, dispose: async () => this.closeScope(scope) };
    }
    /**
     * What a command sees: the namespace as `cred`, through this process's
     * bridge, so every mutation passes the lease check (EBUSY on another
     * owner's lease) and every path is routed as the process's own syscalls are.
     */
    view(binding) {
        return new ProcessView(this.bind(binding));
    }
    /**
     * The namespace as `cred`, synchronously, for host code that reads user
     * paths in one turn (git, the build services, vite's file shim, agent
     * tools). Mounted paths route to their mount (a mount without a
     * synchronous face answers ENOTSUP) and SQLite paths go to the engine,
     * exactly as a process's syscalls do. One per credential for the session.
     */
    namespaceFs(cred) {
        const identity = immutableCredential(cred);
        const key = `${identity.uid}:${identity.gid}:${identity.groups.join(',')}:${identity.umask}`;
        let fs = this.namespaces.get(key);
        if (!fs) {
            const bridge = this.bridgeFor(createSqliteDescriptorScope(), identity);
            fs = new NamespaceFs(bridge.synchronous, identity);
            this.namespaces.set(key, fs);
        }
        return fs;
    }
    /** Host work over a credentialed lease released when the work settles. */
    async withHost(cred, use) {
        const lease = this.openHost(cred);
        try {
            return await use(lease.fs);
        }
        finally {
            await lease.dispose();
        }
    }
    async releaseProcess(pid) {
        this.retired.add(pid);
        this.listings.delete(pid);
        const scope = this.processes.get(pid);
        try {
            // Its descriptors' last closes flush; one whose flush fails is reported
            // once the process is released all the same.
            if (scope)
                this.closeScope(scope);
        }
        finally {
            this.processes.delete(pid);
            this.engine.revokeAppendWriters(pid);
        }
    }
    /** See NimbusFilesystemAuthority.rewindProcess. */
    async rewindProcess(pid) {
        if (this.retired.has(pid))
            return;
        this.listings.delete(pid);
        const scope = this.processes.get(pid);
        try {
            if (scope)
                this.closeScope(scope);
        }
        finally {
            this.processes.delete(pid);
        }
    }
    /**
     * The process died without closing its descriptors: nothing is flushed,
     * and what that loses is reported, the descriptors whose buffered writes
     * are gone. Later use of its descriptors is EBADF, as after a release.
     */
    killProcess(pid) {
        this.retired.add(pid);
        this.listings.delete(pid);
        const scope = this.processes.get(pid);
        this.processes.delete(pid);
        this.engine.revokeAppendWriters(pid);
        if (!scope || scope.closed)
            return { lost: [] };
        const lost = [];
        for (const [id, opened] of scope.handles) {
            if ((opened.node.pendingBytes?.() ?? 0) > 0)
                lost.push(id);
            // Dropped unflushed; a description another process still holds stays open.
            opened.refs--;
        }
        scope.handles.clear();
        this.awaitedDescriptors.get(scope)?.opened.clear();
        scope.closed = true;
        scope.abort.abort();
        for (const unsubscribe of scope.subscriptions)
            unsubscribe();
        scope.subscriptions.clear();
        return { lost };
    }
    async activateAppendWriter(pid, writerId) {
        if (this.retired.has(pid))
            throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
        this.engine.activateAppendWriter(pid, writerId);
    }
    async revokeAppendWriter(pid, writerId) { this.engine.revokeAppendWriter(pid, writerId); }
    async revokeAppendWriters(pid) { this.engine.revokeAppendWriters(pid); }
    async revokeAppendWritersThrough(maxPid) { this.engine.revokeAppendWritersThrough(maxPid); }
    /** The mounts `cred` sees, root first: what df, mount and `/proc/mounts` list. */
    mounts(cred) {
        const engine = this.engine;
        return this.vfs.as(immutableCredential(cred)).mounts().map((mount) => {
            if (mount.point === '/') {
                return { mountPoint: '/', source: 'nimbus', type: 'nimbus-sqlite', options: ['rw'], usage: async () => engine.storageUsage() };
            }
            const described = mount.describe();
            return {
                mountPoint: mount.point,
                source: described.source,
                type: described.type,
                options: described.options,
                usage: () => mount.usage(),
            };
        });
    }
    /**
     * Closes `scope` for good: every descriptor (each last close flushing),
     * its subscriptions, and the scope itself (EBADF from then on, for every
     * bridge on it). A flush that fails (an aborted binding's, a mount's
     * refusal) loses its bytes and is reported after the scope is closed.
     */
    closeScope(scope) {
        if (scope.closed)
            return;
        const lost = closeDescriptions(scope);
        this.awaitedDescriptors.get(scope)?.opened.clear();
        for (const dispose of scope.subscriptions)
            dispose();
        scope.subscriptions.clear();
        scope.closed = true;
        scope.abort.abort();
        reportLost(lost);
    }
    bridgeFor(scope, cred, signal, pid) {
        // The scope is checked again by the namespace right before each mutation
        // reaches a backend, after the lookups it awaited: a write still
        // resolving when the process is released or killed, or its lease is
        // disposed, does not land.
        const view = this.vfs.as(cred).scoped(() => assertScopeLive(scope, signal));
        const target = new SqliteRuntimeFsBridge(this.engine.as(cred), this.engine, scope, view, this.bufferedWriteBytes);
        const guarded = new GuardedProcessBridge(target, scope, signal, pid, this.hydrator);
        // Every other method forwards to the guarded bridge.
        let awaited = this.awaitedDescriptors.get(scope);
        if (!awaited) {
            awaited = { opened: new Map(), next: AWAITED_DESCRIPTOR_BASE };
            this.awaitedDescriptors.set(scope, awaited);
        }
        const listing = pid === undefined ? () => undefined : (create) => this.listingOf(pid, create);
        return new AwaitingProcessBridge(guarded, view, () => this.engine.revision(), cred, awaited, scope, listing, signal);
    }
}
/** The kernel's own filesystems: never walked, and never in a process's listing, which is SQLite's and its embedder's. */
const KERNEL_MOUNT_POINTS = { '/proc': true, '/dev': true };
/** A mount an embedder made (a Drive, a container, a device). */
function isEmbedderMount(point) {
    return point !== '/' && KERNEL_MOUNT_POINTS[point] !== true;
}
/** Whether `path` (absolute) is at or under /proc or /dev. */
function underKernelMount(path) {
    const end = path.indexOf('/', 1);
    return KERNEL_MOUNT_POINTS[end === -1 ? path : path.slice(0, end)] === true;
}
/** Whether `view` shows a mount an embedder made: only then is a process's listing more than SQLite's. */
function mountsBeyondSqlite(view) {
    return view.mounts().some((mount) => isEmbedderMount(mount.point));
}
/**
 * A process's asynchronous face (ProcessView, supervisor ops, RPC,
 * fs.promises): the guarded bridge, except that a path an asynchronous-only
 * mount refuses to a synchronous caller is answered by awaiting that mount,
 * through the namespace as the process's credential. `synchronous` (node's
 * sync fs, non-JSPI WASI, host reads that cannot wait) stays the guarded
 * bridge, where such a mount's refusal is the answer.
 */
/** Where descriptors on asynchronous mounts are numbered: clear of the scope's own. */
const AWAITED_DESCRIPTOR_BASE = 0x4000_0000;
class AwaitingProcessBridge {
    bridge;
    namespace;
    clock;
    cred;
    descriptors;
    scope;
    listing;
    signal;
    constructor(bridge, namespace, clock, cred, descriptors, scope, 
    /** Where this process's listings of mounts beyond SQLite stand (made when `create`); undefined for a host lease. */
    listing, signal) {
        this.bridge = bridge;
        this.namespace = namespace;
        this.clock = clock;
        this.cred = cred;
        this.descriptors = descriptors;
        this.scope = scope;
        this.listing = listing;
        this.signal = signal;
    }
    get synchronous() { return this.bridge; }
    gateLaunch(named) { return this.bridge.gateLaunch(named); }
    revision(path) { return this.bridge.revision(path); }
    subscribe(path, listener) { return this.bridge.subscribe(path, listener); }
    appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes) {
        return this.bridge.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes);
    }
    acknowledgeAppend(pid, writerId, moduleId, operationId) {
        return this.bridge.acknowledgeAppend(pid, writerId, moduleId, operationId);
    }
    writeBatch(payload) { return this.bridge.writeBatch(payload); }
    writeStream(stream, options) { return this.bridge.writeStream(stream, options); }
    acquireExclusiveMutation(path, options) {
        return this.bridge.acquireExclusiveMutation(path, options);
    }
    releaseExclusiveMutation(owner) { return this.bridge.releaseExclusiveMutation(owner); }
    /** As the guarded bridge's guard: a released or killed process's scope answers EBADF. */
    live() {
        assertScopeLive(this.scope, this.signal);
    }
    /**
     * One page of every name the process's view shows, in path order. SQLite
     * alone (no mount an embedder made): SQLite's own page, answered at once.
     * Otherwise the namespace's feed (CompositeFeed.list): SQLite's names less
     * what a mount covers, the directories the namespace makes, and each
     * mount's names where the process's launch named them (CompositeFeed.walk),
     * cut to a page by SQLite's own bound (listPageBudget). The kernel's /proc
     * and /dev are left out, as SQLite's page leaves them out. A mounted entry
     * carries revision 0: a mount never moves the SQLite clock.
     */
    list(after, limit) {
        if (!mountsBeyondSqlite(this.namespace)) {
            // A listing of SQLite alone from the start begins at no mount table.
            const listing = after === null || after === undefined ? this.listing(false) : undefined;
            if (listing)
                listing.table = null;
            return this.bridge.list(after, limit);
        }
        this.live();
        return this.listMounted(after ?? null, Math.min(Math.max(1, Math.trunc(limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT));
    }
    async listMounted(after, want) {
        const listing = this.listing(true);
        const feed = this.namespace.feed;
        // A page continuing a listing reuses the walk its earlier pages took; any other walks afresh.
        const held = listing?.held;
        const walk = after !== null && held && held.next === after
            ? held.walk
            : await feed.walk(listing?.named ?? [], MOUNT_LIST_NAME_LIMIT);
        this.live();
        // Read before the page, as SqliteVFS.list reads its cursor (VfsListPage).
        const position = feed.position();
        const root = position.feeds['/'];
        if (after === null && listing)
            listing.table = position.table;
        const page = feed.list(after === null ? null : `/${after}`, want, walk);
        // SQLite measured its own entries when it listed them; each is measured
        // here under the path the process sees, which only re-encodes that path.
        const fits = listPageBudget(root.epoch, root.cursor);
        const entries = [];
        let next = page.next === null ? null : page.next.slice(1);
        for (const entry of page.entries) {
            if (underKernelMount(entry.path))
                continue;
            const path = entry.path.slice(1);
            if (!fits(entry, path)) {
                next = entries[entries.length - 1].path;
                break;
            }
            entries.push({ ...entry, path });
        }
        if (listing)
            listing.held = next === null ? null : { walk, next };
        return { epoch: root.epoch, rev: root.cursor, entries, next };
    }
    /**
     * What changed since the process's cursor. SQLite alone: SQLite's own
     * answer. Otherwise the namespace's feed (CompositeFeed.since), which
     * reports only what the namespace routes to SQLite (a write SQLite takes
     * under a mount point is none of the process's), and is a poison when the
     * mount table is not the one the process's last listing began at.
     */
    acquire(epoch, cursor, options) {
        const listing = this.listing(false);
        if (!mountsBeyondSqlite(this.namespace) && (listing?.table ?? null) === null)
            return this.bridge.acquire(epoch, cursor, options);
        this.live();
        const feed = this.namespace.feed;
        const table = listing?.table ?? feed.position().table;
        // A null epoch (a caller with no cursor) is SQLite's poison, as ever.
        const answer = feed.since({ table, feeds: { '/': { epoch, cursor } } }, options);
        const root = answer.position.feeds['/'];
        const paths = [];
        for (const entry of answer.paths) {
            if (underKernelMount(entry.path))
                continue;
            paths.push({ ...entry, path: entry.path.slice(1) });
        }
        return {
            epoch: root.epoch, rev: root.cursor, paths, poison: answer.poison,
            ...(options?.namespace === true && !answer.poison ? { namespace: true } : {}),
        };
    }
    /**
     * The guarded bridge's answer, as it gives it (synchronously when it can),
     * or on an asynchronous mount's refusal, `awaited`.
     */
    either(paths, sync, awaited) {
        // Relative to one of this face's own descriptors: the bridge has never seen it.
        const settled = () => { this.live(); return awaited(); };
        if (paths.some((path) => typeof path !== 'string' && 'directory' in path && this.awaited.has(path.directory)))
            return settled();
        const refused = (error) => {
            if (!isAsyncMountRefusal(error))
                throw error;
            return settled();
        };
        let answer;
        try {
            answer = sync();
        }
        catch (error) {
            return refused(error);
        }
        return answer instanceof Promise ? answer.catch(refused) : answer;
    }
    /**
     * `path` as an absolute namespace path; a path beneath a root (a WASI
     * preopen) walked by `walkBeneath`, the synchronous bridge's own walk,
     * its lookups awaited through the namespace.
     */
    async path(path, follow = true) {
        if (typeof path === 'string')
            return path;
        const base = 'root' in path ? '/' + normalizeVfsPath(path.root)
            : this.awaited.get(path.directory)?.path ?? this.bridge.descriptorPath(path.directory);
        if (!path.beneath) {
            if (path.path.startsWith('/'))
                return path.path;
            if ((await this.namespace.stat(base))?.type !== 'directory')
                throw fsError('ENOTDIR', 'path', path.path);
            return (base === '/' ? '' : base) + '/' + path.path;
        }
        const root = normalizeVfsPath(base);
        const walk = walkBeneath(root, path, follow, this.cred, (name, to) => this.namespace.resolvedByBackend(name, '/' + root, to));
        for (let step = walk.next();;) {
            if (step.done) {
                if (step.value === null)
                    throw fsError('ELOOP', 'path', path);
                return '/' + step.value;
            }
            const lookup = step.value;
            step = walk.next('readlink' in lookup
                ? this.namespace.linkLeadsTo(lookup.readlink, await this.namespace.readlink(lookup.readlink))
                : await this.namespace.stat(lookup.stat, { follow: false }));
        }
    }
    receipt() {
        const r = this.clock();
        return { before: r, after: r };
    }
    absent(read) {
        return read().catch((error) => {
            if (error?.code === 'ENOENT')
                return null;
            throw error;
        });
    }
    stat(path, options) {
        return this.either([path], () => this.bridge.stat(path, options), async () => {
            const follow = options?.followSymlinks !== false;
            let resolved;
            try {
                resolved = await this.path(path, follow);
            }
            catch (error) {
                // As the bridge's stat: a component missing on the way is "not there".
                if (error?.code === 'ENOENT')
                    return null;
                throw error;
            }
            const stat = await this.namespace.stat(resolved, { follow });
            return stat === null ? null : runtimeStatOf(stat);
        });
    }
    readFile(path, options) {
        return this.either([path], () => this.bridge.readFile(path, options), () => this.absent(async () => this.namespace.readFile((await this.path(path, options?.followSymlinks !== false)))));
    }
    readRange(path, offset, length, options) {
        return this.either([path], () => this.bridge.readRange(path, offset, length, options), () => this.absent(async () => await readRangeOrWhole(this.namespace, await this.path(path), offset, length)));
    }
    writeFile(path, bytes, options) {
        return this.either([path], () => this.bridge.writeFile(path, bytes, options), async () => {
            // createParents makes the directories above where the write lands, in
            // the same lookup as the write (a link's target's, not the link's).
            const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
            await this.namespace.writeFile(await this.path(path), data, { parents: options?.createParents === true });
            return this.clock();
        });
    }
    writeRange(path, offset, bytes, options) {
        return this.either([path], () => this.bridge.writeRange(path, offset, bytes, options), async () => {
            await this.namespace.writeRange(await this.path(path), offset, bytes, { parents: options?.createParents === true });
            return this.receipt();
        });
    }
    async writeFileFrom(path, size, source) {
        // The bridge refuses a path on an asynchronous mount before reading the source.
        return this.either([path], () => this.bridge.writeFileFrom(path, size, source), async () => {
            const p = await this.path(path);
            // An asynchronous mount takes the whole file in one write, as a
            // synchronous one does (SqliteRuntimeFsBridge.writeFileFrom), and not
            // for a process released while its source was read.
            const data = await readDeclaredSource(source, size, () => syscallError('EINVAL', 'write', p));
            this.live();
            await this.namespace.writeFile(p, data);
            return this.clock();
        });
    }
    truncate(path, size, options) {
        return this.either([path], () => this.bridge.truncate(path, size, options), async () => {
            await this.namespace.truncate((await this.path(path)), size);
            return this.receipt();
        });
    }
    utimes(path, atimeMs, mtimeMs, options) {
        return this.either([path], () => this.bridge.utimes(path, atimeMs, mtimeMs, options), async () => {
            const p = (await this.path(path, options?.followSymlinks !== false));
            const now = Date.now();
            const kept = atimeMs === undefined || mtimeMs === undefined ? await this.namespace.stat(p) : null;
            await this.namespace.utimes(p, atimeMs === undefined ? (kept?.atimeMs ?? now) : (atimeMs ?? now), mtimeMs === undefined ? (kept?.mtimeMs ?? now) : (mtimeMs ?? now));
            return this.receipt();
        });
    }
    chmod(path, mode) {
        return this.either([path], () => this.bridge.chmod(path, mode), async () => {
            await this.namespace.chmod((await this.path(path)), mode);
            return this.receipt();
        });
    }
    chown(path, uid, gid, options) {
        return this.either([path], () => this.bridge.chown(path, uid, gid, options), async () => {
            await this.namespace.chown((await this.path(path, options?.followSymlinks !== false)), uid, gid);
            return this.receipt();
        });
    }
    access(path, mode) {
        return this.either([path], () => this.bridge.access(path, mode), async () => {
            const p = await this.path(path);
            const stat = await this.namespace.stat(p);
            if (stat === null)
                throw syscallError('ENOENT', 'access', p);
            if (!modeAllows(stat, mode, this.cred))
                throw syscallError('EACCES', 'access', p);
        });
    }
    readdir(path, options) {
        return this.either([path], () => this.bridge.readdir(path, options), async () => (await this.namespace.readdir((await this.path(path, options?.followSymlinks !== false)))).map((entry) => ({ name: entry.name, type: entry.type })));
    }
    mkdir(path, options) {
        return this.either([path], () => this.bridge.mkdir(path, options), async () => this.namespace.mkdir((await this.path(path)), options));
    }
    unlink(path) {
        return this.either([path], () => this.bridge.unlink(path), async () => this.namespace.unlink((await this.path(path, false))));
    }
    rmdir(path) {
        return this.either([path], () => this.bridge.rmdir(path), async () => this.namespace.rmdir((await this.path(path, false))));
    }
    rename(from, to, options) {
        return this.either([from, to], () => this.bridge.rename(from, to, options), async () => this.namespace.rename((await this.path(from, false)), (await this.path(to, false))));
    }
    realpath(path) {
        return this.either([path], () => this.bridge.realpath(path), async () => this.namespace.realpathAsync(await this.path(path)));
    }
    readlink(path) {
        return this.either([path], () => this.bridge.readlink(path), () => this.absent(async () => this.namespace.readlink((await this.path(path, false)))));
    }
    linkLeadsTo(path, link) { return this.bridge.linkLeadsTo(path, link); }
    symlink(target, path) {
        return this.either([path], () => this.bridge.symlink(target, path), async () => this.namespace.symlink(target, (await this.path(path, false))));
    }
    remove(path, options) {
        return this.either([path], () => this.bridge.remove(path, options), async () => {
            const p = (await this.path(path, false));
            const stat = await this.namespace.stat(p, { follow: false });
            if (stat === null) {
                if (options?.force)
                    return;
                throw syscallError('ENOENT', 'rm', p);
            }
            if (stat.type !== 'directory')
                return this.namespace.unlink(p);
            if (!options?.recursive)
                throw syscallError('EISDIR', 'rm', p);
            const report = await this.namespace.removeRecursive(p);
            const failed = report?.failures?.[0];
            if (failed)
                throw syscallError(failed.error.code, 'rm', failed.path);
        });
    }
    copyFile(from, to) {
        return this.either([from, to], () => this.bridge.copyFile(from, to), async () => this.namespace.copy((await this.path(from)), (await this.path(to)), { recursive: false }));
    }
    copyTree(from, to, options) {
        return this.either([from, to], () => this.bridge.copyTree(from, to, options), async () => {
            await this.namespace.copy((await this.path(from)), (await this.path(to)), { recursive: true, preserve: options?.preserve });
            return 0;
        });
    }
    // ── descriptors on an asynchronous mount ─────────────────────────────
    // Held per descriptor scope, in an id range the scope never issues; a dup
    // shares the description (its offset and status flags). A write goes to
    // the mount at once (its writeRange, or the whole file rewritten where it
    // has none); an append lands at the end as it then is.
    get awaited() { return this.descriptors.opened; }
    issue(description) {
        const id = this.descriptors.next++;
        this.awaited.set(id, description);
        return { id, path: description.path, flags: { ...description.flags }, position: description.position, closed: false };
    }
    open(path, flags) {
        return this.either([path], () => this.bridge.open(path, flags), async () => {
            const follow = flags.followSymlinks !== false;
            const p = await this.path(path, follow);
            const stat = await this.namespace.stat(p, { follow });
            // O_NOFOLLOW on a trailing link is ELOOP, as the synchronous bridge
            // answers: there is no descriptor on the link itself, and a write
            // would land where it leads.
            if (!follow && stat?.type === 'symlink')
                throw syscallError('ELOOP', 'open', p);
            if (stat !== null && flags.create && flags.exclusive)
                throw syscallError('EEXIST', 'open', p);
            if (stat === null && !flags.create)
                throw syscallError('ENOENT', 'open', p);
            if (stat !== null && stat.type === 'directory' && (flags.write || flags.truncate || flags.append))
                throw syscallError('EISDIR', 'open', p);
            if (flags.directory && stat !== null && stat.type !== 'directory')
                throw syscallError('ENOTDIR', 'open', p);
            if (stat === null || flags.truncate)
                await this.namespace.writeFile(p, new Uint8Array(0), flags.mode === undefined ? undefined : { mode: flags.mode });
            return this.issue({
                // The file it opened, by the name the namespace resolved for it: a
                // link on the way repointed later does not move the descriptor.
                path: await this.namespace.realpathAsync(p),
                flags: {
                    read: !!flags.read, write: !!flags.write, append: !!flags.append, create: !!flags.create,
                    exclusive: !!flags.exclusive, directory: !!flags.directory, truncate: !!flags.truncate,
                    followSymlinks: flags.followSymlinks !== false,
                },
                position: 0,
            });
        });
    }
    opened(handleId) {
        const opened = this.awaited.get(handleId);
        if (opened === undefined)
            throw fsError('EBADF', 'fd', String(handleId));
        return opened;
    }
    /** The bridge's own descriptor, or this one's `awaited` answer. */
    on(handleId, own, awaited) {
        const description = this.awaited.get(handleId);
        if (description === undefined)
            return own();
        this.live();
        return awaited(description);
    }
    read(handleId, offset, length) {
        return this.on(handleId, () => this.bridge.read(handleId, offset, length), async (d) => {
            if (!d.flags.read)
                throw fsError('EBADF', 'read', d.path);
            const start = offset ?? d.position;
            const bytes = await readRangeOrWhole(this.namespace, d.path, start, length);
            if (offset === null)
                d.position = start + bytes.byteLength;
            return bytes;
        });
    }
    write(handleId, offset, bytes) {
        return this.on(handleId, () => this.bridge.write(handleId, offset, bytes), async (d) => {
            if (!d.flags.write)
                throw fsError('EBADF', 'write', d.path);
            const start = d.flags.append ? ((await this.namespace.stat(d.path))?.size ?? 0) : offset ?? d.position;
            this.live();
            try {
                await this.namespace.writeRange(d.path, start, bytes);
            }
            catch (error) {
                if (!(error instanceof VfsError && error.code === 'ENOTSUP'))
                    throw error;
                const file = await this.namespace.readFile(d.path);
                const next = new Uint8Array(Math.max(file.byteLength, start + bytes.byteLength));
                next.set(file);
                next.set(bytes, start);
                await this.namespace.writeFile(d.path, next);
            }
            if (offset === null || d.flags.append)
                d.position = start + bytes.byteLength;
            return bytes.byteLength;
        });
    }
    close(handleId) {
        if (!this.awaited.delete(handleId))
            return this.bridge.close(handleId);
    }
    fsync(handleId) {
        if (handleId === undefined || !this.awaited.has(handleId))
            return this.bridge.fsync(handleId);
    }
    fstat(handleId) {
        return this.on(handleId, () => this.bridge.fstat(handleId), async (d) => {
            const stat = await this.namespace.stat(d.path);
            if (stat === null)
                throw syscallError('ENOENT', 'fstat', d.path);
            return runtimeStatOf(stat);
        });
    }
    dup(handleId) {
        return this.on(handleId, () => this.bridge.dup(handleId), async (d) => this.issue(d));
    }
    seek(handleId, offset, whence) {
        return this.on(handleId, () => this.bridge.seek(handleId, offset, whence), async (d) => {
            const base = whence === 'set' ? 0 : whence === 'current' ? d.position : ((await this.namespace.stat(d.path))?.size ?? 0);
            if (base + offset < 0)
                throw syscallError('EINVAL', 'seek', d.path);
            d.position = base + offset;
            return d.position;
        });
    }
    setStatus(handleId, status) {
        return this.on(handleId, () => this.bridge.setStatus(handleId, status), async (d) => {
            if (status.append !== undefined)
                d.flags.append = status.append;
        });
    }
    readdirHandle(handleId) {
        return this.on(handleId, () => this.bridge.readdirHandle(handleId), async (d) => (await this.namespace.readdir(d.path)).map((entry) => ({ name: entry.name, type: entry.type })));
    }
    ftruncate(handleId, size) {
        return this.on(handleId, () => this.bridge.ftruncate(handleId, size), async (d) => {
            if (!d.flags.write)
                throw fsError('EINVAL', 'ftruncate', d.path);
            await this.namespace.truncate(d.path, size);
        });
    }
    fchmod(handleId, mode) {
        return this.on(handleId, () => this.bridge.fchmod(handleId, mode), async (d) => { await this.namespace.chmod(d.path, mode); });
    }
    fchown(handleId, uid, gid) {
        return this.on(handleId, () => this.bridge.fchown(handleId, uid, gid), async (d) => { await this.namespace.chown(d.path, uid, gid); });
    }
    futimes(handleId, atimeMs, mtimeMs) {
        return this.on(handleId, () => this.bridge.futimes(handleId, atimeMs, mtimeMs), async (d) => { await this.namespace.utimes(d.path, atimeMs, mtimeMs); });
    }
}
/** A command's view for a process binding, over any binding authority. */
export function bindProcessView(authority, binding) {
    return new ProcessView(authority.bind(binding));
}
/** Host-side work through a credentialed view whose lease is released when the work settles. */
export async function withHostView(authority, cred, use) {
    const lease = authority.openHost(cred);
    try {
        return await use(new ProcessView(lease.fs));
    }
    finally {
        await lease.dispose();
    }
}
/**
 * Where `path` is on `engine`, as `view` sees the namespace: its engine key
 * with every link resolved, or null when it is on a mount. A name not there
 * yet is placed by the nearest directory above it that is, where it would
 * be made. Host tools read and write a user's tree through `view`; they
 * take the engine's bulk paths (batched writes, pre-bundling, the dev
 * servers) only at this key, never at a lexical path a mount may shadow.
 */
export async function engineKey(view, engine, path) {
    let at = '/' + normalizeVfsPath(path);
    let below = '';
    for (;;) {
        let real;
        try {
            real = await view.realpath(at);
        }
        catch (error) {
            if (at === '/' || (!isVfsError(error, 'ENOENT') && !isVfsError(error, 'ENOTDIR')))
                throw error;
            const cut = at.lastIndexOf('/');
            below = below === '' ? at.slice(cut + 1) : `${at.slice(cut + 1)}/${below}`;
            at = at.slice(0, cut) || '/';
            continue;
        }
        // No link is left on `real`, so the device holding it holds the names below it too.
        if ((await view.stat(real, { follow: false }))?.dev !== engine.deviceId)
            return null;
        return normalizeVfsPath(below === '' ? real : `${real}/${below}`);
    }
}
/**
 * A wave's record on the namespace, by the operation a program would use:
 * a directory is made with its parents, as the wave's directories are, and
 * one already there is kept; a file is written whole (its mode, less the
 * umask, when it creates it); a link replaces what is at its name; a
 * removal takes the subtree, and a name already gone is not an error.
 */
async function applyRoutedRecord(namespace, record) {
    switch (record.type) {
        case 'directory':
            await namespace.mkdir(record.path, { recursive: true, mode: record.mode });
            return;
        case 'file':
            await namespace.writeFile(record.path, record.bytes, { mode: record.mode });
            return;
        case 'symlink':
            if ((await namespace.stat(record.path, { follow: false })) !== null)
                await namespace.unlink(record.path);
            await namespace.symlink(record.target, record.path);
            return;
        case 'delete':
            if ((await namespace.stat(record.path, { follow: false })) !== null)
                await namespace.removeRecursive(record.path);
            return;
    }
}
/** POSIX access(2) modes. */
export const F_OK = 0, X_OK = 1, W_OK = 2, R_OK = 4;
/**
 * A process's namespace as a `VFS` over its bound bridge, plus the process
 * syscalls a `VFS` has no word for (access, realpath, append). Absent is
 * null from `stat`; every failure is a `VfsError`.
 */
export class ProcessView {
    process;
    constructor(
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    process) {
        this.process = process;
    }
    /** `run`, a bridge failure reported as Node's error for `syscall` on `path` (and `dest`). */
    call(syscall, path, run, dest) {
        try {
            const result = run();
            return result instanceof Promise ? result.catch((error) => { throw toVfsError(error, syscall, path, dest); }) : result;
        }
        catch (error) {
            throw toVfsError(error, syscall, path, dest);
        }
    }
    async stat(path, options) {
        const stat = await this.call(options?.follow === false ? 'lstat' : 'stat', path, () => this.process.stat(path, { followSymlinks: options?.follow !== false }));
        return stat === null ? null : vfsStatOf(stat);
    }
    /** Probes need only the bridge's type, not another converted stat object. */
    async probe(path, follow) {
        try {
            return await this.process.stat(path, { followSymlinks: follow });
        }
        catch (error) {
            const failure = toVfsError(error, follow ? 'stat' : 'lstat', path);
            if (isVfsError(failure, 'ENOTDIR'))
                return null;
            throw failure;
        }
    }
    /** Whether anything is at `path` (links followed). */
    async exists(path) { return (await this.probe(path, true)) !== null; }
    async isFile(path) { return (await this.probe(path, true))?.type === 'file'; }
    async isDirectory(path) { return (await this.probe(path, true))?.type === 'directory'; }
    /** Whether `path` itself is a symbolic link. */
    async isSymlink(path) { return (await this.probe(path, false))?.type === 'symlink'; }
    /** The file's bytes as UTF-8 text. */
    async readFileString(path) { return await readText(this, path); }
    async readFile(path) {
        const bytes = await this.call('open', path, () => this.process.readFile(path));
        if (bytes === null)
            throw syscallError('ENOENT', 'open', path);
        return bytes;
    }
    /**
     * Text is written as UTF-8, as a process's write(2) of a string would.
     * `mode` applies only if this creates the file, and at creation
     * (open(O_CREAT|O_TRUNC, mode), then the bytes): an existing file keeps its
     * mode, and a new one is never visible at another mode.
     */
    async writeFile(path, data, options) {
        if (options?.mode === undefined) {
            await this.call('open', path, () => this.process.writeFile(path, data));
            return;
        }
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await this.call('open', path, async () => {
            const handle = await this.process.open(path, { write: true, create: true, truncate: true, mode: options.mode });
            try {
                let offset = 0;
                while (offset < bytes.length) {
                    const written = await this.process.write(handle.id, offset, bytes.subarray(offset));
                    if (written <= 0)
                        throw syscallError('EIO', 'write', path, { detail: 'short write' });
                    offset += written;
                }
            }
            finally {
                await this.process.close(handle.id);
            }
        });
    }
    async readdir(path) {
        const entries = await this.call('scandir', path, () => this.process.readdir(path));
        return entries.map((entry) => ({ name: entry.name, type: entry.type }));
    }
    async mkdir(path, options) {
        await this.call('mkdir', path, () => this.process.mkdir(path, options));
    }
    async unlink(path) { await this.call('unlink', path, () => this.process.unlink(path)); }
    async rmdir(path) { await this.call('rmdir', path, () => this.process.rmdir(path)); }
    async rename(from, to) { await this.call('rename', from, () => this.process.rename(from, to), to); }
    async readRange(path, offset, length) {
        const bytes = await this.call('open', path, () => this.process.readRange(path, offset, length));
        if (bytes === null)
            throw syscallError('ENOENT', 'open', path);
        return bytes;
    }
    /** A ranged read that neither consults nor fills the session's content cache. */
    async readRangeUncached(path, offset, length) {
        const bytes = await this.call('open', path, () => this.process.readRange(path, offset, length, { cached: false }));
        if (bytes === null)
            throw syscallError('ENOENT', 'open', path);
        return bytes;
    }
    async writeRange(path, offset, bytes) {
        await this.call('open', path, () => this.process.writeRange(path, offset, bytes));
    }
    /** writeFile of `size` bytes that arrive over time, published whole once they have (RuntimeFsBridge.writeFileFrom). */
    async writeFileFrom(path, size, source) {
        await this.call('open', path, () => this.process.writeFileFrom(path, size, source));
    }
    async truncate(path, size) { await this.call('open', path, () => this.process.truncate(path, size)); }
    /**
     * rm -r: what went, by the roots removed, what is still there, and why.
     * The engine removes a tree in one step or refuses it whole, so its report
     * is the operand or the refusal.
     */
    async removeRecursive(path) {
        try {
            await this.process.remove(path, { recursive: true });
            return { removed: [path], kept: [], failures: [] };
        }
        catch (error) {
            const converted = toVfsError(error, 'rm', path);
            if (!(converted instanceof VfsError) || converted.code === 'ENOENT')
                throw converted;
            const failure = { path, error: converted };
            return { removed: [], kept: [path], failures: [failure] };
        }
    }
    async symlink(target, path) { await this.call('symlink', target, () => this.process.symlink(target, path), path); }
    async readlink(path) {
        const target = await this.call('readlink', path, () => this.process.readlink(path));
        if (target === null)
            throw syscallError('EINVAL', 'readlink', path);
        return target;
    }
    /** Where the link at `path`, reading `link`, leads in this namespace (RuntimeFsBridge.linkLeadsTo), for a caller following it itself. */
    async linkLeadsTo(path, link) { return await this.process.linkLeadsTo(path, link); }
    async chmod(path, mode) { await this.call('chmod', path, () => this.process.chmod(path, mode)); }
    /** chown(2): a null side keeps what the file has (chown -1). */
    async chown(path, uid, gid) {
        await this.call('chown', path, async () => {
            if (uid === null || gid === null) {
                const stat = await this.process.stat(path);
                if (stat === null)
                    throw syscallError('ENOENT', 'chown', path);
                uid ??= stat.uid;
                gid ??= stat.gid;
            }
            await this.process.chown(path, uid, gid);
        });
    }
    /**
     * utimensat(2): null is now, undefined leaves that time (only those need
     * no more than write permission or ownership); an explicit time needs
     * ownership. `follow: false` sets a link's own times.
     */
    async utimes(path, atimeMs, mtimeMs, options) {
        await this.call(options?.follow === false ? 'lutime' : 'utime', path, () => this.process.utimes(path, atimeMs, mtimeMs, { followSymlinks: options?.follow !== false }));
    }
    /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
    async copy(from, to, options) {
        return await this.call(options?.recursive ? 'cp' : 'copyfile', from, async () => {
            if (options?.recursive)
                return await this.process.copyTree(from, to, { preserve: options.preserve });
            await this.process.copyFile(from, to);
            return 1;
        }, to);
    }
    /** Create the file if absent, and set its times to now (touch). */
    async touch(path) {
        await this.call('open', path, async () => {
            const handle = await this.process.open(path, { write: true, create: true });
            await this.process.close(handle.id);
            // UTIME_NOW: write permission is enough, as for touch(1).
            await this.process.utimes(path, null, null);
        });
    }
    /** The file's bytes read around the session's content cache, re-checked for a change mid-read. */
    async readFileUncached(path) {
        return new Uint8Array(await this.readArrayBufferUncached(path));
    }
    /** {@link readFileUncached} as the ArrayBuffer a wasm module map takes, so a runtime image is held once. */
    async readArrayBufferUncached(path) {
        const stat = await this.stat(path);
        if (stat === null)
            throw syscallError('ENOENT', 'open', path);
        const buffer = new ArrayBuffer(stat.size);
        const result = new Uint8Array(buffer);
        for (let offset = 0; offset < result.length;) {
            const bytes = await this.readRangeUncached(path, offset, Math.min(65536, result.length - offset));
            if (bytes.length === 0)
                throw syscallError('ESTALE', 'read', path, { detail: 'changed during the read' });
            result.set(bytes, offset);
            offset += bytes.length;
        }
        return buffer;
    }
    /**
     * rm: a file, or with `recursive` a tree, whole or not at all; `force`
     * makes a missing path no error.
     */
    async remove(path, options = {}) {
        await this.call('rm', path, () => this.process.remove(path, options));
    }
    /** Each entry of a directory with its own stat (links not followed): ls -l, find, du. */
    async readdirStat(path) {
        const entries = await this.readdir(path);
        const base = path.endsWith('/') ? path : `${path}/`;
        const out = [];
        for (const entry of entries) {
            const stat = await this.stat(base + entry.name, { follow: false });
            if (stat !== null)
                out.push({ ...stat, name: entry.name });
        }
        return out;
    }
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    async access(path, mode) { await this.call('access', path, () => this.process.access(path, mode)); }
    async realpath(path) { return await this.call('realpath', path, () => this.process.realpath(path)); }
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    async appendFile(path, content) {
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        await this.call('open', path, async () => {
            const handle = await this.process.open(path, { write: true, append: true, create: true });
            try {
                let offset = 0;
                while (offset < data.length) {
                    const written = await this.process.write(handle.id, null, data.subarray(offset));
                    if (written <= 0 || written > data.length - offset)
                        throw syscallError('EIO', 'write', path, { detail: 'short append' });
                    offset += written;
                }
            }
            finally {
                await this.process.close(handle.id);
            }
        });
    }
}
function vfsStatOf(stat) {
    return {
        type: stat.type, size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid,
        mtimeMs: stat.mtime, atimeMs: stat.atime, ctimeMs: stat.ctime,
        ino: stat.ino, nlink: stat.nlink, dev: stat.dev, revision: stat.revision,
    };
}
/**
 * The namespace, synchronously, in the engine's call shape (the subset host
 * code uses): `stat` throws ENOENT when absent, paths may omit the leading
 * slash, and every failure carries its POSIX code.
 */
export class NamespaceFs {
    fs;
    cred;
    constructor(fs, cred) {
        this.fs = fs;
        this.cred = cred;
    }
    probe(path, follow) {
        try {
            return this.fs.stat(path, { followSymlinks: follow });
        }
        catch (error) {
            if (error.code === 'ENOTDIR')
                return null;
            throw error;
        }
    }
    exists(path) { return this.probe(path, true) !== null; }
    isDirectory(path) { return this.probe(path, true)?.type === 'directory'; }
    isFile(path) { return this.probe(path, true)?.type === 'file'; }
    isSymlink(path) { return this.probe(path, false)?.type === 'symlink'; }
    stat(path) {
        const stat = this.fs.stat(path, { followSymlinks: true });
        if (stat === null)
            throw syscallError('ENOENT', 'stat', path);
        return stat;
    }
    lstat(path) {
        const stat = this.fs.stat(path, { followSymlinks: false });
        if (stat === null)
            throw syscallError('ENOENT', 'lstat', path);
        return stat;
    }
    access(path, mode) { this.fs.access(path, mode); }
    readFile(path) {
        const bytes = this.fs.readFile(path);
        if (bytes === null)
            throw syscallError('ENOENT', 'open', path);
        return bytes;
    }
    readFileString(path) { return new TextDecoder().decode(this.readFile(path)); }
    readRange(path, offset, length) {
        const bytes = this.fs.readRange(path, offset, length);
        if (bytes === null)
            throw syscallError('ENOENT', 'open', path);
        return bytes;
    }
    /** `mode` applies only if this creates the file, at creation. */
    writeFile(path, content, options) {
        if (options?.mode === undefined) {
            this.fs.writeFile(path, content);
            return;
        }
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        const handle = this.fs.open(path, { write: true, create: true, truncate: true, mode: options.mode });
        try {
            for (let offset = 0; offset < bytes.length;) {
                const written = this.fs.write(handle.id, offset, bytes.subarray(offset));
                if (written <= 0)
                    throw syscallError('EIO', 'write', path, { detail: 'short write' });
                offset += written;
            }
        }
        finally {
            this.fs.close(handle.id);
        }
    }
    mkdir(path, options) { this.fs.mkdir(path, options); }
    readdir(path) { return this.fs.readdir(path); }
    unlink(path) { this.fs.unlink(path); }
    rmdir(path) { this.fs.rmdir(path); }
    removeRecursive(path) { this.fs.remove(path, { recursive: true }); }
    rename(from, to) { this.fs.rename(from, to); }
    symlink(target, path) { this.fs.symlink(target, path); }
    readlink(path) {
        const target = this.fs.readlink(path);
        if (target === null)
            throw syscallError('EINVAL', 'readlink', path);
        return target;
    }
    /** Where a path's links lead (links followed), or null for a cycle. */
    resolveSymlink(path) {
        try {
            return this.fs.realpath(path).replace(/^\/+/, '');
        }
        catch (error) {
            if (error.code === 'ELOOP')
                return null;
            throw error;
        }
    }
    chmod(path, mode) { this.fs.chmod(path, mode); }
    chown(path, uid, gid) {
        if (uid === null || gid === null) {
            const stat = this.stat(path);
            uid ??= stat.uid;
            gid ??= stat.gid;
        }
        this.fs.chown(path, uid, gid);
    }
    utimes(path, atimeMs, mtimeMs, options) {
        this.fs.utimes(path, atimeMs, mtimeMs, options);
    }
    copyFile(from, to) { this.fs.copyFile(from, to); }
    acquireExclusiveMutation(path, options) {
        return this.fs.acquireExclusiveMutation(path, options);
    }
    releaseExclusiveMutation(owner) { this.fs.releaseExclusiveMutation(owner); }
}
