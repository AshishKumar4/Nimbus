import { errnoCodeOf, syscallError } from '../../../vfs/vfs-error.js';
/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one. What it
 * creates is made with `umask()`, the program's own mask (process.umask).
 */
export function synchronousFilesystem(view, umask) {
    let opened = null;
    return () => {
        opened ??= bridgeFilesystem(view.process, umask);
        return opened;
    };
}
function bridgeFilesystem(bridge, umask) {
    const fs = bridge.synchronous;
    if (!fs)
        throw new Error('This Node interpreter requires a synchronous filesystem capability; asynchronous hosts use the resident Node runtime');
    const read = (path) => {
        const data = fs.readFile(path);
        if (data === null)
            throw syscallError('ENOENT', 'open', path);
        return data;
    };
    return {
        readFile: read,
        readFileString: path => new TextDecoder().decode(read(path)),
        writeFile(path, data) { fs.writeFile(path, data, { umask: umask() }); },
        appendFile(path, data) {
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            const handle = fs.open(path, { write: true, append: true, create: true, umask: umask() });
            try {
                let offset = 0;
                while (offset < bytes.length) {
                    const count = fs.write(handle.id, null, bytes.subarray(offset));
                    if (count <= 0 || count > bytes.length - offset)
                        throw new Error('EIO: invalid append write length');
                    offset += count;
                }
            }
            finally {
                fs.close(handle.id);
            }
        },
        // As Node's existsSync: a stat it cannot make (ENOTDIR below a file, EACCES) is a no.
        exists: path => {
            try {
                return fs.stat(path) !== null;
            }
            catch (error) {
                if (errnoCodeOf(error) !== undefined)
                    return false;
                throw error;
            }
        },
        isFile: path => fs.stat(path)?.type === 'file',
        isDirectory: path => fs.stat(path)?.type === 'directory',
        stat(path) {
            const stat = fs.stat(path);
            if (!stat)
                throw syscallError('ENOENT', 'stat', path);
            return stat;
        },
        lstat(path) {
            const stat = fs.stat(path, { followSymlinks: false });
            if (!stat)
                throw syscallError('ENOENT', 'lstat', path);
            return stat;
        },
        realpath: path => fs.realpath(path),
        mkdir: (path, options) => fs.mkdir(path, { ...options, umask: umask() }),
        readdir: path => fs.readdir(path),
        unlink: path => fs.unlink(path),
        rmdir: path => fs.rmdir(path),
        rmdirRecursive: path => fs.remove(path, { recursive: true }),
        rename: (from, to) => fs.rename(from, to),
        copyFile: (from, to) => fs.copyFile(from, to),
        chmod: (path, mode) => fs.chmod(path, mode),
        chown: (path, uid, gid, follow) => { fs.chown(path, uid, gid, { followSymlinks: follow }); },
        open: (path, flags) => fs.open(path, { ...flags, umask: umask() }).id,
        read: (fd, position, length) => fs.read(fd, position, length),
        write: (fd, position, data) => fs.write(fd, position, data),
        fstat: (fd) => fs.fstat(fd),
        fchown: (fd, uid, gid) => fs.fchown(fd, uid, gid),
        ftruncate: (fd, size) => fs.ftruncate(fd, size),
        fsync: (fd) => fs.fsync(fd),
        close: (fd) => fs.close(fd),
        watch(path, listener) {
            // A Node watch is of its target, as an inode's is: it follows it across renames.
            const stop = bridge.subscribe?.(path, (event) => listener(event.oldPath === undefined
                ? { ...event, path: `/${event.path}` }
                : { ...event, path: `/${event.path}`, oldPath: `/${event.oldPath}` }), { follow: true });
            return { close: () => stop?.(), ref() { }, unref() { } };
        },
    };
}
