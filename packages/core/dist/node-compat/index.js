/**
 * Node's modules over a session client (Kinu ask 67): `createNodeCompat`
 * gives `fs` and `fs/promises`, written once (node-compat/fs.ts), over the
 * file calls a client provides; `nodeFacesOf` makes those calls over a
 * Nimbus session. There is no synchronous face: a client's isolate cannot
 * wait, so every `*Sync` call that reaches the session throws EAGAIN, and
 * every asynchronous form works.
 */
import { errnoCodeOf, fsError } from '../vfs/vfs-error.js';
import { createNodeFs } from './fs.js';
export { createNodeFs } from './fs.js';
/** `fs` and `fs/promises` over `files`, relative paths taken from `cwd`. */
export function createNodeCompat({ files }, { cwd }) {
    const fs = createNodeFs({ async: completeFiles(files) }, { cwd });
    return { fs, fsPromises: fs.promises };
}
/** `path`'s stat, or null where nothing is there. */
async function statIfPresent(files, path) {
    try {
        return await files.stat(path);
    }
    catch (error) {
        if (errnoCodeOf(error) === 'ENOENT')
            return null;
        throw error;
    }
}
/** `files` with the calls Node's `fs` uses made from those it has: readFileString, exists, isFile, isDirectory. */
function completeFiles(files) {
    return {
        readFile: files.readFile.bind(files),
        writeFile: files.writeFile.bind(files),
        stat: files.stat.bind(files),
        lstat: files.lstat.bind(files),
        readdir: files.readdir.bind(files),
        readFileString: files.readFileString?.bind(files) ?? (async (path) => new TextDecoder().decode(await files.readFile(path))),
        // As Node's existsSync: a stat it cannot make (ENOTDIR below a file, EACCES) is a no.
        exists: files.exists?.bind(files) ?? (async (path) => {
            try {
                await files.stat(path);
                return true;
            }
            catch (error) {
                if (errnoCodeOf(error) !== undefined)
                    return false;
                throw error;
            }
        }),
        isFile: files.isFile?.bind(files) ?? (async (path) => (await statIfPresent(files, path))?.type === 'file'),
        isDirectory: files.isDirectory?.bind(files) ?? (async (path) => (await statIfPresent(files, path))?.type === 'directory'),
        appendFile: files.appendFile?.bind(files),
        realpath: files.realpath?.bind(files),
        symlink: files.symlink?.bind(files),
        readlink: files.readlink?.bind(files),
        mkdir: files.mkdir?.bind(files),
        unlink: files.unlink?.bind(files),
        rmdir: files.rmdir?.bind(files),
        rmdirRecursive: files.rmdirRecursive?.bind(files),
        rename: files.rename?.bind(files),
        copyFile: files.copyFile?.bind(files),
        chmod: files.chmod?.bind(files),
        chown: files.chown?.bind(files),
        truncate: files.truncate?.bind(files),
        open: files.open?.bind(files),
        read: files.read?.bind(files),
        write: files.write?.bind(files),
        fstat: files.fstat?.bind(files),
        fchown: files.fchown?.bind(files),
        ftruncate: files.ftruncate?.bind(files),
        fsync: files.fsync?.bind(files),
        close: files.close?.bind(files),
        watch: files.watch?.bind(files),
    };
}
const FILE_TYPES = { file: 'file', directory: 'directory', symlink: 'symlink' };
const DIRENT_TYPES = {
    file: 'file', directory: 'directory', symlink: 'symlink', character: 'character', block: 'block', fifo: 'fifo', socket: 'socket',
};
/** A session's stat as the filesystem's: a session older than the whole stat(2) leaves what it lacks at zero, its times at mtime. */
function runtimeStatOf(stat, syscall, path) {
    const type = FILE_TYPES[stat.type];
    if (type === undefined)
        throw fsError('EIO', syscall, path, undefined, { detail: `a file of type ${stat.type} the session names but Node's fs does not` });
    return {
        dev: stat.dev ?? 0, ino: stat.ino ?? 0, nlink: stat.nlink ?? 1, type, size: stat.size,
        ctime: stat.ctime ?? stat.mtime, atime: stat.atime ?? stat.mtime, mtime: stat.mtime,
        mode: stat.mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: stat.revision ?? 0,
    };
}
/** Node's `fs` calls over a Nimbus session's (`sandbox.files`); its absences are Node's ENOENT. */
export function nodeFacesOf(session) {
    const client = session.files;
    const statOf = async (path, follow) => {
        const syscall = follow ? 'stat' : 'lstat';
        const stat = follow ? await client.stat(path) : await client.lstat(path);
        if (stat === null)
            throw fsError('ENOENT', syscall, path);
        return runtimeStatOf(stat, syscall, path);
    };
    const files = {
        async readFile(path) {
            const bytes = await client.readBytes(path);
            if (bytes === null)
                throw fsError('ENOENT', 'open', path);
            return bytes;
        },
        async readFileString(path) {
            const text = await client.read(path);
            if (text === null)
                throw fsError('ENOENT', 'open', path);
            return text;
        },
        writeFile: (path, data) => client.write(path, data),
        exists: (path) => client.exists(path),
        stat: (path) => statOf(path, true),
        lstat: (path) => statOf(path, false),
        async readdir(path) {
            return (await client.list(path)).map((entry) => ({ name: entry.name, type: DIRENT_TYPES[entry.type] ?? 'unknown' }));
        },
        appendFile: (path, data) => client.appendFile(path, data),
        realpath: (path) => client.realpath(path),
        symlink: (target, path) => client.symlink(target, path),
        // readlink(2) tells no link (EINVAL) from nothing there (ENOENT), where the session answers null for both.
        async readlink(path) {
            const text = await client.readlink(path);
            if (text !== null)
                return text;
            throw fsError((await client.lstat(path)) === null ? 'ENOENT' : 'EINVAL', 'readlink', path);
        },
        mkdir: (path, options) => client.mkdir(path, { recursive: options?.recursive ?? false, ...(options?.mode === undefined ? {} : { mode: options.mode }) }),
        unlink: (path) => client.unlink(path),
        rmdir: (path) => client.rmdir(path),
        rmdirRecursive: (path) => client.delete(path, { recursive: true }),
        rename: (from, to) => client.rename(from, to),
        chmod: (path, mode) => client.chmod(path, mode),
        chown: (path, uid, gid, follow) => client.chown(path, uid, gid, { followSymlinks: follow }),
        truncate: (path, size) => client.truncate(path, size),
    };
    return { files };
}
