import { VFSError, ErrorCode } from '../types.js';
/**
 * A MountProvider that delegates to a native filesystem via sync Node.js APIs.
 *
 * All subpaths are sandboxed to `rootPath` -- any attempt to escape via `..`
 * is rejected with EINVAL.
 */
export class NativeFsProvider {
    rootPath;
    fs;
    readOnly;
    constructor(rootPath, fsModule, options) {
        // Normalize: strip trailing slash unless it's the root itself
        this.rootPath = rootPath.endsWith('/') && rootPath.length > 1
            ? rootPath.slice(0, -1)
            : rootPath;
        this.fs = fsModule;
        this.readOnly = options?.readOnly ?? false;
    }
    // ─── Path sandboxing ───
    resolveSafe(subpath) {
        // Normalize the subpath: remove leading slash, resolve . and ..
        const clean = subpath.startsWith('/') ? subpath.slice(1) : subpath;
        const parts = clean.split('/').filter(Boolean);
        const resolved = [];
        for (const part of parts) {
            if (part === '.')
                continue;
            if (part === '..') {
                if (resolved.length === 0) {
                    throw new VFSError(ErrorCode.EINVAL, `path '${subpath}' escapes mount root`);
                }
                resolved.pop();
            }
            else {
                resolved.push(part);
            }
        }
        const relative = resolved.join('/');
        return relative ? `${this.rootPath}/${relative}` : this.rootPath;
    }
    assertWritable() {
        if (this.readOnly) {
            throw new VFSError(ErrorCode.EINVAL, 'filesystem is mounted read-only');
        }
    }
    // ─── Read operations ───
    readFile(subpath) {
        const fullPath = this.resolveSafe(subpath);
        try {
            return this.fs.readFileSync(fullPath);
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    readFileString(subpath) {
        const data = this.readFile(subpath);
        return new TextDecoder().decode(data);
    }
    exists(subpath) {
        const fullPath = this.resolveSafe(subpath);
        return this.fs.existsSync(fullPath);
    }
    stat(subpath) {
        const fullPath = this.resolveSafe(subpath);
        try {
            const s = this.fs.statSync(fullPath);
            return {
                type: s.isDirectory() ? 'directory' : 'file',
                size: s.size,
                ctime: Math.floor(s.ctimeMs),
                mtime: Math.floor(s.mtimeMs),
                mode: s.mode,
            };
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    readdir(subpath) {
        const fullPath = this.resolveSafe(subpath);
        try {
            const entries = this.fs.readdirSync(fullPath, { withFileTypes: true });
            return entries.map((e) => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : 'file',
            }));
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    // ─── Write operations ───
    writeFile(subpath, content) {
        this.assertWritable();
        const fullPath = this.resolveSafe(subpath);
        try {
            this.fs.writeFileSync(fullPath, content);
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    unlink(subpath) {
        this.assertWritable();
        const fullPath = this.resolveSafe(subpath);
        try {
            this.fs.unlinkSync(fullPath);
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    mkdir(subpath, options) {
        this.assertWritable();
        const fullPath = this.resolveSafe(subpath);
        try {
            this.fs.mkdirSync(fullPath, options);
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    rmdir(subpath) {
        this.assertWritable();
        const fullPath = this.resolveSafe(subpath);
        try {
            this.fs.rmdirSync(fullPath);
        }
        catch (err) {
            throw this.wrapError(err, subpath);
        }
    }
    rename(oldSubpath, newSubpath) {
        this.assertWritable();
        const oldFull = this.resolveSafe(oldSubpath);
        const newFull = this.resolveSafe(newSubpath);
        try {
            this.fs.renameSync(oldFull, newFull);
        }
        catch (err) {
            throw this.wrapError(err, newSubpath);
        }
    }
    copyFile(srcSubpath, destSubpath) {
        this.assertWritable();
        const srcFull = this.resolveSafe(srcSubpath);
        const destFull = this.resolveSafe(destSubpath);
        try {
            this.fs.copyFileSync(srcFull, destFull);
        }
        catch (err) {
            throw this.wrapError(err, destSubpath);
        }
    }
    // ─── Error mapping ───
    wrapError(err, subpath) {
        if (err instanceof VFSError)
            return err;
        const msg = err instanceof Error ? err.message : String(err);
        const code = err?.code;
        if (code === 'ENOENT')
            return new VFSError(ErrorCode.ENOENT, `'${subpath}': ${msg}`);
        if (code === 'EEXIST')
            return new VFSError(ErrorCode.EEXIST, `'${subpath}': ${msg}`);
        if (code === 'EISDIR')
            return new VFSError(ErrorCode.EISDIR, `'${subpath}': ${msg}`);
        if (code === 'ENOTDIR')
            return new VFSError(ErrorCode.ENOTDIR, `'${subpath}': ${msg}`);
        if (code === 'ENOTEMPTY')
            return new VFSError(ErrorCode.ENOTEMPTY, `'${subpath}': ${msg}`);
        return new VFSError(ErrorCode.EINVAL, `'${subpath}': ${msg}`);
    }
}
