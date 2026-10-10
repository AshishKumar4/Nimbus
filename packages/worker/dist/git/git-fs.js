/**
 * git/git-fs.ts — cf-git's `fs` over a backend: the session's filesystem
 * (git/commands.ts), or the git network facet's buffered writer
 * (pack/buffered-fs.ts). One adapter: paths normalized, text reads decoded,
 * inodes as Node's fs.Stats, failures as Node's errors.
 *
 * fs.promises.readFile takes its encoding bare as well as on an options
 * object, and cf-git uses both spellings ('utf8', and { encoding: 'utf8' }
 * everywhere else). An adapter that honours only the object form hands
 * those call sites bytes where they asked for text, and cf-git feeds the
 * result straight to `ignore().add()`, which silently accepts only strings,
 * so every .gitignore rule became a no-op.
 */
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
const FS_ERRORS = {
    ENOENT: [-2, 'no such file or directory'],
    ENOTDIR: [-20, 'not a directory'],
    EISDIR: [-21, 'illegal operation on a directory'],
    ENOTEMPTY: [-39, 'directory not empty'],
    EINVAL: [-22, 'invalid argument'],
    EIO: [-5, 'input/output error'],
    ELOOP: [-40, 'too many symbolic links encountered'],
};
/** Node's error for `code` at `filepath`, as `syscall` reports it. */
export function fsError(code, syscall, filepath, detail) {
    const [errno, message] = FS_ERRORS[code];
    return Object.assign(new Error(`${code}: ${message}, ${syscall} '${filepath}'${detail ? `: ${detail}` : ''}`), { code, errno });
}
function wantsUtf8(options) {
    const encoding = typeof options === 'string'
        ? options
        : options?.encoding;
    return encoding === 'utf8' || encoding === 'utf-8';
}
const TYPE_BITS = { file: 0o100000, dir: 0o040000, symlink: 0o120000 };
/** `st` as Node's fs.Stats: git's stat cache compares ctime, ino, uid and gid too. */
function nodeStats(st) {
    return {
        isFile: () => st.type === 'file',
        isDirectory: () => st.type === 'dir',
        isSymbolicLink: () => st.type === 'symlink',
        size: st.size,
        mode: TYPE_BITS[st.type] | (st.mode & 0o7777),
        mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs),
        ctimeMs: st.ctimeMs, ctime: new Date(st.ctimeMs),
        atimeMs: st.atimeMs, atime: new Date(st.atimeMs),
        uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, nlink: st.nlink,
        type: st.type,
    };
}
const decoder = new TextDecoder();
/** cf-git's `fs` over `backend`, with `packs` (pack/store.ts) its packs seam. */
export function createGitFs(backend, packs) {
    const statOf = async (filepath, follow) => {
        const st = await backend.stat(normalizeVfsPath(filepath), follow);
        if (st === null)
            throw fsError('ENOENT', follow ? 'stat' : 'lstat', filepath);
        return nodeStats(st);
    };
    return {
        packs,
        promises: {
            async readFile(filepath, options) {
                const data = await backend.readFile(normalizeVfsPath(filepath));
                if (data === null)
                    throw fsError('ENOENT', 'open', filepath);
                return wantsUtf8(options) ? decoder.decode(data) : data;
            },
            async writeFile(filepath, data, options) {
                const bytes = typeof data === 'string' || data instanceof Uint8Array ? data : new Uint8Array(data);
                await backend.writeFile(normalizeVfsPath(filepath), bytes, (Number(options?.mode) & 0o111) !== 0);
            },
            unlink: (filepath) => backend.unlink(normalizeVfsPath(filepath), filepath),
            readdir: (filepath) => backend.readdir(normalizeVfsPath(filepath), filepath),
            mkdir: (filepath) => backend.mkdir(normalizeVfsPath(filepath)),
            rmdir: (filepath, options) => backend.rmdir(normalizeVfsPath(filepath), filepath, options?.recursive === true),
            rm: (filepath) => backend.rmdir(normalizeVfsPath(filepath), filepath, true),
            stat: (filepath) => statOf(filepath, true),
            lstat: (filepath) => statOf(filepath, false),
            async chmod() { },
            symlink: (target, filepath) => backend.symlink(String(target), normalizeVfsPath(filepath)),
            readlink: (filepath) => backend.readlink(normalizeVfsPath(filepath), filepath),
        },
    };
}
