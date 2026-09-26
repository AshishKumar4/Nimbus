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
import { CompositeVFS } from '../vfs/composite.js';
import { DevVFS } from '../vfs/dev-vfs.js';
import { standardProc } from '../vfs/proc-vfs.js';
import { sqliteFiles } from '../vfs/sqlite-files.js';
import { formatProcMounts } from '../shell/mount-commands.js';
import { CRED_KERNEL, requireVfsCred, } from './os-contracts.js';
import { createSqliteDescriptorScope, SqliteRuntimeFsBridge, } from './sqlite-runtime-fs-bridge.js';
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
    constructor(target, scope, signal, pid) {
        this.target = target;
        this.scope = scope;
        this.signal = signal;
        this.pid = pid;
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
    readFile(path, options) { this.guard(); return this.target.readFile(path, options); }
    writeFile(path, bytes, options) {
        this.guard();
        return this.target.writeFile(path, bytes, options);
    }
    readRange(path, offset, length, options) {
        this.guard();
        return this.target.readRange(path, offset, length, options);
    }
    writeRange(path, offset, bytes, options) {
        this.guard();
        return this.target.writeRange(path, offset, bytes, options);
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
    read(handleId, offset, length) { this.guard(); return this.target.read(handleId, offset, length); }
    write(handleId, offset, bytes) { this.guard(); return this.target.write(handleId, offset, bytes); }
    close(handleId) { return this.target.close(handleId); }
    readdir(path, options) { this.guard(); return this.target.readdir(path, options); }
    mkdir(path, options) { this.guard(); return this.target.mkdir(path, options); }
    unlink(path) { this.guard(); return this.target.unlink(path); }
    rmdir(path) { this.guard(); return this.target.rmdir(path); }
    rename(from, to) { this.guard(); return this.target.rename(from, to); }
    readlink(path) { this.guard(); return this.target.readlink(path); }
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
    retired = new Set();
    /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
    mountedInos = new Map();
    mountedIno = (path) => {
        let ino = this.mountedInos.get(path);
        if (ino === undefined)
            this.mountedInos.set(path, ino = this.mountedInos.size + 1);
        return ino;
    };
    constructor(engine) {
        this.engine = engine;
        this.namespace = engine.namespace;
        this.vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
        this.proc = standardProc();
        this.proc.register('mounts', (cred) => formatProcMounts(this.mounts(cred ?? CRED_KERNEL)));
        this.vfs.mount('/proc', this.proc);
        this.vfs.mount('/dev', new DevVFS());
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
        return this.view(scope, immutableCredential(cred), signal, pid);
    }
    openHost(cred, options = {}) {
        const scope = createSqliteDescriptorScope();
        const fs = this.view(scope, immutableCredential(cred), options.signal);
        return { fs, dispose: async () => this.closeScope(scope) };
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
        const scope = this.processes.get(pid);
        if (scope)
            this.closeScope(scope);
        this.processes.delete(pid);
        this.engine.revokeAppendWriters(pid);
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
    closeScope(scope) {
        if (scope.closed)
            return;
        for (const opened of scope.handles.values()) {
            if (--opened.refs === 0)
                opened.node.close();
        }
        scope.handles.clear();
        for (const dispose of scope.subscriptions)
            dispose();
        scope.subscriptions.clear();
        scope.closed = true;
        scope.abort.abort();
    }
    view(scope, cred, signal, pid) {
        const target = new SqliteRuntimeFsBridge(this.engine.as(cred), this.engine, scope, this.vfs.as(cred), this.mountedIno);
        return new GuardedProcessBridge(target, scope, signal, pid);
    }
}
