import { VFSError } from '../kernel/vfs/index.js';
/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one.
 */
export function synchronousFilesystem(view) {
    let opened = null;
    return () => {
        opened ??= view.local ?? bridgeFilesystem(view.authority);
        return opened;
    };
}
function bridgeFilesystem(bridge) {
    const fs = bridge.synchronous;
    if (!fs)
        throw new Error('This Node interpreter requires a synchronous filesystem capability; asynchronous hosts use the resident Node runtime');
    const read = (path) => {
        const data = fs.readFile(path);
        if (data === null)
            throw new VFSError('ENOENT', path);
        return data;
    };
    let listener;
    let unsubscribe;
    return {
        readFile: read,
        readFileString: path => new TextDecoder().decode(read(path)),
        writeFile(path, data) { fs.writeFile(path, data); },
        appendFile(path, data) {
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            const handle = fs.open(path, { write: true, append: true, create: true });
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
        exists: path => fs.stat(path) !== null,
        isFile: path => fs.stat(path)?.type === 'file',
        isDirectory: path => fs.stat(path)?.type === 'directory',
        stat(path) {
            const stat = fs.stat(path);
            if (!stat)
                throw new VFSError('ENOENT', path);
            return stat;
        },
        mkdir: (path, options) => fs.mkdir(path, options),
        readdir: path => fs.readdir(path),
        unlink: path => fs.unlink(path),
        rmdir: path => fs.rmdir(path),
        rmdirRecursive: path => fs.remove(path, { recursive: true }),
        rename: (from, to) => fs.rename(from, to),
        copyFile: (from, to) => fs.copyFile(from, to),
        chmod: (path, mode) => fs.chmod(path, mode),
        get onChange() { return listener; },
        set onChange(next) {
            unsubscribe?.();
            listener = next;
            unsubscribe = next ? bridge.subscribe?.('/', next) : undefined;
        },
    };
}
