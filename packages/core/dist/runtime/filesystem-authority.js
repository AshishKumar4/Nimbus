import { SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import { requireVfsCred, } from './os-contracts.js';
import { createSqliteDescriptorScope, SqliteRuntimeFsBridge, } from './sqlite-runtime-fs-bridge.js';
function immutableCredential(cred) {
    const valid = requireVfsCred(cred, 'filesystem binding');
    return Object.freeze({ ...valid, groups: Object.freeze([...valid.groups]) });
}
/**
 * Abort a stream commit when ANY of the given signals fires. AbortSignal.any
 * is not in every runtime this code ships to, so the combination is a small
 * linked controller instead.
 */
function linkedSignal(signals) {
    const live = signals.filter((signal) => signal !== undefined);
    const controller = new AbortController();
    const fire = () => controller.abort(live.find(signal => signal.aborted)?.reason);
    for (const signal of live) {
        if (signal.aborted) {
            fire();
            break;
        }
        signal.addEventListener('abort', fire, { once: true });
    }
    return {
        signal: controller.signal,
        dispose: () => { for (const signal of live)
            signal.removeEventListener('abort', fire); },
    };
}
/**
 * The authority's per-binding view: same namespace, credentials and
 * descriptor scope as the wrapped bridge, with three checks at the door.
 * Abort first (the caller revoked), then a closed scope (EBADF, the POSIX
 * answer for an operation on a released descriptor table), then the
 * append-process identity check (a bound process may only speak for its own
 * pid). Explicit delegation, not a Proxy: the bridge contract is fixed and
 * the checks read where they run.
 */
class SqliteGuardedFsBridge {
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
        if (this.scope.closed) {
            throw Object.assign(new Error('EBADF: filesystem scope closed'), { code: 'EBADF' });
        }
    }
    stat(path, options) {
        this.guard();
        return this.target.stat(path, options);
    }
    readFile(path, options) {
        this.guard();
        return this.target.readFile(path, options);
    }
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
    truncate(path, size, options) {
        this.guard();
        return this.target.truncate(path, size, options);
    }
    utimes(path, atimeMs, mtimeMs, options) {
        this.guard();
        return this.target.utimes(path, atimeMs, mtimeMs, options);
    }
    chmod(path, mode) {
        this.guard();
        return this.target.chmod(path, mode);
    }
    access(path, mode) {
        this.guard();
        return this.target.access(path, mode);
    }
    chown(path, uid, gid, options) {
        this.guard();
        return this.target.chown(path, uid, gid, options);
    }
    open(path, flags) {
        this.guard();
        return this.target.open(path, flags);
    }
    read(handleId, offset, length) {
        this.guard();
        return this.target.read(handleId, offset, length);
    }
    write(handleId, offset, bytes) {
        this.guard();
        return this.target.write(handleId, offset, bytes);
    }
    close(handleId) {
        return this.target.close(handleId);
    }
    readdir(path, options) {
        this.guard();
        return this.target.readdir(path, options);
    }
    mkdir(path, options) {
        this.guard();
        return this.target.mkdir(path, options);
    }
    unlink(path) {
        this.guard();
        return this.target.unlink(path);
    }
    rmdir(path) {
        this.guard();
        return this.target.rmdir(path);
    }
    rename(from, to) {
        this.guard();
        return this.target.rename(from, to);
    }
    readlink(path) {
        this.guard();
        return this.target.readlink(path);
    }
    symlink(target, path) {
        this.guard();
        return this.target.symlink(target, path);
    }
    fsync(handleId) {
        this.guard();
        return this.target.fsync(handleId);
    }
    revision(path) {
        this.guard();
        return this.target.revision(path);
    }
    acquire(epoch, cursor) {
        this.guard();
        return this.target.acquire(epoch, cursor);
    }
    list(after, limit) {
        this.guard();
        return this.target.list(after, limit);
    }
    subscribe(path, listener) {
        this.guard();
        const unsubscribe = this.target.subscribe(path, listener);
        const dispose = () => { unsubscribe(); this.scope.subscriptions.delete(dispose); };
        this.scope.subscriptions.add(dispose);
        return dispose;
    }
    realpath(path) {
        this.guard();
        return this.target.realpath(path);
    }
    remove(path, options) {
        this.guard();
        return this.target.remove(path, options);
    }
    copyFile(from, to) {
        this.guard();
        return this.target.copyFile(from, to);
    }
    fstat(handleId) {
        this.guard();
        return this.target.fstat(handleId);
    }
    dup(handleId) {
        this.guard();
        return this.target.dup(handleId);
    }
    seek(handleId, offset, whence) {
        this.guard();
        return this.target.seek(handleId, offset, whence);
    }
    setStatus(handleId, status) {
        this.guard();
        return this.target.setStatus(handleId, status);
    }
    readdirHandle(handleId) {
        this.guard();
        return this.target.readdirHandle(handleId);
    }
    ftruncate(handleId, size) {
        this.guard();
        return this.target.ftruncate(handleId, size);
    }
    fchmod(handleId, mode) {
        this.guard();
        return this.target.fchmod(handleId, mode);
    }
    fchown(handleId, uid, gid) {
        this.guard();
        return this.target.fchown(handleId, uid, gid);
    }
    futimes(handleId, atimeMs, mtimeMs) {
        this.guard();
        return this.target.futimes(handleId, atimeMs, mtimeMs);
    }
    appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes) {
        this.guard();
        if (this.pid === undefined || pid !== this.pid) {
            throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
        }
        return this.target.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes);
    }
    acknowledgeAppend(pid, writerId, moduleId, operationId) {
        this.guard();
        if (this.pid === undefined || pid !== this.pid) {
            throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
        }
        return this.target.acknowledgeAppend(pid, writerId, moduleId, operationId);
    }
    writeBatch(payload) {
        this.guard();
        return this.target.writeBatch(payload);
    }
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
    releaseExclusiveMutation(owner) {
        this.guard();
        return this.target.releaseExclusiveMutation(owner);
    }
}
/** The default authority owns descriptor scopes, not the host's database lifetime. */
export class SqliteFilesystemAuthority {
    vfs;
    kernel;
    namespace;
    processes = new Map();
    retired = new Set();
    /** The disk this authority credentials; a host composing over the same
     *  session reads it here instead of tracking a second reference. */
    constructor(vfs, kernel) {
        this.vfs = vfs;
        this.kernel = kernel;
        this.namespace = vfs.namespace;
    }
    attachKernel(kernel) {
        this.kernel = kernel;
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
    async releaseProcess(pid) {
        this.retired.add(pid);
        const scope = this.processes.get(pid);
        if (scope)
            this.closeScope(scope);
        this.processes.delete(pid);
        this.vfs.revokeAppendWriters(pid);
    }
    async activateAppendWriter(pid, writerId) {
        if (this.retired.has(pid))
            throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
        this.vfs.activateAppendWriter(pid, writerId);
    }
    async revokeAppendWriter(pid, writerId) { this.vfs.revokeAppendWriter(pid, writerId); }
    async revokeAppendWriters(pid) { this.vfs.revokeAppendWriters(pid); }
    async revokeAppendWritersThrough(maxPid) { this.vfs.revokeAppendWritersThrough(maxPid); }
    /**
     * The kernel's mount table. Its SQLite directories are one store, listed
     * once as `/` (numbers: {@link SqliteVFS.storageUsage}); every other kernel
     * mount (/proc, /dev, an embedder's) as its provider describes it.
     */
    mounts(_cred) {
        const vfs = this.vfs;
        const entries = [
            { mountPoint: '/', source: 'nimbus', type: 'nimbus-sqlite', options: ['rw'], usage: async () => vfs.storageUsage() },
        ];
        for (const { path, provider } of this.kernel?.mountTable() ?? []) {
            if (provider instanceof SqliteVFSProvider)
                continue;
            const described = provider.describeMount?.();
            entries.push({
                mountPoint: path,
                source: described?.source ?? 'none',
                type: described?.type ?? 'kernel',
                options: described?.options,
                usage: async () => (await described?.usage?.()) ?? null,
            });
        }
        return entries;
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
        const target = new SqliteRuntimeFsBridge(this.vfs.as(cred), this.vfs, scope, () => this.kernel?.as(cred));
        return new SqliteGuardedFsBridge(target, scope, signal, pid);
    }
}
