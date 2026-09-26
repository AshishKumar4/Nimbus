import { resolve } from '../utils/path.js';
import { statOrThrow } from '../../../vfs/vfs.js';
/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export class SandboxFsImpl {
    vfs;
    getCwd;
    store;
    constructor(vfs, getCwd, 
    /** The SQLite filesystem the namespace is rooted at, for storeStats. */
    store) {
        this.vfs = vfs;
        this.getCwd = getCwd;
        this.store = store;
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
    /** How the session's content store is doing (its diagnostic; nothing in it is per-user). */
    async storeStats() { return this.store.storeStats(); }
}
