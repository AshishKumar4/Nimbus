import { resolve, dirname } from '../utils/path.js';
import { createTar, parseTar, compressGzip, decompressGzip } from '../utils/archive.js';
/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export class SandboxFsImpl {
    vfs;
    getCwd;
    constructor(vfs, getCwd) {
        this.vfs = vfs;
        this.getCwd = getCwd;
    }
    resolvePath(path) {
        return resolve(this.getCwd(), path);
    }
    readFile(path, encoding) {
        const abs = this.resolvePath(path);
        if (encoding === null) {
            return Promise.resolve(this.vfs.readFile(abs));
        }
        return Promise.resolve(this.vfs.readFileString(abs));
    }
    async writeFile(path, content) {
        const abs = this.resolvePath(path);
        this.vfs.writeFile(abs, content);
    }
    async readdir(path) {
        const abs = this.resolvePath(path);
        return this.vfs.readdir(abs);
    }
    async stat(path) {
        const abs = this.resolvePath(path);
        const s = this.vfs.stat(abs);
        return { type: s.type, size: s.size, mtime: s.mtime };
    }
    async mkdir(path, options) {
        const abs = this.resolvePath(path);
        this.vfs.mkdir(abs, options);
    }
    async rm(path, options) {
        const abs = this.resolvePath(path);
        const s = this.vfs.stat(abs);
        if (s.type === 'directory') {
            if (options?.recursive) {
                this.vfs.rmdirRecursive(abs);
            }
            else {
                this.vfs.rmdir(abs);
            }
        }
        else {
            this.vfs.unlink(abs);
        }
    }
    async exists(path) {
        const abs = this.resolvePath(path);
        return this.vfs.exists(abs);
    }
    async rename(oldPath, newPath) {
        const absOld = this.resolvePath(oldPath);
        const absNew = this.resolvePath(newPath);
        this.vfs.rename(absOld, absNew);
    }
    async cp(src, dest) {
        const absSrc = this.resolvePath(src);
        const absDest = this.resolvePath(dest);
        this.vfs.copyFile(absSrc, absDest);
    }
    async writeFiles(files) {
        for (const { path, content } of files) {
            await this.writeFile(path, content);
        }
    }
    /** Directories to skip during export (virtual providers) */
    static SKIP_DIRS = new Set(['/proc', '/dev']);
    async exportSnapshot() {
        const entries = [];
        const walk = (absPath) => {
            if (SandboxFsImpl.SKIP_DIRS.has(absPath))
                return;
            const stat = this.vfs.stat(absPath);
            if (stat.type === 'directory') {
                // Add directory entry (skip root itself)
                if (absPath !== '/') {
                    entries.push({
                        path: absPath,
                        data: new Uint8Array(0),
                        type: 'directory',
                        mode: stat.mode,
                        mtime: stat.mtime,
                    });
                }
                const children = this.vfs.readdir(absPath);
                for (const child of children) {
                    const childPath = absPath === '/' ? `/${child.name}` : `${absPath}/${child.name}`;
                    walk(childPath);
                }
            }
            else {
                entries.push({
                    path: absPath,
                    data: this.vfs.readFile(absPath),
                    type: 'file',
                    mode: stat.mode,
                    mtime: stat.mtime,
                });
            }
        };
        walk('/');
        const tar = createTar(entries);
        return compressGzip(tar);
    }
    async importSnapshot(data) {
        const tar = await decompressGzip(data);
        const entries = parseTar(tar);
        // Process directories first, then files, to ensure parents exist
        const dirs = entries.filter((e) => e.type === 'directory');
        const files = entries.filter((e) => e.type === 'file');
        for (const entry of dirs) {
            const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
            if (!this.vfs.exists(path)) {
                this.vfs.mkdir(path, { recursive: true });
            }
        }
        for (const entry of files) {
            const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
            // Ensure parent directory exists
            const parent = dirname(path);
            if (parent !== '/' && !this.vfs.exists(parent)) {
                this.vfs.mkdir(parent, { recursive: true });
            }
            this.vfs.writeFile(path, entry.data);
        }
    }
}
