import { SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
export function createSqliteDescriptorScope() {
    return { nextId: 1, handles: new Map(), closed: false, abort: new AbortController(), subscriptions: new Set() };
}
export class SqliteRuntimeFsBridge {
    rawVfs;
    scope;
    getKernel;
    synchronous = this;
    legacySymlinks;
    vfs;
    constructor(vfs, rawVfs, scope = createSqliteDescriptorScope(), getKernel) {
        this.rawVfs = rawVfs;
        this.scope = scope;
        this.getKernel = getKernel;
        this.vfs = vfs;
        this.legacySymlinks = getSymlinkRegistry(rawVfs);
    }
    get kernel() { return this.getKernel?.(); }
    dispose() {
        for (const id of this.scope.handles.keys())
            this.close(id);
        this.scope.closed = true;
        this.scope.abort.abort();
    }
    /**
     * Where a path lives, decided only after confinement: a kernel mount is
     * consulted with the fully resolved path, so a `..` or an absolute path
     * inside a capability can never reach `/proc` or `/dev` sideways.
     */
    locate(path, followSymlinks) {
        const resolved = this.resolveDataPath(path, followSymlinks);
        if (resolved === null)
            return null;
        const kernel = this.kernel;
        if (!kernel)
            return { path: resolved };
        const provider = kernel.getProvider('/' + resolved);
        if (provider && !(provider.provider instanceof SqliteVFSProvider))
            return { mount: kernel, path: '/' + resolved };
        return { path: resolved };
    }
    virtualStat(mount, path) {
        const stat = mount.stat(path);
        return { ...stat, dev: 0, ino: mount.inodeIdentity(path), nlink: 1, atime: stat.mtime, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: 0 };
    }
    /** SQLite stores no row for the namespace root; it is the one directory that always exists. */
    rootStat() {
        if (this.kernel)
            return this.virtualStat(this.kernel, '/');
        const now = Date.now();
        return {
            dev: this.rawVfs.deviceId, ino: 0, nlink: 1, type: 'directory', size: 0,
            ctime: now, atime: now, mtime: now, mode: 0o40755, uid: 0, gid: 0,
            revision: this.rawVfs.revision(),
        };
    }
    stat(path, options = {}) {
        const followSymlinks = options.followSymlinks !== false;
        const located = this.locate(path, followSymlinks);
        if (located === null)
            return null;
        if (located.mount)
            return located.mount.exists(located.path) ? this.virtualStat(located.mount, located.path) : null;
        const p = located.path;
        if (p === '')
            return this.rootStat();
        if (!followSymlinks && !this.vfs.exists(p)) {
            const target = this.legacySymlinks.readlink(p);
            if (target === null)
                return null;
            const now = Date.now();
            return {
                dev: this.rawVfs.deviceId,
                ino: 0,
                nlink: 1,
                type: 'symlink',
                size: new TextEncoder().encode(target).byteLength,
                ctime: now,
                atime: now,
                mtime: now,
                mode: 0o120777,
                uid: 1000,
                gid: 1000,
                revision: this.vfs.revision(p),
            };
        }
        try {
            const st = followSymlinks ? this.vfs.stat(p) : this.vfs.lstat(p);
            const type = st.type === 'directory'
                ? 'directory'
                : st.type === 'symlink'
                    ? 'symlink'
                    : 'file';
            return {
                dev: st.dev, ino: st.ino, nlink: st.nlink,
                type,
                size: st.size,
                ctime: st.ctime,
                atime: st.atime,
                mtime: st.mtime,
                mode: type === 'symlink' ? 0o120000 | (st.mode & 0o777) : st.mode,
                uid: st.uid,
                gid: st.gid,
                revision: this.vfs.revision(p),
            };
        }
        catch (error) {
            if (hasErrorCode(error, 'ENOENT'))
                return null;
            throw error;
        }
    }
    readFile(path, options = {}) {
        const located = this.locate(path, options.followSymlinks !== false);
        if (located === null)
            return null;
        try {
            return located.mount ? located.mount.readFile(located.path) : this.vfs.readFile(located.path);
        }
        catch (error) {
            if (hasErrorCode(error, 'ENOENT'))
                return null;
            throw error;
        }
    }
    writeFile(path, bytes, options = {}) {
        const located = this.locateMutation(path, true, 'write');
        if (located.mount) {
            if (options.expectedRevision !== undefined)
                throw fsError('ESTALE', 'write', path);
            located.mount.writeFile(located.path, bytes);
            return this.rawVfs.revision();
        }
        const p = located.path;
        this.assertExpectedRevision(p, options.expectedRevision);
        if (options.createParents !== false)
            this.ensureParent(p);
        this.vfs.writeFile(p, bytes);
        // Read back in the same synchronous turn as the mutation, so nothing can
        // interleave: this is exactly the revision this write produced. Asking
        // again after an await would report a peer's clock as our own.
        return this.rawVfs.revision();
    }
    readRange(path, offset, length, options = {}) {
        if ((options.expectedEpoch === undefined) !== (options.expectedRevision === undefined)) {
            throw fsError('EINVAL', 'read', path);
        }
        const located = this.locate(path, options.followSymlinks !== false);
        if (located === null)
            return null;
        if (located.mount) {
            if (options.expectedEpoch !== undefined)
                throw fsError('ESTALE', 'read', path);
            return located.mount.readRange(located.path, offset, length);
        }
        const p = located.path;
        if (options.expectedEpoch !== undefined && (options.expectedEpoch !== this.rawVfs.epoch
            || options.expectedRevision !== this.vfs.revision(p))) {
            throw fsError('ESTALE', 'read', path);
        }
        try {
            return options.cached === false
                ? this.vfs.readRangeUncached(p, offset, length)
                : this.vfs.readRange(p, offset, length);
        }
        catch (error) {
            if (hasErrorCode(error, 'ENOENT'))
                return null;
            throw error;
        }
    }
    writeRange(path, offset, bytes, options = {}) {
        const located = this.locateMutation(path, true, 'write');
        if (located.mount) {
            if (options.expectedRevision !== undefined)
                throw fsError('ESTALE', 'write', path);
            located.mount.writeRange(located.path, offset, bytes);
            return this.mountReceipt();
        }
        const p = located.path;
        this.assertExpectedRevision(p, options.expectedRevision);
        if (this.vfs.isDirectory(p))
            throw fsError('EISDIR', 'write', path);
        if (options.createParents !== false)
            this.ensureParent(p);
        return this.receipted(p, () => this.vfs.writeRange(p, offset, bytes));
    }
    appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes) {
        return this.vfs.appendOnce(this.sqlitePath(path, true, 'append'), pid, writerId, moduleId, operationId, digest, bytes);
    }
    acknowledgeAppend(pid, writerId, moduleId, operationId) {
        this.vfs.acknowledgeAppend(pid, writerId, moduleId, operationId);
    }
    truncate(path, size, options = {}) {
        const located = this.locateMutation(path, options.followSymlinks !== false, 'truncate');
        if (located.mount) {
            located.mount.truncate(located.path, size);
            return this.mountReceipt();
        }
        const p = located.path;
        if (!this.vfs.exists(p))
            throw fsError('ENOENT', 'truncate', path);
        if (this.vfs.isDirectory(p))
            throw fsError('EISDIR', 'truncate', path);
        return this.receipted(p, () => this.vfs.truncate(p, size));
    }
    utimes(path, atimeMs, mtimeMs, options = {}) {
        const located = this.locateMutation(path, options.followSymlinks !== false, 'utimes');
        if (located.mount) {
            located.mount.utimes(located.path, atimeMs, mtimeMs);
            return this.mountReceipt();
        }
        const p = located.path;
        if (!this.vfs.exists(p))
            throw fsError('ENOENT', 'utimes', path);
        return this.receipted(p, () => this.vfs.utimes(p, atimeMs, mtimeMs));
    }
    chmod(path, mode) {
        const located = this.locateMutation(path, true, 'chmod');
        if (located.mount) {
            located.mount.chmod(located.path, mode);
            return this.mountReceipt();
        }
        const p = located.path;
        if (!this.vfs.exists(p))
            throw fsError('ENOENT', 'chmod', path);
        return this.receipted(p, () => this.vfs.chmod(p, mode));
    }
    access(path, mode) {
        const located = this.locate(path, true);
        if (located === null)
            throw fsError('ELOOP', 'access', path);
        if (located.mount)
            located.mount.access(located.path, mode);
        else
            this.vfs.access(located.path, mode);
    }
    chown(path, uid, gid, options = {}) {
        const followSymlinks = options.followSymlinks !== false;
        const located = this.locateMutation(path, followSymlinks, 'chown');
        if (located.mount) {
            located.mount.chown(located.path, uid, gid);
            return this.mountReceipt();
        }
        const p = located.path;
        if (!this.vfs.exists(p))
            throw fsError('ENOENT', 'chown', path);
        return this.receipted(p, () => this.vfs.chown(p, uid, gid, { followSymlinks }));
    }
    open(path, flags) {
        const normalizedFlags = normalizeOpenFlags(flags);
        const mutates = normalizedFlags.write || normalizedFlags.create ||
            normalizedFlags.truncate || normalizedFlags.append;
        const located = mutates
            ? this.locateMutation(path, normalizedFlags.followSymlinks, 'open')
            : this.locate(path, normalizedFlags.followSymlinks);
        if (located === null)
            throw fsError('ELOOP', 'open', path);
        if (located.mount)
            return this.openMount(located.mount, located.path, path, normalizedFlags);
        const p = located.path;
        if (p === '')
            return this.openRoot(path, normalizedFlags);
        // O_NOFOLLOW on a trailing symlink is ELOOP: there is no descriptor to
        // open on the link itself, and what it points at is exactly what the
        // caller declined to open.
        if (!normalizedFlags.followSymlinks && this.vfs.isSymlink(p))
            throw fsError('ELOOP', 'open', path);
        this.assertExpectedRevision(p, normalizedFlags.expectedRevision);
        const exists = this.vfs.exists(p);
        if (normalizedFlags.exclusive && normalizedFlags.create && exists)
            throw fsError('EEXIST', 'open', path);
        if (normalizedFlags.directory && (!exists || !this.vfs.isDirectory(p)))
            throw fsError('ENOTDIR', 'open', path);
        if (!exists && !normalizedFlags.create)
            throw fsError('ENOENT', 'open', path);
        // A directory opens for reading whatever rights were asked for: a WASI
        // guest requests a capability set, not an access mode, and a directory
        // simply never grants fd_write (the write itself answers EISDIR). What
        // refuses here is content the open would change.
        if (exists && this.vfs.isDirectory(p) && (normalizedFlags.truncate || normalizedFlags.append))
            throw fsError('EISDIR', 'open', path);
        if (exists)
            this.vfs.access(p, (normalizedFlags.read ? 4 : 0) | (normalizedFlags.write && !this.vfs.isDirectory(p) ? 2 : 0));
        if (!exists) {
            this.ensureParent(p);
            this.vfs.writeFile(p, new Uint8Array(0), { mode: flags.mode });
        }
        else if (normalizedFlags.truncate) {
            this.vfs.truncate(p, 0);
        }
        const stat = this.vfs.stat(p);
        const node = this.rawVfs.openDescription(p, this.vfs.cred, normalizedFlags);
        const handle = {
            id: this.scope.nextId++,
            path: p,
            flags: Object.freeze(normalizedFlags),
            position: normalizedFlags.append ? stat.size : 0,
            closed: false,
        };
        this.scope.handles.set(handle.id, { handle, node, refs: 1 });
        return { ...handle };
    }
    read(handleId, offset, length) {
        const handle = this.getHandle(handleId);
        if (!handle.flags.read)
            throw fsError('EBADF', 'read', handle.path);
        const start = offset == null ? handle.position : Math.max(0, offset);
        const out = this.description(handleId).node.read(start, Math.max(0, length));
        if (offset == null)
            handle.position = start + out.byteLength;
        return out;
    }
    write(handleId, offset, bytes) {
        const handle = this.getHandle(handleId);
        if (!handle.flags.write)
            throw fsError('EBADF', 'write', handle.path);
        const node = this.description(handleId).node;
        const start = handle.flags.append
            ? node.stat().size
            : offset == null ? handle.position : Math.max(0, offset);
        node.write(start, bytes);
        const end = start + bytes.byteLength;
        if (offset == null || handle.flags.append)
            handle.position = end;
        return bytes.byteLength;
    }
    close(handleId) {
        const opened = this.description(handleId);
        this.scope.handles.delete(handleId);
        if (--opened.refs === 0) {
            opened.handle.closed = true;
            opened.node.close();
        }
    }
    readdir(path, options = {}) {
        const located = this.locate(path, options.followSymlinks !== false);
        if (located === null)
            return [];
        if (located.mount)
            return located.mount.readdir(located.path);
        const p = located.path;
        const entries = new Map();
        if (p === '' && this.kernel) {
            for (const entry of this.kernel.readdir('/'))
                if (this.kernel.getProvider('/' + entry.name))
                    entries.set(entry.name, entry);
        }
        for (const entry of this.vfs.readdir(p)) {
            const type = entry.type === 'directory'
                ? 'directory'
                : entry.type === 'symlink'
                    ? 'symlink'
                    : 'file';
            entries.set(entry.name, { name: entry.name, type });
        }
        const prefix = p ? `${p}/` : '';
        for (const link of this.legacySymlinks.list()) {
            if (parentVfsPath(link.link) !== p)
                continue;
            const name = link.link.slice(prefix.length);
            if (!entries.has(name))
                entries.set(name, { name, type: 'symlink' });
        }
        return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    mkdir(path, options = {}) {
        const located = this.locateMutation(path, false, 'mkdir');
        if (located.mount) {
            located.mount.mkdir(located.path, { recursive: !!options.recursive });
            return;
        }
        const p = located.path;
        if (this.vfs.exists(p)) {
            if (options.recursive && this.vfs.isDirectory(p))
                return;
            throw fsError('EEXIST', 'mkdir', path);
        }
        this.vfs.mkdir(p, { recursive: !!options.recursive, mode: options.mode });
    }
    unlink(path) {
        const located = this.locateMutation(path, false, 'unlink');
        if (located.mount) {
            located.mount.unlink(located.path);
            return;
        }
        const p = located.path;
        if (this.vfs.exists(p)) {
            const staleLegacy = this.legacySymlinks.isSymlink(p);
            if (staleLegacy)
                this.legacySymlinks.assertMutable(p);
            this.vfs.unlink(p);
            if (staleLegacy)
                this.legacySymlinks.delete(p);
            return;
        }
        // A registry-only symlink has no inode of its own; the name still exists.
        if (!this.legacySymlinks.isSymlink(p))
            throw fsError('ENOENT', 'unlink', path);
        this.legacySymlinks.delete(p);
    }
    rmdir(path) {
        const located = this.locateMutation(path, false, 'rmdir');
        if (located.mount) {
            located.mount.rmdir(located.path);
            return;
        }
        const p = located.path;
        if (!this.vfs.isDirectory(p))
            throw fsError('ENOTDIR', 'rmdir', path);
        this.vfs.rmdir(p);
    }
    rename(from, to) {
        const oldPath = this.sqlitePath(from, false, 'rename');
        const newPath = this.sqlitePath(to, false, 'rename');
        if (this.vfs.exists(oldPath)) {
            const staleDestination = this.legacySymlinks.isSymlink(newPath);
            if (staleDestination)
                this.legacySymlinks.assertMutable(newPath);
            this.assertParentDirectory(newPath, 'rename');
            this.vfs.rename(oldPath, newPath);
            if (staleDestination)
                this.legacySymlinks.delete(newPath);
            return;
        }
        const linkTarget = this.legacySymlinks.readlink(oldPath);
        if (linkTarget === null)
            throw fsError('ENOENT', 'rename', from);
        const staleDestination = this.legacySymlinks.isSymlink(newPath);
        this.legacySymlinks.assertMutable(oldPath, ...(staleDestination ? [newPath] : []));
        this.assertParentDirectory(newPath, 'rename');
        if (this.vfs.exists(newPath)) {
            if (this.vfs.isDirectory(newPath))
                throw fsError('EISDIR', 'rename', to);
            this.vfs.unlink(newPath);
        }
        this.vfs.symlink(linkTarget, newPath);
        this.legacySymlinks.delete(oldPath);
        if (staleDestination)
            this.legacySymlinks.delete(newPath);
    }
    readlink(path) {
        const located = this.locate(path, false);
        if (located === null)
            return null;
        if (located.mount)
            return located.mount.readlink(located.path);
        const p = located.path;
        if (this.vfs.isSymlink(p))
            return this.vfs.readlink(p);
        return this.legacySymlinks.readlink(p);
    }
    symlink(target, path) {
        const located = this.locateMutation(path, false, 'symlink');
        if (located.mount) {
            located.mount.symlink(target, located.path);
            return;
        }
        const p = located.path;
        if (this.vfs.exists(p) || this.legacySymlinks.isSymlink(p)) {
            throw fsError('EEXIST', 'symlink', path);
        }
        this.ensureParent(p);
        this.vfs.symlink(target, p);
    }
    fsync(handleId) {
        if (handleId !== undefined)
            this.description(handleId);
        // SqliteVFS writes are synchronously durable before their calls return.
    }
    /**
     * Every per-path revision here is the caller's: `p` is its own name for a
     * path, and a confined caller's /tmp/x is its private file, whose revision
     * is not the shared tmp/x's. The global clock is everyone's.
     */
    revision(path) {
        if (path === undefined)
            return this.rawVfs.revision();
        const located = this.locate(path, true);
        if (located === null)
            throw fsError('ELOOP', 'revision', path);
        return located.mount ? 0 : this.vfs.revision(located.path);
    }
    acquire(epoch, cursor) {
        return this.vfs.invalidatedSince(epoch, cursor);
    }
    list(after, limit) {
        return this.vfs.list(after ?? null, limit);
    }
    subscribe(path, listener) {
        return this.rawVfs.events.onPath(normalizeVfsPath(path), listener);
    }
    realpath(path) {
        const resolved = this.resolveDataPath(path, true);
        if (resolved === null)
            throw fsError('ELOOP', 'realpath', path);
        this.vfs.stat(resolved);
        return '/' + resolved;
    }
    remove(path, options = {}) {
        try {
            if (!options.recursive) {
                this.unlink(path);
                return;
            }
            const located = this.locateMutation(path, false, 'remove');
            if (located.mount)
                located.mount.rmdirRecursive(located.path);
            else
                this.vfs.removeRecursive(located.path);
        }
        catch (error) {
            if (!(options.force && hasErrorCode(error, 'ENOENT')))
                throw error;
        }
    }
    copyFile(from, to) {
        const source = this.locate(from, true);
        if (source === null)
            throw fsError('ELOOP', 'copyFile', from);
        const target = this.locateMutation(to, true, 'copyFile');
        if (!source.mount && !target.mount) {
            this.vfs.copyFile(source.path, target.path);
            return;
        }
        const bytes = source.mount ? source.mount.readFile(source.path) : this.vfs.readFile(source.path);
        if (target.mount)
            target.mount.writeFile(target.path, bytes);
        else {
            this.ensureParent(target.path);
            this.vfs.writeFile(target.path, bytes);
        }
    }
    writeBatch(payload) {
        return this.vfs.writeBatch(payload);
    }
    writeStream(stream, options) {
        return this.vfs.writeStream(stream, options);
    }
    acquireExclusiveMutation(path, options) {
        const p = this.sqlitePath(path, false, 'acquireExclusiveMutation');
        const parent = parentVfsPath(p);
        if (parent && !(options?.includeMissingAncestors && !this.vfs.exists(parent)))
            this.vfs.access(parent, 0o3);
        return this.rawVfs.acquireExclusiveMutation(p, options);
    }
    releaseExclusiveMutation(owner) { this.rawVfs.releaseExclusiveMutation(owner); }
    pathArgument(path) {
        if (typeof path === 'string')
            return path;
        if ('root' in path)
            return path.root + '/' + path.path;
        const node = this.description(path.directory).node;
        if (node.stat().type !== 'directory')
            throw fsError('ENOTDIR', 'path', path.path);
        if (path.path.startsWith('/'))
            return path.path;
        return node.path() + '/' + path.path;
    }
    resolveDataPath(path, followSymlinks) {
        const rooted = typeof path !== 'string' && path.beneath;
        const root = rooted ? normalizeVfsPath('root' in path ? path.root : this.description(path.directory).node.path()) : null;
        if (rooted && path.path.startsWith('/'))
            throw fsError('ENOTCAPABLE', 'path', path);
        const pending = this.pathArgument(path).split('/').filter(Boolean);
        const resolved = [];
        const seen = new Set();
        while (pending.length > 0) {
            const segment = pending.shift();
            if (segment === undefined)
                break;
            if (segment === '.')
                continue;
            if (segment === '..') {
                if (root !== null && resolved.join('/') === root)
                    throw fsError('ENOTCAPABLE', 'path', path);
                resolved.pop();
                continue;
            }
            const candidate = [...resolved, segment].join('/');
            const isFinal = pending.length === 0;
            if (!followSymlinks && isFinal) {
                resolved.push(segment);
                continue;
            }
            let target;
            if (this.vfs.isSymlink(candidate)) {
                target = this.vfs.resolveSymlink(candidate);
                if (target === null)
                    return null;
            }
            else if (!this.vfs.exists(candidate)) {
                const legacyTarget = this.legacySymlinks.readlink(candidate);
                target = legacyTarget === null
                    ? null
                    : legacyTarget.startsWith('/')
                        ? normalizeVfsPath(legacyTarget)
                        : normalizeVfsPath(`${parentVfsPath(candidate)}/${legacyTarget}`);
            }
            else {
                target = null;
            }
            if (target === null) {
                resolved.push(segment);
                continue;
            }
            if (seen.has(candidate))
                return null;
            seen.add(candidate);
            if (root !== null && root !== '' && target !== root && !target.startsWith(root + '/'))
                throw fsError('ENOTCAPABLE', 'path', path);
            pending.unshift(...target.split('/').filter(Boolean));
            resolved.length = 0;
        }
        return resolved.join('/');
    }
    locateMutation(path, followSymlinks, syscall) {
        // A lease on a directory also covers names inside it that resolve
        // elsewhere through a symlink, so the literal path is checked as well.
        this.rawVfs.assertMutationAllowed(normalizeVfsPath(this.pathArgument(path)));
        const located = this.locate(path, followSymlinks);
        if (located === null)
            throw fsError('ELOOP', syscall, path);
        if (!located.mount)
            this.rawVfs.assertMutationAllowed(located.path);
        return located;
    }
    /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
    sqlitePath(path, followSymlinks, syscall) {
        const located = this.locateMutation(path, followSymlinks, syscall);
        if (located.mount)
            throw fsError('EXDEV', syscall, path);
        return located.path;
    }
    openRoot(path, flags) {
        if (flags.truncate || flags.append)
            throw fsError('EISDIR', 'open', path);
        const deny = () => { throw fsError('EPERM', 'fd', ''); };
        const node = {
            ino: 0, path: () => '', stat: () => this.rootStat(),
            read: deny, write: deny, truncate: deny, readdir: () => this.readdir(''),
            chmod: deny, chown: deny, utimes: deny, close: () => { },
        };
        const handle = { id: this.scope.nextId++, path: '', flags: Object.freeze(flags), position: 0, closed: false };
        this.scope.handles.set(handle.id, { handle, node, refs: 1 });
        return { ...handle };
    }
    openMount(mount, name, path, flags) {
        const exists = mount.exists(name);
        if (flags.exclusive && flags.create && exists)
            throw fsError('EEXIST', 'open', path);
        if (!exists && !flags.create)
            throw fsError('ENOENT', 'open', path);
        if (!exists)
            mount.writeFile(name, new Uint8Array(0));
        const stat = this.virtualStat(mount, name);
        if (flags.directory && stat.type !== 'directory')
            throw fsError('ENOTDIR', 'open', path);
        if (stat.type === 'directory' && (flags.truncate || flags.append))
            throw fsError('EISDIR', 'open', path);
        mount.access(name, (flags.read ? 4 : 0) | (flags.write && stat.type !== 'directory' ? 2 : 0));
        if (flags.truncate)
            mount.truncate(name, 0);
        const node = {
            ino: stat.ino, path: () => name, stat: () => this.virtualStat(mount, name),
            read: (offset, length) => mount.readRange(name, offset, length),
            write: (offset, bytes) => { mount.writeRange(name, offset, bytes); return bytes.length; },
            truncate: size => mount.truncate(name, size), readdir: () => mount.readdir(name),
            chmod: mode => mount.chmod(name, mode), chown: (uid, gid) => mount.chown(name, uid, gid),
            utimes: (atime, mtime) => mount.utimes(name, atime, mtime), close: () => { },
        };
        const handle = {
            id: this.scope.nextId++, path: name, flags: Object.freeze(flags),
            position: flags.append ? stat.size : 0, closed: false,
        };
        this.scope.handles.set(handle.id, { handle, node, refs: 1 });
        return { ...handle };
    }
    ensureParent(path) {
        const parent = parentVfsPath(path);
        if (parent && !this.vfs.exists(parent))
            this.vfs.mkdir(parent, { recursive: true });
    }
    assertParentDirectory(path, syscall) {
        const parent = parentVfsPath(path);
        if (!parent)
            return;
        if (!this.vfs.exists(parent))
            throw fsError('ENOENT', syscall, path);
        if (!this.vfs.isDirectory(parent))
            throw fsError('ENOTDIR', syscall, path);
    }
    /**
     * Run one mutation of path `p` and report its revision on either side,
     * both read in the mutation's own synchronous turn: across an await either
     * would report a peer's clock as ours.
     */
    receipted(p, mutate) {
        const before = this.vfs.revision(p);
        mutate();
        return { before, after: this.rawVfs.revision() };
    }
    /** A mount never moves the raw clock, and ACQUIRE never lists its paths. */
    mountReceipt() {
        const r = this.rawVfs.revision();
        return { before: r, after: r };
    }
    assertExpectedRevision(path, expectedRevision) {
        if (expectedRevision === undefined)
            return;
        if (expectedRevision !== this.vfs.revision(path)) {
            throw fsError('ESTALE', 'write', `revision ${expectedRevision}`);
        }
    }
    description(handleId) {
        const description = this.scope.handles.get(handleId);
        if (!description || this.scope.closed)
            throw fsError('EBADF', 'fd', String(handleId));
        return description;
    }
    getHandle(handleId) { return this.description(handleId).handle; }
    fstat(handleId) {
        return { ...this.description(handleId).node.stat(), revision: this.rawVfs.revision() };
    }
    dup(handleId) {
        const opened = this.description(handleId);
        const id = this.scope.nextId++;
        opened.refs++;
        this.scope.handles.set(id, opened);
        return { ...opened.handle, id };
    }
    seek(handleId, offset, whence) {
        const handle = this.getHandle(handleId);
        const base = whence === 'set' ? 0 : whence === 'current' ? handle.position : whence === 'end' ? this.fstat(handleId).size : NaN;
        const position = base + offset;
        if (!Number.isSafeInteger(position) || position < 0)
            throw fsError('EINVAL', 'seek', handle.path);
        handle.position = position;
        return position;
    }
    setStatus(handleId, status) {
        const handle = this.getHandle(handleId);
        if (status.append !== undefined)
            handle.flags = Object.freeze({ ...handle.flags, append: status.append });
    }
    readdirHandle(handleId) { return this.description(handleId).node.readdir(); }
    ftruncate(handleId, size) { this.description(handleId).node.truncate(size); }
    fchmod(handleId, mode) { this.description(handleId).node.chmod(mode); }
    fchown(handleId, uid, gid) { this.description(handleId).node.chown(uid, gid); }
    futimes(handleId, atime, mtime) { this.description(handleId).node.utimes(atime, mtime); }
}
function normalizeOpenFlags(flags) {
    return {
        read: !!flags.read || !flags.write,
        write: !!flags.write,
        append: !!flags.append,
        create: !!flags.create,
        exclusive: !!flags.exclusive,
        directory: !!flags.directory,
        truncate: !!flags.truncate,
        followSymlinks: flags.followSymlinks !== false,
        expectedRevision: flags.expectedRevision,
    };
}
function fsError(code, syscall, path) {
    const name = typeof path === 'string' ? path : path.path;
    return Object.assign(new Error(`${code}: ${syscall} '${name}'`), { code, syscall, path: name });
}
function hasErrorCode(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
