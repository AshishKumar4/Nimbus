import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
export class SqliteRuntimeFsBridge {
    vfs;
    nextHandleId = 1;
    handles = new Map();
    legacySymlinks;
    constructor(vfs) {
        this.vfs = vfs;
        this.legacySymlinks = getSymlinkRegistry(vfs);
    }
    async stat(path, options = {}) {
        const followSymlinks = options.followSymlinks !== false;
        const p = this.resolveDataPath(path, followSymlinks);
        if (!p)
            return null;
        if (!followSymlinks && !this.vfs.exists(p)) {
            const target = this.legacySymlinks.readlink(p);
            if (target === null)
                return null;
            const now = Date.now();
            return {
                type: 'symlink',
                size: new TextEncoder().encode(target).byteLength,
                ctime: now,
                atime: now,
                mtime: now,
                mode: 0o120777,
                revision: this.vfs.revision(p),
            };
        }
        try {
            const st = this.vfs.stat(p);
            const type = st.type === 'directory'
                ? 'directory'
                : st.type === 'symlink'
                    ? 'symlink'
                    : 'file';
            return {
                type,
                size: st.size,
                ctime: st.ctime,
                atime: st.atime,
                mtime: st.mtime,
                mode: type === 'symlink' ? 0o120000 | (st.mode & 0o777) : st.mode,
                revision: this.vfs.revision(p),
            };
        }
        catch {
            return null;
        }
    }
    async readFile(path, options = {}) {
        const p = this.resolveDataPath(path, options.followSymlinks !== false);
        if (!p)
            return null;
        try {
            return this.vfs.readFile(p);
        }
        catch {
            return null;
        }
    }
    async writeFile(path, bytes, options = {}) {
        const p = this.resolveMutationPath(path, true, 'write');
        this.assertExpectedRevision(p, options.expectedRevision);
        if (options.createParents !== false)
            this.ensureParent(p);
        this.vfs.writeFile(p, bytes);
    }
    async readRange(path, offset, length, options = {}) {
        const p = this.resolveDataPath(path, options.followSymlinks !== false);
        if (!p)
            return null;
        try {
            return this.vfs.readRange(p, offset, length);
        }
        catch {
            return null;
        }
    }
    async writeRange(path, offset, bytes, options = {}) {
        const p = this.resolveMutationPath(path, true, 'write');
        this.assertExpectedRevision(p, options.expectedRevision);
        if (this.vfs.isDirectory(p))
            throw fsError('EISDIR', 'write', path);
        if (options.createParents !== false)
            this.ensureParent(p);
        this.vfs.writeRange(p, offset, bytes);
        return bytes.byteLength;
    }
    async truncate(path, size, options = {}) {
        const p = this.resolveMutationPath(path, options.followSymlinks !== false, 'truncate');
        if (!this.vfs.exists(p))
            throw fsError('ENOENT', 'truncate', path);
        if (this.vfs.isDirectory(p))
            throw fsError('EISDIR', 'truncate', path);
        this.vfs.truncate(p, size);
    }
    async utimes(path, atimeMs, mtimeMs, options = {}) {
        const p = this.resolveMutationPath(path, options.followSymlinks !== false, 'utimes');
        if (!this.vfs.exists(p))
            throw fsError('ENOENT', 'utimes', path);
        this.vfs.utimes(p, atimeMs, mtimeMs);
    }
    async open(path, flags) {
        const normalizedFlags = normalizeOpenFlags(flags);
        const mutates = normalizedFlags.write || normalizedFlags.create ||
            normalizedFlags.truncate || normalizedFlags.append;
        const p = mutates
            ? this.resolveMutationPath(path, normalizedFlags.followSymlinks, 'open')
            : this.resolveDataPath(path, normalizedFlags.followSymlinks);
        if (p === null)
            throw fsError('ELOOP', 'open', path);
        this.assertExpectedRevision(p, normalizedFlags.expectedRevision);
        const exists = this.vfs.exists(p);
        if (!exists && !normalizedFlags.create)
            throw fsError('ENOENT', 'open', path);
        if (exists && this.vfs.isDirectory(p))
            throw fsError('EISDIR', 'open', path);
        if (!exists) {
            this.ensureParent(p);
            this.vfs.writeFile(p, new Uint8Array(0));
        }
        else if (normalizedFlags.truncate) {
            this.vfs.truncate(p, 0);
        }
        const stat = this.vfs.stat(p);
        const handle = {
            id: this.nextHandleId++,
            path: p,
            flags: normalizedFlags,
            position: normalizedFlags.append ? stat.size : 0,
            baseRevision: this.vfs.revision(p),
            closed: false,
        };
        this.handles.set(handle.id, handle);
        return { ...handle };
    }
    async read(handleId, offset, length) {
        const handle = this.getHandle(handleId);
        if (!handle.flags.read)
            throw fsError('EBADF', 'read', handle.path);
        const start = offset == null ? handle.position : Math.max(0, offset);
        const out = this.vfs.readRange(handle.path, start, Math.max(0, length));
        if (offset == null)
            handle.position = start + out.byteLength;
        return out;
    }
    async write(handleId, offset, bytes) {
        const handle = this.getHandle(handleId);
        if (!handle.flags.write)
            throw fsError('EBADF', 'write', handle.path);
        if (handle.baseRevision < this.vfs.revision(handle.path)) {
            throw fsError('ESTALE', 'write', handle.path);
        }
        const start = handle.flags.append
            ? (this.vfs.exists(handle.path) ? this.vfs.stat(handle.path).size : 0)
            : offset == null ? handle.position : Math.max(0, offset);
        this.vfs.writeRange(handle.path, start, bytes);
        const end = start + bytes.byteLength;
        if (offset == null || handle.flags.append)
            handle.position = end;
        handle.baseRevision = this.vfs.revision(handle.path);
        return bytes.byteLength;
    }
    async close(handleId) {
        const handle = this.getHandle(handleId);
        handle.closed = true;
        this.handles.delete(handleId);
    }
    async readdir(path, options = {}) {
        const p = this.resolveDataPath(path, options.followSymlinks !== false);
        if (!p)
            return [];
        const entries = new Map();
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
    async mkdir(path, options = {}) {
        const p = this.resolveMutationPath(path, false, 'mkdir');
        if (this.vfs.exists(p)) {
            if (options.recursive && this.vfs.isDirectory(p))
                return;
            throw fsError('EEXIST', 'mkdir', path);
        }
        this.vfs.mkdir(p, { recursive: !!options.recursive });
    }
    async unlink(path) {
        const p = this.resolveMutationPath(path, false, 'unlink');
        if (this.vfs.exists(p)) {
            const staleLegacy = this.legacySymlinks.isSymlink(p);
            if (staleLegacy)
                this.legacySymlinks.assertMutable(p);
            this.vfs.unlink(p);
            if (staleLegacy)
                this.legacySymlinks.delete(p);
            return;
        }
        this.legacySymlinks.delete(p);
    }
    async rmdir(path) {
        const p = this.resolveMutationPath(path, false, 'rmdir');
        if (!this.vfs.isDirectory(p))
            throw fsError('ENOTDIR', 'rmdir', path);
        this.vfs.rmdir(p);
    }
    async rename(from, to) {
        const oldPath = this.resolveMutationPath(from, false, 'rename');
        const newPath = this.resolveMutationPath(to, false, 'rename');
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
        this.vfs.symlink(linkTarget, newPath);
        this.legacySymlinks.delete(oldPath);
        if (staleDestination)
            this.legacySymlinks.delete(newPath);
    }
    async readlink(path) {
        const p = this.resolveDataPath(path, false);
        if (!p)
            return null;
        if (this.vfs.isSymlink(p))
            return this.vfs.readlink(p);
        return this.legacySymlinks.readlink(p);
    }
    async symlink(target, path) {
        const p = this.resolveMutationPath(path, false, 'symlink');
        if (this.vfs.exists(p) || this.legacySymlinks.isSymlink(p)) {
            throw fsError('EEXIST', 'symlink', path);
        }
        this.ensureParent(p);
        this.vfs.symlink(target, p);
    }
    async fsync() {
        // SqliteVFS writes are synchronously durable before their calls return.
    }
    async revision(path) {
        if (path === undefined)
            return this.vfs.revision();
        const p = this.resolveDataPath(path, true) ?? normalizeVfsPath(path);
        return this.vfs.revision(p);
    }
    subscribe(path, listener) {
        return this.vfs.events.onPath(normalizeVfsPath(path), listener);
    }
    resolveDataPath(path, followSymlinks) {
        const pending = normalizeVfsPath(path).split('/').filter(Boolean);
        const resolved = [];
        const seen = new Set();
        while (pending.length > 0) {
            const segment = pending.shift();
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
            pending.unshift(...target.split('/').filter(Boolean));
            resolved.length = 0;
        }
        return resolved.join('/');
    }
    resolveMutationPath(path, followSymlinks, syscall) {
        this.vfs.assertMutationAllowed(normalizeVfsPath(path));
        const resolved = this.resolveDataPath(path, followSymlinks);
        if (resolved === null)
            throw fsError('ELOOP', syscall, path);
        return resolved;
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
    assertExpectedRevision(path, expectedRevision) {
        if (expectedRevision === undefined)
            return;
        if (expectedRevision !== this.vfs.revision(path)) {
            throw fsError('ESTALE', 'write', `revision ${expectedRevision}`);
        }
    }
    getHandle(handleId) {
        const handle = this.handles.get(handleId);
        if (!handle || handle.closed)
            throw fsError('EBADF', 'fd', String(handleId));
        return handle;
    }
}
function normalizeOpenFlags(flags) {
    return {
        read: !!flags.read || !flags.write,
        write: !!flags.write,
        append: !!flags.append,
        create: !!flags.create,
        truncate: !!flags.truncate,
        followSymlinks: flags.followSymlinks !== false,
        expectedRevision: flags.expectedRevision,
    };
}
function fsError(code, syscall, path) {
    const err = new Error(`${code}: ${syscall} '${path}'`);
    err.code = code;
    err.syscall = syscall;
    err.path = path;
    return err;
}
