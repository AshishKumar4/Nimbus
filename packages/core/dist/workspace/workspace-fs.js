/**
 * The namespace as a process with a working directory sees it: the face an
 * embedder holds as `NimbusWorkspace.fs`.
 *
 * A ProcessView takes every path from the root: a relative path is a key
 * under `/` ('etc/passwd' is /etc/passwd), and that is what Nimbus's own
 * code hands it. This is the same view with a working directory of its own,
 * as a process has one. An absolute path means what it means to the view,
 * and a relative one is taken from `cwd`, as open(2) takes it: `..` is left
 * to the walk, which takes it after a link, as the kernel does.
 *
 * The two are different types on purpose. Neither is assignable to the
 * other, so a root-relative key never reaches a view that would read it
 * from a working directory, and a user's relative path never reaches one
 * that would read it from the root.
 */
import { move } from '../vfs/move.js';
import { syscallError, VfsError } from '../vfs/vfs-error.js';
export class WorkspaceFs {
    view;
    cwd;
    constructor(view, 
    /** Where a relative path starts: this view's own, which no `cd` in a shell moves. */
    cwd) {
        this.view = view;
        this.cwd = cwd;
        if (!cwd.startsWith('/'))
            throw new TypeError(`a working directory is an absolute path, got ${JSON.stringify(cwd)}`);
    }
    /**
     * The absolute path this view's operations use for `path`: itself when it
     * is absolute, else from `cwd`, with `.` components dropped and `..` kept
     * for the walk. An empty path names nothing (ENOENT), as in open(2).
     */
    resolve(path) {
        if (path === '')
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (path.startsWith('/'))
            return path;
        const rest = path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
        if (rest === '')
            return this.cwd;
        // A trailing slash says the name is a directory; it stays.
        return `${this.cwd === '/' ? '' : this.cwd}/${rest}${/\/\.?$/.test(path) ? '/' : ''}`;
    }
    /**
     * `path` resolved, for a call that removes or replaces the entry it names:
     * a last component of `.` or `..` names a directory by its relation to
     * another, and is refused with the code Linux gives `syscall`, never
     * taken as the directory itself.
     */
    entry(path, syscall) {
        const last = path.replace(/\/+$/, '').split('/').pop();
        if (last === '.' || last === '..') {
            const codes = { unlink: 'EISDIR', rmdir: last === '..' ? 'ENOTEMPTY' : 'EINVAL', rm: 'EINVAL', rename: 'EBUSY' };
            throw syscallError(codes[syscall], syscall, path);
        }
        return this.resolve(path);
    }
    async stat(path, options) { return await this.view.stat(this.resolve(path), options); }
    /** Whether anything is at `path` (links followed). */
    async exists(path) { return await this.view.exists(this.resolve(path)); }
    async isFile(path) { return await this.view.isFile(this.resolve(path)); }
    async isDirectory(path) { return await this.view.isDirectory(this.resolve(path)); }
    /** Whether `path` itself is a symbolic link. */
    async isSymlink(path) { return await this.view.isSymlink(this.resolve(path)); }
    /** The file's bytes as UTF-8 text. */
    async readFileString(path) { return await this.view.readFileString(this.resolve(path)); }
    async readFile(path) { return await this.view.readFile(this.resolve(path)); }
    /** `mode` applies only if this creates the file (ProcessView.writeFile). */
    async writeFile(path, data, options) {
        return await this.view.writeFile(this.resolve(path), data, options);
    }
    async readdir(path) { return await this.view.readdir(this.resolve(path)); }
    async mkdir(path, options) { return await this.view.mkdir(this.resolve(path), options); }
    async unlink(path) { return await this.view.unlink(this.entry(path, 'unlink')); }
    async rmdir(path) { return await this.view.rmdir(this.entry(path, 'rmdir')); }
    /** rename(2): EXDEV across filesystems, where {@link move} copies. */
    async rename(from, to) { return await this.view.rename(this.entry(from, 'rename'), this.entry(to, 'rename')); }
    /**
     * mv: one rename, or across filesystems (and on one that cannot rename in
     * place) a copy that happens whole or not at all, directories included.
     * `to` is the new name, as rename's is. See vfs/move.ts.
     */
    async move(from, to, options) {
        await move(this.view, this.entry(from, 'rename'), this.entry(to, 'rename'), options);
    }
    async readRange(path, offset, length) { return await this.view.readRange(this.resolve(path), offset, length); }
    /** A ranged read that neither consults nor fills the session's content cache. */
    async readRangeUncached(path, offset, length) {
        return await this.view.readRangeUncached(this.resolve(path), offset, length);
    }
    async writeRange(path, offset, bytes) { return await this.view.writeRange(this.resolve(path), offset, bytes); }
    /** writeFile of `size` bytes that arrive over time, published whole once they have. */
    async writeFileFrom(path, size, source) {
        return await this.view.writeFileFrom(this.resolve(path), size, source);
    }
    async truncate(path, size) { return await this.view.truncate(this.resolve(path), size); }
    /** rm -r, with what went and what is still there (ProcessView.removeRecursive). */
    async removeRecursive(path) { return await this.view.removeRecursive(this.entry(path, 'rm')); }
    /** `target` is the link's text, taken from the link's directory when it is followed, never from `cwd`. */
    async symlink(target, path) { return await this.view.symlink(target, this.resolve(path)); }
    async readlink(path) { return await this.view.readlink(this.resolve(path)); }
    async chmod(path, mode) { return await this.view.chmod(this.resolve(path), mode); }
    /** chown(2): a null side keeps what the file has (chown -1). */
    async chown(path, uid, gid) { return await this.view.chown(this.resolve(path), uid, gid); }
    /** utimensat(2): null is now, undefined leaves that time; `follow: false` sets a link's own times. */
    async utimes(path, atimeMs, mtimeMs, options) {
        return await this.view.utimes(this.resolve(path), atimeMs, mtimeMs, options);
    }
    /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
    async copy(from, to, options) {
        return await this.view.copy(this.resolve(from), this.resolve(to), options);
    }
    /** Create the file if absent, and set its times to now (touch). */
    async touch(path) { return await this.view.touch(this.resolve(path)); }
    async readFileUncached(path) { return await this.view.readFileUncached(this.resolve(path)); }
    async readArrayBufferUncached(path) { return await this.view.readArrayBufferUncached(this.resolve(path)); }
    /** rm: a file, or with `recursive` a tree, whole or not at all; `force` makes a missing path no error. */
    async remove(path, options) { return await this.view.remove(this.entry(path, 'rm'), options); }
    /** Each entry of a directory with its own stat (links not followed). */
    async readdirStat(path) { return await this.view.readdirStat(this.resolve(path)); }
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    async access(path, mode) { return await this.view.access(this.resolve(path), mode); }
    /** Where `path` leads with every link followed: an absolute path. */
    async realpath(path) { return await this.view.realpath(this.resolve(path)); }
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    async appendFile(path, content) { return await this.view.appendFile(this.resolve(path), content); }
}
