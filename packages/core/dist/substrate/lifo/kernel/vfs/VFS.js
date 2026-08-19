import { resolve, dirname, basename } from '../../utils/path.js';
import { encode, decode } from '../../utils/encoding.js';
import { getMimeType } from '../../utils/mime.js';
import { VFSError, ErrorCode } from './types.js';
import { ContentStore, CHUNK_THRESHOLD } from '../storage/ContentStore.js';
import { EventEmitter } from '../../node-compat/events.js';
/** Runtime check: does a provider implement the full MountProvider interface? */
function isMountProvider(p) {
    return (typeof p.unlink === 'function' &&
        typeof p.mkdir === 'function' &&
        typeof p.rmdir === 'function' &&
        typeof p.rename === 'function' &&
        typeof p.copyFile === 'function');
}
function sliceRange(source, offset, length) {
    const start = Math.min(offset, source.length);
    return source.subarray(start, Math.min(source.length, start + length));
}
/** `source` with `bytes` overwritten at `offset`, zero-filling any gap. */
function spliceRange(source, offset, bytes) {
    const end = offset + bytes.length;
    if (end <= source.length) {
        const merged = new Uint8Array(source);
        merged.set(bytes, offset);
        return merged;
    }
    const merged = new Uint8Array(end);
    merged.set(source.subarray(0, Math.min(source.length, offset)), 0);
    merged.set(bytes, offset);
    return merged;
}
function resizeBytes(source, size) {
    if (size === source.length)
        return source;
    if (size < source.length)
        return source.slice(0, size);
    const grown = new Uint8Array(size);
    grown.set(source, 0);
    return grown;
}
export class VFS {
    root;
    /**
     * Mount table -- kept sorted longest-prefix-first so that the first match
     * during lookup is always the most specific.
     */
    mounts = [];
    emitter = new EventEmitter();
    onChange;
    /** Content store for chunked large files. Optional -- without it all data stays inline. */
    contentStore;
    cred;
    constructor(contentStore) {
        this.root = this.createNode('directory', '');
        this.contentStore = contentStore ?? new ContentStore();
    }
    as(cred) {
        const view = new VFS(this.contentStore);
        view.root = this.root;
        view.mounts = this.mounts;
        view.emitter = this.emitter;
        view.onChange = this.onChange;
        view.cred = cred;
        return view;
    }
    watch(pathOrListener, maybeListener) {
        if (typeof pathOrListener === 'function') {
            // watch(listener) — global watch
            const listener = pathOrListener;
            this.emitter.on('change', listener);
            return () => this.emitter.off('change', listener);
        }
        // watch(path, listener) — scoped watch
        const prefix = this.toAbsolute(pathOrListener);
        const listener = maybeListener;
        const scoped = (event) => {
            if (event.path === prefix || event.path.startsWith(prefix + '/')) {
                listener(event);
            }
            if (event.oldPath && (event.oldPath === prefix || event.oldPath.startsWith(prefix + '/'))) {
                listener(event);
            }
        };
        this.emitter.on('change', scoped);
        return () => this.emitter.off('change', scoped);
    }
    notify(event) {
        this.emitter.emit('change', event);
        this.onChange?.();
    }
    // ─── Mount management ───
    /**
     * Mount a provider at an arbitrary path.
     * The path is normalised to an absolute path (e.g. "/mnt/project").
     */
    mount(path, provider) {
        const abs = this.toAbsolute(path);
        // Replace if already mounted at this exact path
        const idx = this.mounts.findIndex((m) => m.path === abs);
        if (idx !== -1) {
            this.mounts[idx] = { path: abs, provider };
        }
        else {
            this.mounts.push({ path: abs, provider });
        }
        // Re-sort: longest path first (most specific wins)
        this.mounts.sort((a, b) => b.path.length - a.path.length);
    }
    /**
     * Unmount the provider at the given path.
     */
    unmount(path) {
        const abs = this.toAbsolute(path);
        const idx = this.mounts.findIndex((m) => m.path === abs);
        if (idx === -1) {
            throw new VFSError(ErrorCode.EINVAL, `'${path}': not mounted`);
        }
        this.mounts.splice(idx, 1);
    }
    /**
     * Backward-compatible alias for `mount`.
     * Previously the only way to register a VirtualProvider at a root-level prefix.
     */
    registerProvider(prefix, provider) {
        this.mount(prefix, provider);
    }
    getRoot() {
        return this.root;
    }
    loadFromSerialized(root) {
        this.root = root;
    }
    // ─── Provider resolution ───
    /**
     * `provider` is derived per call — a credentialed VFS hands back a fresh
     * `as(cred)` view every time — so it is never a stable identity. `entry` is
     * the mount itself and is what "are these two paths on the same filesystem"
     * has to compare.
     */
    getProvider(path) {
        const abs = this.toAbsolute(path);
        for (const entry of this.mounts) {
            if (abs === entry.path || abs.startsWith(entry.path + '/')) {
                const subpath = abs === entry.path ? '/' : abs.slice(entry.path.length);
                const provider = this.cred && entry.provider.as
                    ? entry.provider.as(this.cred)
                    : entry.provider;
                return { entry, provider, subpath };
            }
        }
        return null;
    }
    // ─── Internal helpers ───
    createNode(type, name) {
        const now = Date.now();
        return {
            type,
            name,
            data: new Uint8Array(0),
            children: new Map(),
            ctime: now,
            mtime: now,
            mode: type === 'directory' ? 0o755 : 0o644,
        };
    }
    resolveNode(path) {
        const abs = this.toAbsolute(path);
        if (abs === '/')
            return this.root;
        const parts = abs.split('/').filter(Boolean);
        let node = this.root;
        for (const part of parts) {
            if (node.type !== 'directory') {
                throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
            }
            const child = node.children.get(part);
            if (!child) {
                throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
            }
            node = child;
        }
        return node;
    }
    resolveParent(path) {
        const abs = this.toAbsolute(path);
        const dir = dirname(abs);
        const name = basename(abs);
        const parent = this.resolveNode(dir);
        if (parent.type !== 'directory') {
            throw new VFSError(ErrorCode.ENOTDIR, `'${dir}': not a directory`);
        }
        return { parent, name };
    }
    toAbsolute(path) {
        return resolve('/', path);
    }
    // ─── File operations ───
    readFile(path) {
        const vp = this.getProvider(path);
        if (vp)
            return vp.provider.readFile(vp.subpath);
        const node = this.resolveNode(path);
        if (node.type === 'directory') {
            throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
        }
        // Chunked file: reassemble from content store
        if (node.chunks) {
            const data = this.contentStore.loadChunked(node.chunks);
            if (data)
                return data;
            // Chunks evicted from cache -- data is lost (should not happen in normal use)
            return new Uint8Array(0);
        }
        return node.data;
    }
    readFileString(path) {
        const vp = this.getProvider(path);
        if (vp)
            return vp.provider.readFileString(vp.subpath);
        return decode(this.readFile(path));
    }
    writeFile(path, content) {
        const vp = this.getProvider(path);
        if (vp) {
            if (vp.provider.writeFile) {
                vp.provider.writeFile(vp.subpath, content);
                return;
            }
            throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
        }
        const data = typeof content === 'string' ? encode(content) : content;
        const abs = this.toAbsolute(path);
        const { parent, name } = this.resolveParent(path);
        const mime = getMimeType(name);
        const existing = parent.children.get(name);
        if (existing) {
            if (existing.type === 'directory') {
                throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
            }
            // Clean up old chunks if transitioning from chunked
            if (existing.chunks) {
                this.contentStore.deleteChunked(existing.chunks);
            }
            this.applyFileContent(existing, data);
            existing.mtime = Date.now();
            existing.mime = mime;
            this.notify({ type: 'modify', path: abs, fileType: 'file' });
        }
        else {
            const node = this.createNode('file', name);
            this.applyFileContent(node, data);
            node.mime = mime;
            parent.children.set(name, node);
            this.notify({ type: 'create', path: abs, fileType: 'file' });
        }
    }
    /**
     * Store file content -- inline for small files, chunked for large files.
     */
    applyFileContent(node, data) {
        if (data.byteLength >= CHUNK_THRESHOLD) {
            // Large file: chunk into content store
            node.chunks = this.contentStore.storeChunked(data);
            node.storedSize = data.byteLength;
            node.data = new Uint8Array(0); // keep INode lightweight
            node.blobRef = undefined;
        }
        else {
            // Small file: store inline
            node.data = data;
            node.chunks = undefined;
            node.storedSize = undefined;
            node.blobRef = undefined;
        }
    }
    /**
     * Read at most `length` bytes at `offset`. Short reads are legal; an empty
     * result means EOF. Streams (`/dev/*`) and chunked backing stores serve the
     * slice directly, so bounded readers never materialise a whole file.
     */
    readRange(path, offset, length) {
        const start = Math.max(0, Math.trunc(offset));
        const want = Math.max(0, Math.trunc(length));
        if (want === 0)
            return new Uint8Array(0);
        const vp = this.getProvider(path);
        if (vp) {
            if (vp.provider.readRange)
                return vp.provider.readRange(vp.subpath, start, want);
            return sliceRange(vp.provider.readFile(vp.subpath), start, want);
        }
        return sliceRange(this.readFile(path), start, want);
    }
    /**
     * Write `bytes` at `offset`, growing the file (zero-filling any gap) as
     * needed. This is the single write primitive behind sequential writers —
     * shell redirections, `dd`, and appends all advance an offset through it
     * instead of rewriting the file per chunk.
     */
    writeRange(path, offset, bytes) {
        const start = Math.max(0, Math.trunc(offset));
        const provider = this.mountProvider(path);
        if (provider?.provider.writeRange) {
            provider.provider.writeRange(provider.subpath, start, bytes);
            return;
        }
        this.rewriteFile(path, (existing) => spliceRange(existing, start, bytes));
    }
    /** Shrink or zero-extend a file to exactly `size` bytes. */
    truncate(path, size) {
        const target = Math.max(0, Math.trunc(size));
        const provider = this.mountProvider(path);
        if (provider?.provider.truncate) {
            provider.provider.truncate(provider.subpath, target);
            return;
        }
        this.rewriteFile(path, (existing) => resizeBytes(existing, target));
    }
    mountProvider(path) {
        const vp = this.getProvider(path);
        return vp ? { provider: vp.provider, subpath: vp.subpath } : null;
    }
    /**
     * Replace a file's bytes with `transform(current)`. The read-modify-write
     * shape is what a backing store without positional writes forces; providers
     * that do have them never reach here.
     */
    rewriteFile(path, transform) {
        const vp = this.mountProvider(path);
        if (vp) {
            if (!vp.provider.writeFile) {
                throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
            }
            const existing = vp.provider.exists(vp.subpath)
                ? vp.provider.readFile(vp.subpath)
                : new Uint8Array(0);
            vp.provider.writeFile(vp.subpath, transform(existing));
            return;
        }
        let node;
        try {
            node = this.resolveNode(path);
        }
        catch (e) {
            if (!(e instanceof VFSError) || e.code !== 'ENOENT')
                throw e;
            this.writeFile(path, transform(new Uint8Array(0)));
            return;
        }
        if (node.type === 'directory') {
            throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
        }
        const existing = node.chunks
            ? this.contentStore.loadChunked(node.chunks) ?? new Uint8Array(0)
            : node.data;
        const next = transform(existing);
        if (node.chunks)
            this.contentStore.deleteChunked(node.chunks);
        this.applyFileContent(node, next);
        node.mtime = Date.now();
        this.notify({ type: 'modify', path: this.toAbsolute(path), fileType: 'file' });
    }
    appendFile(path, content) {
        const data = typeof content === 'string' ? encode(content) : content;
        let size = 0;
        if (this.exists(path)) {
            const st = this.stat(path);
            if (st.type === 'directory') {
                throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
            }
            size = st.size;
        }
        this.writeRange(path, size, data);
    }
    exists(path) {
        const vp = this.getProvider(path);
        if (vp)
            return vp.provider.exists(vp.subpath);
        try {
            this.resolveNode(path);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Type probes, mount-aware through {@link stat}.
     *
     * `CredentialedVfs` declares these and the durable coreutils call them on
     * whatever `ctx.vfs` is, so a view that omitted them was not merely missing
     * a convenience: `touch` on an existing file died with
     * `targetVfs.isDirectory is not a function`, because `&&` short-circuited
     * past the call whenever the file was absent — which is why creating a file
     * worked and touching one did not.
     *
     * A structural miss answers false, the way `fs.existsSync` does. A denial
     * still throws: traverse-x enforcement must not be maskable into a quiet
     * false, which is the rule `SqliteVFS.probeInode` already follows.
     */
    isDirectory(path) {
        return this.probeType(path) === 'directory';
    }
    isFile(path) {
        return this.probeType(path) === 'file';
    }
    probeType(path) {
        try {
            return this.stat(path).type;
        }
        catch (error) {
            if (error !== null && typeof error === 'object' && 'code' in error) {
                const code = error.code;
                if (code === 'ENOENT' || code === 'ENOTDIR')
                    return undefined;
            }
            throw error;
        }
    }
    access(path, mode) {
        const vp = this.getProvider(path);
        if (vp) {
            if (vp.provider.access) {
                vp.provider.access(vp.subpath, mode);
                return;
            }
            vp.provider.stat(vp.subpath);
            return;
        }
        const node = this.resolveNode(path);
        if (mode === 0)
            return;
        const granted = ((node.mode >> 6) | (node.mode >> 3) | node.mode) & 0o7;
        if ((granted & (mode & 0o7)) !== (mode & 0o7)) {
            throw new Error(`EACCES: '${path}': permission denied`);
        }
    }
    stat(path) {
        const vp = this.getProvider(path);
        if (vp)
            return vp.provider.stat(vp.subpath);
        const node = this.resolveNode(path);
        const stat = {
            type: node.type,
            size: node.type === 'file' ? (node.storedSize ?? node.data.length) : node.children.size,
            ctime: node.ctime,
            mtime: node.mtime,
            mode: node.mode,
        };
        if (node.mime) {
            stat.mime = node.mime;
        }
        return stat;
    }
    unlink(path) {
        const abs = this.toAbsolute(path);
        const vp = this.getProvider(path);
        if (vp) {
            if (isMountProvider(vp.provider)) {
                vp.provider.unlink(vp.subpath);
                return;
            }
            throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
        }
        const { parent, name } = this.resolveParent(path);
        const node = parent.children.get(name);
        if (!node) {
            throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
        }
        if (node.type === 'directory') {
            throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
        }
        // Clean up chunks from content store
        if (node.chunks) {
            this.contentStore.deleteChunked(node.chunks);
        }
        parent.children.delete(name);
        this.notify({ type: 'delete', path: abs, fileType: 'file' });
    }
    rename(oldPath, newPath) {
        const oldAbs = this.toAbsolute(oldPath);
        const newAbs = this.toAbsolute(newPath);
        const vpOld = this.getProvider(oldPath);
        const vpNew = this.getProvider(newPath);
        // Same mount and it supports MountProvider: delegate.
        if (vpOld && vpNew && vpOld.entry === vpNew.entry && isMountProvider(vpOld.provider)) {
            vpOld.provider.rename(vpOld.subpath, vpNew.subpath);
            return;
        }
        // Different filesystems. rename(2) reports EXDEV here rather than doing the
        // copy itself; `mv` is what falls back to copy-then-unlink.
        if (vpOld) {
            throw new VFSError(ErrorCode.EXDEV, `'${oldPath}' -> '${newPath}': cross-device link`);
        }
        const { parent: oldParent, name: oldName } = this.resolveParent(oldPath);
        const node = oldParent.children.get(oldName);
        if (!node) {
            throw new VFSError(ErrorCode.ENOENT, `'${oldPath}': no such file or directory`);
        }
        if (vpNew) {
            throw new VFSError(ErrorCode.EXDEV, `'${oldPath}' -> '${newPath}': cross-device link`);
        }
        const { parent: newParent, name: newName } = this.resolveParent(newPath);
        node.name = newName;
        node.mtime = Date.now();
        newParent.children.set(newName, node);
        oldParent.children.delete(oldName);
        this.notify({ type: 'rename', path: newAbs, oldPath: oldAbs, fileType: node.type });
    }
    copyFile(src, dest) {
        const vpSrc = this.getProvider(src);
        const vpDest = this.getProvider(dest);
        // If both on the same MountProvider, delegate
        if (vpSrc && vpDest && vpSrc.entry === vpDest.entry && isMountProvider(vpSrc.provider)) {
            vpSrc.provider.copyFile(vpSrc.subpath, vpDest.subpath);
            return;
        }
        // Otherwise, read from source and write to dest (works across mounts)
        const srcData = this.readFile(src);
        const data = new Uint8Array(srcData);
        this.writeFile(dest, data); // writeFile already calls notify
    }
    chmod(path, mode) {
        const vp = this.getProvider(path);
        if (vp) {
            const chmod = vp.provider.chmod;
            if (typeof chmod === 'function') {
                chmod.call(vp.provider, vp.subpath, mode);
                return;
            }
            throw new VFSError(ErrorCode.EINVAL, `'${path}': chmod unsupported on this filesystem`);
        }
        const node = this.resolveNode(path);
        const typeBits = node.type === 'directory' ? 0o040000 : 0o100000;
        node.mode = typeBits | (mode & 0o7777);
        this.notify({ type: 'modify', path: this.toAbsolute(path), fileType: node.type });
    }
    chown(path, uid, gid) {
        const vp = this.getProvider(path);
        if (vp) {
            const chown = vp.provider.chown;
            if (typeof chown === 'function') {
                chown.call(vp.provider, vp.subpath, uid, gid);
                return;
            }
            throw new VFSError(ErrorCode.EINVAL, `'${path}': chown unsupported on this filesystem`);
        }
        throw new VFSError(ErrorCode.EINVAL, `'${path}': chown unsupported on this filesystem`);
    }
    touch(path) {
        try {
            const node = this.resolveNode(path);
            node.mtime = Date.now();
            this.notify({ type: 'modify', path: this.toAbsolute(path), fileType: node.type });
        }
        catch (e) {
            if (e instanceof VFSError && e.code === 'ENOENT') {
                this.writeFile(path, ''); // writeFile already calls notify
            }
            else {
                throw e;
            }
        }
    }
    // ─── Directory operations ───
    mkdir(path, options) {
        const vp = this.getProvider(path);
        if (vp) {
            if (isMountProvider(vp.provider)) {
                vp.provider.mkdir(vp.subpath, options);
                return;
            }
            throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
        }
        if (options?.recursive) {
            const abs = this.toAbsolute(path);
            const parts = abs.split('/').filter(Boolean);
            let current = this.root;
            let currentPath = '';
            for (const part of parts) {
                currentPath += '/' + part;
                let child = current.children.get(part);
                if (!child) {
                    child = this.createNode('directory', part);
                    current.children.set(part, child);
                    this.notify({ type: 'create', path: currentPath, fileType: 'directory' });
                }
                else if (child.type !== 'directory') {
                    throw new VFSError(ErrorCode.ENOTDIR, `'${part}': not a directory`);
                }
                current = child;
            }
            return;
        }
        const abs = this.toAbsolute(path);
        const { parent, name } = this.resolveParent(path);
        if (parent.children.has(name)) {
            throw new VFSError(ErrorCode.EEXIST, `'${path}': file exists`);
        }
        const node = this.createNode('directory', name);
        parent.children.set(name, node);
        this.notify({ type: 'create', path: abs, fileType: 'directory' });
    }
    rmdir(path) {
        const abs = this.toAbsolute(path);
        const vp = this.getProvider(path);
        if (vp) {
            if (isMountProvider(vp.provider)) {
                vp.provider.rmdir(vp.subpath);
                return;
            }
            throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
        }
        const { parent, name } = this.resolveParent(path);
        const node = parent.children.get(name);
        if (!node) {
            throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
        }
        if (node.type !== 'directory') {
            throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
        }
        if (node.children.size > 0) {
            throw new VFSError(ErrorCode.ENOTEMPTY, `'${path}': directory not empty`);
        }
        parent.children.delete(name);
        this.notify({ type: 'delete', path: abs, fileType: 'directory' });
    }
    readdir(path) {
        const vp = this.getProvider(path);
        if (vp)
            return vp.provider.readdir(vp.subpath);
        const node = this.resolveNode(path);
        if (node.type !== 'directory') {
            throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
        }
        const entries = Array.from(node.children.values()).map((child) => ({
            name: child.name,
            type: child.type,
        }));
        // Inject mount point directories that are direct children of the current path
        const abs = this.toAbsolute(path);
        const prefix = abs === '/' ? '/' : abs + '/';
        for (const mount of this.mounts) {
            let candidate = null;
            if (abs === '/') {
                // At root: inject first segment of each mount path
                if (mount.path.startsWith('/') && mount.path !== '/') {
                    const segments = mount.path.slice(1).split('/');
                    candidate = segments[0];
                }
            }
            else if (mount.path.startsWith(prefix)) {
                // At a deeper directory: inject the next path segment after the prefix
                const remainder = mount.path.slice(prefix.length);
                const segments = remainder.split('/');
                candidate = segments[0];
            }
            if (candidate && !entries.some((e) => e.name === candidate)) {
                entries.push({ name: candidate, type: 'directory' });
            }
        }
        return entries;
    }
    readdirStat(path) {
        const vp = this.getProvider(path);
        if (vp) {
            return vp.provider.readdir(vp.subpath).map((d) => {
                const childSubpath = vp.subpath === '/' ? `/${d.name}` : `${vp.subpath}/${d.name}`;
                const s = vp.provider.stat(childSubpath);
                return { ...d, ...s };
            });
        }
        const node = this.resolveNode(path);
        if (node.type !== 'directory') {
            throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
        }
        return Array.from(node.children.values()).map((child) => {
            const entry = {
                name: child.name,
                type: child.type,
                size: child.type === 'file' ? (child.storedSize ?? child.data.length) : child.children.size,
                ctime: child.ctime,
                mtime: child.mtime,
                mode: child.mode,
            };
            if (child.mime) {
                entry.mime = child.mime;
            }
            return entry;
        });
    }
    /**
     * Recursively remove a directory and all its contents.
     */
    rmdirRecursive(path) {
        const node = this.resolveNode(path);
        if (node.type !== 'directory') {
            throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
        }
        const abs = this.toAbsolute(path);
        for (const child of node.children.values()) {
            const childPath = abs === '/' ? `/${child.name}` : `${abs}/${child.name}`;
            if (child.type === 'directory') {
                this.rmdirRecursive(childPath);
            }
            else {
                this.unlink(childPath);
            }
        }
        this.rmdir(abs);
    }
}
