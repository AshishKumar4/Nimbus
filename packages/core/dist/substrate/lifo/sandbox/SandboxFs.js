import { W_OK, X_OK } from '../../../runtime/process-files.js';
import { isVfsError, VfsError } from '../../../vfs/vfs-error.js';
import { resolve, dirname } from '../utils/path.js';
import { statOrThrow } from '../../../vfs/vfs.js';
/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export class SandboxFsImpl {
    vfs;
    getCwd;
    store;
    cred;
    constructor(vfs, getCwd, 
    /** The SQLite filesystem the namespace is rooted at: what snapshots pin. */
    store, 
    /** Who this handle acts as (a snapshot view and restore's check use it). */
    cred) {
        this.vfs = vfs;
        this.getCwd = getCwd;
        this.store = store;
        this.cred = cred;
    }
    resolvePath(path) {
        return resolve(this.getCwd(), path);
    }
    async readFile(path, encoding) {
        const abs = this.resolvePath(path);
        if (encoding === null) {
            return Promise.resolve((await this.vfs.readFile(abs)));
        }
        return Promise.resolve((await this.vfs.readFileString(abs)));
    }
    async writeFile(path, content) {
        const abs = this.resolvePath(path);
        (await this.vfs.writeFile(abs, content));
    }
    async readdir(path) {
        const abs = this.resolvePath(path);
        return (await this.vfs.readdir(abs));
    }
    async stat(path) {
        const abs = this.resolvePath(path);
        const s = await statOrThrow(this.vfs, abs);
        return { type: s.type, size: s.size, mtime: s.mtimeMs };
    }
    async mkdir(path, options) {
        const abs = this.resolvePath(path);
        (await this.vfs.mkdir(abs, options));
    }
    async rm(path, options) {
        const abs = this.resolvePath(path);
        const s = await statOrThrow(this.vfs, abs);
        if (s.type === 'directory') {
            if (options?.recursive) {
                (await this.vfs.remove(abs, { recursive: true }));
            }
            else {
                (await this.vfs.rmdir(abs));
            }
        }
        else {
            (await this.vfs.unlink(abs));
        }
    }
    async exists(path) {
        const abs = this.resolvePath(path);
        return (await this.vfs.exists(abs));
    }
    async rename(oldPath, newPath) {
        const absOld = this.resolvePath(oldPath);
        const absNew = this.resolvePath(newPath);
        (await this.vfs.rename(absOld, absNew));
    }
    async cp(src, dest) {
        const absSrc = this.resolvePath(src);
        const absDest = this.resolvePath(dest);
        (await this.vfs.copy(absSrc, absDest));
    }
    async writeFiles(files) {
        for (const { path, content } of files) {
            await this.writeFile(path, content);
        }
    }
    // ── The content store ──
    async snapshot(name, options = {}) {
        return options.quiesce ? await this.store.snapshot(name, { quiesce: true }) : this.store.snapshot(name);
    }
    async snapshots() { return this.store.snapshots(); }
    async dropSnapshot(name) { return this.store.dropSnapshot(name); }
    async diff(from, to, options) {
        return this.store.diff(from, to, options);
    }
    at(name) {
        const view = this.store.at(name, this.cred);
        const key = (path) => this.resolvePath(path).replace(/^\/+/, '');
        const reader = {
            async readFile(path, encoding) {
                return encoding === null ? view.readFile(key(path)) : view.readFileString(key(path));
            },
            async readdir(path) { return view.readdir(key(path)); },
            async stat(path) { const s = view.stat(key(path)); return { type: s.type, size: s.size, mtime: s.mtime }; },
            async exists(path) { return view.exists(key(path)); },
            async writeFile(path) { throw new VfsError('EROFS', 'a snapshot is read-only', path); },
        };
        return reader;
    }
    async restore(name, options = {}) {
        const subtree = options.subtree === undefined ? undefined : this.resolvePath(options.subtree);
        await this.assertRestorable(name, subtree);
        return await this.store.restoreAsync(name, subtree === undefined ? {} : { subtree });
    }
    /**
     * Whether the session user may write every path `restore(name)` would
     * change: the file itself for a rewrite, its parent for a name that
     * appears or goes. The first it may not is EACCES, before any change.
     */
    async assertRestorable(name, subtree) {
        const within = subtree === undefined ? null : subtree.replace(/^\/+/, '');
        for (let after;;) {
            const page = this.store.diff(name, null, { after });
            for (const entry of page.entries) {
                if (within !== null && within !== '' && entry.path !== within && !entry.path.startsWith(`${within}/`))
                    continue;
                const path = `/${entry.path}`;
                const target = entry.change === 'modified' ? path : dirname(path);
                try {
                    await this.vfs.access(target, entry.change === 'modified' ? W_OK : W_OK | X_OK);
                }
                catch (error) {
                    if (isVfsError(error, 'ENOENT') && entry.change !== 'modified')
                        continue;
                    throw new VfsError('EACCES', 'restore would change a path the session user cannot write', path);
                }
            }
            if (page.next === null)
                return;
            after = page.next;
        }
    }
    async exportPage(options) {
        return this.store.exportPage({ ...options, root: options.root === undefined ? undefined : this.resolvePath(options.root) });
    }
    async exportChunks(hashes) { return this.store.exportChunks(hashes); }
    async importPage(dst, page, chunks) {
        const target = this.resolvePath(dst);
        // The session user makes `dst` (or writes into it): its parent must be theirs to write.
        if (await this.vfs.exists(target))
            await this.vfs.access(target, W_OK | X_OK);
        else
            await this.vfs.access(dirname(target), W_OK | X_OK);
        return this.store.importPage(target, page, chunks);
    }
    async pageDigest(options) {
        return this.store.pageDigest({ ...options, root: options.root === undefined ? undefined : this.resolvePath(options.root) });
    }
    async storeStats() { return this.store.storeStats(); }
}
