import { normalizeVfsPath, parentVfsPath } from '../vfs/path.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
export class SqliteRuntimeFsBridge {
    vfs;
    nextHandleId = 1;
    handles = new Map();
    symlinks;
    constructor(vfs) {
        this.vfs = vfs;
        this.symlinks = getSymlinkRegistry(vfs);
    }
    async stat(path, options = {}) {
        const p = this.resolveDataPath(path, options.followSymlinks !== false);
        if (!p)
            return null;
        if (this.symlinks.isSymlink(p) && options.followSymlinks === false) {
            const target = this.symlinks.readlink(p) || '';
            return {
                type: 'symlink',
                size: new TextEncoder().encode(target).byteLength,
                ctime: Date.now(),
                mtime: Date.now(),
                mode: 0o777,
                revision: this.vfs.revision(),
            };
        }
        try {
            const st = this.vfs.stat(p);
            return {
                type: st.type === 'directory' ? 'directory' : 'file',
                size: st.size,
                ctime: st.ctime,
                mtime: st.mtime,
                mode: st.mode,
                revision: this.vfs.revision(),
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
        this.assertExpectedRevision(options.expectedRevision);
        const p = this.resolveDataPath(path, true) || normalizeVfsPath(path);
        if (options.createParents !== false)
            this.ensureParent(p);
        this.vfs.writeFile(p, bytes);
    }
    async open(path, flags) {
        const normalizedFlags = normalizeOpenFlags(flags);
        const p = this.resolveDataPath(path, normalizedFlags.followSymlinks) || normalizeVfsPath(path);
        this.assertExpectedRevision(normalizedFlags.expectedRevision);
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
            this.vfs.writeFile(p, new Uint8Array(0));
        }
        const stat = this.vfs.stat(p);
        const handle = {
            id: this.nextHandleId++,
            path: p,
            flags: normalizedFlags,
            position: normalizedFlags.append ? stat.size : 0,
            baseRevision: this.vfs.revision(),
            closed: false,
        };
        this.handles.set(handle.id, handle);
        return { ...handle };
    }
    async read(handleId, offset, length) {
        const handle = this.getHandle(handleId);
        if (!handle.flags.read)
            throw fsError('EBADF', 'read', handle.path);
        const data = this.vfs.readFile(handle.path);
        const start = offset == null ? handle.position : Math.max(0, offset);
        const end = Math.min(data.byteLength, start + Math.max(0, length));
        const out = data.slice(start, end);
        if (offset == null)
            handle.position = end;
        return out;
    }
    async write(handleId, offset, bytes) {
        const handle = this.getHandle(handleId);
        if (!handle.flags.write)
            throw fsError('EBADF', 'write', handle.path);
        if (handle.baseRevision < this.vfs.revision()) {
            throw fsError('ESTALE', 'write', handle.path);
        }
        const prior = this.vfs.exists(handle.path) ? this.vfs.readFile(handle.path) : new Uint8Array(0);
        const start = handle.flags.append ? prior.byteLength : offset == null ? handle.position : Math.max(0, offset);
        const size = Math.max(prior.byteLength, start + bytes.byteLength);
        const next = new Uint8Array(size);
        next.set(prior.subarray(0, Math.min(prior.byteLength, size)), 0);
        next.set(bytes, start);
        this.vfs.writeFile(handle.path, next);
        const end = start + bytes.byteLength;
        if (offset == null || handle.flags.append)
            handle.position = end;
        handle.baseRevision = this.vfs.revision();
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
        const entries = this.vfs.readdir(p).map((entry) => ({
            name: entry.name,
            type: entry.type === 'directory' ? 'directory' : 'file',
        }));
        const prefix = p ? `${p}/` : '';
        for (const link of this.symlinks.list()) {
            if (parentVfsPath(link.link) !== p)
                continue;
            entries.push({ name: link.link.slice(prefix.length), type: 'symlink' });
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    async mkdir(path, options = {}) {
        this.vfs.mkdir(normalizeVfsPath(path), { recursive: !!options.recursive });
    }
    async unlink(path) {
        const p = normalizeVfsPath(path);
        if (this.symlinks.delete(p))
            return;
        this.vfs.unlink(p);
    }
    async rmdir(path) {
        this.vfs.rmdir(normalizeVfsPath(path));
    }
    async rename(from, to) {
        const oldPath = normalizeVfsPath(from);
        const newPath = normalizeVfsPath(to);
        const linkTarget = this.symlinks.readlink(oldPath);
        if (linkTarget !== null) {
            this.symlinks.delete(oldPath);
            this.symlinks.set(newPath, linkTarget);
            return;
        }
        this.ensureParent(newPath);
        this.vfs.rename(oldPath, newPath);
    }
    async readlink(path) {
        return this.symlinks.readlink(normalizeVfsPath(path));
    }
    async symlink(target, path) {
        const p = normalizeVfsPath(path);
        this.ensureParent(p);
        this.symlinks.set(p, target);
    }
    async fsync() {
        this.vfs.flushAll();
    }
    async revision() {
        return this.vfs.revision();
    }
    subscribe(path, listener) {
        return this.vfs.events.onPath(normalizeVfsPath(path), listener);
    }
    resolveDataPath(path, followSymlinks) {
        const p = normalizeVfsPath(path);
        if (!followSymlinks)
            return p;
        return this.symlinks.resolveChain(p);
    }
    ensureParent(path) {
        const parent = parentVfsPath(path);
        if (parent && !this.vfs.exists(parent))
            this.vfs.mkdir(parent, { recursive: true });
    }
    assertExpectedRevision(expectedRevision) {
        if (expectedRevision === undefined)
            return;
        if (expectedRevision !== this.vfs.revision()) {
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
