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
import { toVfsError, VfsError } from '../vfs/vfs-error.js';
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
    bridgeFor(scope, cred, signal, pid) {
        const target = new SqliteRuntimeFsBridge(this.engine.as(cred), this.engine, scope, this.vfs.as(cred), this.mountedIno);
        return new GuardedProcessBridge(target, scope, signal, pid);
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
    async call(path, run) {
        try {
            return await run();
        }
        catch (error) {
            throw toVfsError(error, path);
        }
    }
    async stat(path, options) {
        const stat = await this.call(path, () => this.process.stat(path, { followSymlinks: options?.follow !== false }));
        return stat === null ? null : vfsStatOf(stat);
    }
    async readFile(path) {
        const bytes = await this.call(path, () => this.process.readFile(path));
        if (bytes === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
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
            await this.call(path, () => this.process.writeFile(path, data));
            return;
        }
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await this.call(path, async () => {
            const handle = await this.process.open(path, { write: true, create: true, truncate: true, mode: options.mode });
            try {
                let offset = 0;
                while (offset < bytes.length) {
                    const written = await this.process.write(handle.id, offset, bytes.subarray(offset));
                    if (written <= 0)
                        throw new VfsError('EIO', 'short write', path);
                    offset += written;
                }
            }
            finally {
                await this.process.close(handle.id);
            }
        });
    }
    async readdir(path) {
        const entries = await this.call(path, () => this.process.readdir(path));
        return entries.map((entry) => ({ name: entry.name, type: entry.type }));
    }
    async mkdir(path, options) {
        await this.call(path, () => this.process.mkdir(path, options));
    }
    async unlink(path) { await this.call(path, () => this.process.unlink(path)); }
    async rmdir(path) { await this.call(path, () => this.process.rmdir(path)); }
    async rename(from, to) { await this.call(from, () => this.process.rename(from, to)); }
    async readRange(path, offset, length) {
        const bytes = await this.call(path, () => this.process.readRange(path, offset, length));
        if (bytes === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        return bytes;
    }
    /** A ranged read that neither consults nor fills the session's content cache. */
    async readRangeUncached(path, offset, length) {
        const bytes = await this.call(path, () => this.process.readRange(path, offset, length, { cached: false }));
        if (bytes === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        return bytes;
    }
    async writeRange(path, offset, bytes) {
        await this.call(path, () => this.process.writeRange(path, offset, bytes));
    }
    async truncate(path, size) { await this.call(path, () => this.process.truncate(path, size)); }
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
            const converted = toVfsError(error, path);
            if (!(converted instanceof VfsError) || converted.code === 'ENOENT')
                throw converted;
            const failure = { path, error: converted };
            return { removed: [], kept: [path], failures: [failure] };
        }
    }
    async symlink(target, path) { await this.call(path, () => this.process.symlink(target, path)); }
    async readlink(path) {
        const target = await this.call(path, () => this.process.readlink(path));
        if (target === null)
            throw new VfsError('EINVAL', 'not a symbolic link', path);
        return target;
    }
    async chmod(path, mode) { await this.call(path, () => this.process.chmod(path, mode)); }
    /** chown(2): a null side keeps what the file has (chown -1). */
    async chown(path, uid, gid) {
        await this.call(path, async () => {
            if (uid === null || gid === null) {
                const stat = await this.process.stat(path);
                if (stat === null)
                    throw new VfsError('ENOENT', 'no such file or directory', path);
                uid ??= stat.uid;
                gid ??= stat.gid;
            }
            await this.process.chown(path, uid, gid);
        });
    }
    async utimes(path, atimeMs, mtimeMs) {
        await this.call(path, () => this.process.utimes(path, atimeMs, mtimeMs));
    }
    /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
    async copy(from, to, options) {
        return await this.call(from, async () => {
            if (options?.recursive)
                return await this.process.copyTree(from, to, { preserve: options.preserve });
            await this.process.copyFile(from, to);
            return 1;
        });
    }
    /** Create the file if absent, and set its times to now (touch). */
    async touch(path) {
        await this.call(path, async () => {
            const handle = await this.process.open(path, { write: true, create: true });
            await this.process.close(handle.id);
            const now = Date.now();
            await this.process.utimes(path, now, now);
        });
    }
    /** The file's bytes read around the session's content cache, re-checked for a change mid-read. */
    async readFileUncached(path) {
        const stat = await this.stat(path);
        if (stat === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        const result = new Uint8Array(stat.size);
        for (let offset = 0; offset < result.length;) {
            const bytes = await this.readRangeUncached(path, offset, Math.min(65536, result.length - offset));
            if (bytes.length === 0)
                throw new VfsError('ESTALE', 'changed during the read', path);
            result.set(bytes, offset);
            offset += bytes.length;
        }
        return result;
    }
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    async access(path, mode) { await this.call(path, () => this.process.access(path, mode)); }
    async realpath(path) { return await this.call(path, () => this.process.realpath(path)); }
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    async appendFile(path, content) {
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        await this.call(path, async () => {
            const handle = await this.process.open(path, { write: true, append: true, create: true });
            try {
                let offset = 0;
                while (offset < data.length) {
                    const written = await this.process.write(handle.id, null, data.subarray(offset));
                    if (written <= 0 || written > data.length - offset)
                        throw new VfsError('EIO', 'short append', path);
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
