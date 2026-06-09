import { VFSError } from '../kernel/vfs/index.js';
import { resolve, basename } from '../utils/path.js';
import { encode, decode } from '../utils/encoding.js';
import { Readable, Writable } from './stream.js';
import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
function toNodeStat(stat) {
    const isFile = stat.type === 'file';
    const isDir = stat.type === 'directory';
    return {
        dev: 0,
        ino: 0,
        mode: stat.mode,
        nlink: isDir ? 2 : 1,
        uid: 1000,
        gid: 1000,
        rdev: 0,
        size: stat.size,
        blksize: 4096,
        blocks: Math.ceil(stat.size / 512),
        atimeMs: stat.mtime,
        mtimeMs: stat.mtime,
        ctimeMs: stat.ctime,
        birthtimeMs: stat.ctime,
        atime: new Date(stat.mtime),
        mtime: new Date(stat.mtime),
        ctime: new Date(stat.ctime),
        birthtime: new Date(stat.ctime),
        isFile: () => isFile,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
    };
}
function toNodeError(e, syscall, path) {
    const err = new Error(e.message);
    err.code = e.code;
    err.errno = -2;
    err.syscall = syscall;
    err.path = path;
    err.name = 'Error';
    return err;
}
function makeEnoent(syscall, path) {
    const err = new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`);
    err.code = 'ENOENT';
    err.errno = -2;
    err.syscall = syscall;
    err.path = path;
    return err;
}
function makeEbadf(syscall) {
    const err = new Error(`EBADF: bad file descriptor, ${syscall}`);
    err.code = 'EBADF';
    err.errno = -9;
    err.syscall = syscall;
    err.path = '';
    return err;
}
function resolvePath(cwd, p) {
    const str = typeof p === 'string' ? p : p.pathname;
    return resolve(cwd, str);
}
// ─── Open flags ───
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 64;
const O_TRUNC = 512;
const O_APPEND = 1024;
function parseFlags(flags) {
    if (typeof flags === 'number')
        return flags;
    switch (flags) {
        case 'r': return O_RDONLY;
        case 'r+': return O_RDWR;
        case 'w': return O_WRONLY | O_CREAT | O_TRUNC;
        case 'w+': return O_RDWR | O_CREAT | O_TRUNC;
        case 'a': return O_WRONLY | O_CREAT | O_APPEND;
        case 'a+': return O_RDWR | O_CREAT | O_APPEND;
        case 'ax': return O_WRONLY | O_CREAT | O_APPEND;
        default: return O_RDONLY;
    }
}
export function createFs(vfs, cwd) {
    // ─── File descriptor table ───
    const fdTable = new Map();
    let nextFd = 10; // start above stdin/stdout/stderr
    function getFd(fd) {
        const entry = fdTable.get(fd);
        if (!entry || entry.closed)
            throw makeEbadf('fd');
        return entry;
    }
    // ─── Sync API ───
    function readFileSync(path, options) {
        const encoding = typeof options === 'string' ? options : options?.encoding;
        const abs = resolvePath(cwd, path);
        if (encoding) {
            return vfs.readFileString(abs);
        }
        // Return Buffer (not raw Uint8Array) so .toString() yields UTF-8 text.
        // Many packages do JSON.parse(fs.readFileSync('package.json')) without
        // encoding, expecting Buffer.toString() to return the file contents.
        const raw = vfs.readFile(abs);
        return Buffer.from(raw);
    }
    function writeFileSync(path, data, _options) {
        const abs = resolvePath(cwd, path);
        vfs.writeFile(abs, data);
    }
    function appendFileSync(path, data) {
        const abs = resolvePath(cwd, path);
        vfs.appendFile(abs, data);
    }
    function existsSync(path) {
        const abs = resolvePath(cwd, path);
        return vfs.exists(abs);
    }
    function statSync(path) {
        const abs = resolvePath(cwd, path);
        return toNodeStat(vfs.stat(abs));
    }
    function lstatSync(path) {
        return statSync(path);
    }
    function mkdirSync(path, options) {
        const abs = resolvePath(cwd, path);
        const opts = typeof options === 'number' ? {} : options;
        vfs.mkdir(abs, { recursive: opts?.recursive });
    }
    function readdirSync(path, options) {
        const abs = resolvePath(cwd, path);
        const entries = vfs.readdir(abs);
        if (options?.withFileTypes) {
            return entries.map((e) => ({
                name: e.name,
                path: abs,
                isFile: () => e.type === 'file',
                isDirectory: () => e.type === 'directory',
                isSymbolicLink: () => false,
                isBlockDevice: () => false,
                isCharacterDevice: () => false,
                isFIFO: () => false,
                isSocket: () => false,
            }));
        }
        return entries.map((e) => e.name);
    }
    function unlinkSync(path) {
        const abs = resolvePath(cwd, path);
        vfs.unlink(abs);
    }
    function rmdirSync(path, options) {
        const abs = resolvePath(cwd, path);
        if (options?.recursive) {
            vfs.rmdirRecursive(abs);
        }
        else {
            vfs.rmdir(abs);
        }
    }
    function renameSync(oldPath, newPath) {
        const abs1 = resolvePath(cwd, oldPath);
        const abs2 = resolvePath(cwd, newPath);
        vfs.rename(abs1, abs2);
    }
    function copyFileSync(src, dest) {
        const abs1 = resolvePath(cwd, src);
        const abs2 = resolvePath(cwd, dest);
        vfs.copyFile(abs1, abs2);
    }
    function chmodSync(_path, _mode) {
        // No-op in VFS
    }
    function chownSync(_path, _uid, _gid) {
        // No-op in VFS
    }
    function accessSync(path, _mode) {
        const abs = resolvePath(cwd, path);
        if (!vfs.exists(abs)) {
            throw makeEnoent('access', abs);
        }
    }
    const realpathSync = Object.assign(function realpathSync(path) {
        const abs = resolvePath(cwd, path);
        if (!vfs.exists(abs)) {
            throw makeEnoent('realpath', abs);
        }
        return abs;
    }, {
        native: function realpathSyncNative(path) {
            const abs = resolvePath(cwd, path);
            if (!vfs.exists(abs)) {
                throw makeEnoent('realpath', abs);
            }
            return abs;
        },
    });
    function truncateSync(path, len) {
        const abs = resolvePath(cwd, path);
        const data = vfs.readFile(abs);
        const newLen = len ?? 0;
        if (newLen >= data.length)
            return;
        vfs.writeFile(abs, data.slice(0, newLen));
    }
    // ─── File descriptor sync API ───
    // NOTE: File descriptor operations work with mounted native filesystems via VFS
    // delegation. The fd table maps fds to VFS paths. When operations like readSync/
    // writeSync call vfs.readFile()/vfs.writeFile() on those paths, the VFS mount system
    // automatically delegates to the appropriate provider (e.g. NativeFsProvider).
    function openSync(path, flags, _mode) {
        const abs = resolvePath(cwd, path);
        const numFlags = parseFlags(flags ?? 'r');
        if (numFlags & O_CREAT) {
            if (!vfs.exists(abs)) {
                vfs.writeFile(abs, '');
            }
        }
        if (numFlags & O_TRUNC) {
            vfs.writeFile(abs, '');
        }
        if (!vfs.exists(abs)) {
            throw makeEnoent('open', abs);
        }
        const fd = nextFd++;
        fdTable.set(fd, {
            path: abs,
            position: (numFlags & O_APPEND) ? vfs.readFile(abs).length : 0,
            flags: typeof flags === 'string' ? flags : 'r',
            closed: false,
        });
        return fd;
    }
    function closeSync(fd) {
        const entry = getFd(fd);
        entry.closed = true;
        fdTable.delete(fd);
    }
    function readSync(fd, buffer, offset, length, position) {
        const entry = getFd(fd);
        const data = vfs.readFile(entry.path);
        const pos = position !== null ? position : entry.position;
        const available = Math.max(0, data.length - pos);
        const bytesToRead = Math.min(length, available);
        if (bytesToRead === 0)
            return 0;
        buffer.set(data.subarray(pos, pos + bytesToRead), offset);
        if (position === null) {
            entry.position = pos + bytesToRead;
        }
        return bytesToRead;
    }
    function writeSync(fd, bufferOrString, offsetOrPosition, lengthOrEncoding, position) {
        const entry = getFd(fd);
        let data;
        let pos;
        if (typeof bufferOrString === 'string') {
            data = encode(bufferOrString);
            pos = typeof offsetOrPosition === 'number' ? offsetOrPosition : entry.position;
        }
        else {
            const offset = offsetOrPosition ?? 0;
            const length = (typeof lengthOrEncoding === 'number' ? lengthOrEncoding : bufferOrString.length - offset);
            data = bufferOrString.subarray(offset, offset + length);
            pos = position !== null && position !== undefined ? position : entry.position;
        }
        const fileData = vfs.readFile(entry.path);
        const endPos = pos + data.length;
        const newSize = Math.max(fileData.length, endPos);
        const newData = new Uint8Array(newSize);
        newData.set(fileData, 0);
        newData.set(data, pos);
        vfs.writeFile(entry.path, newData);
        entry.position = endPos;
        return data.length;
    }
    function fstatSync(fd) {
        const entry = getFd(fd);
        return toNodeStat(vfs.stat(entry.path));
    }
    function ftruncateSync(fd, len) {
        const entry = getFd(fd);
        truncateSync(entry.path, len);
    }
    function fsyncSync(_fd) {
        // No-op - VFS is always in sync
    }
    function fdatasyncSync(_fd) {
        // No-op
    }
    // ─── Symlink stubs ───
    function symlinkSync(_target, _path, _type) {
        // No-op - VFS has no symlink support yet
    }
    function linkSync(_existingPath, _newPath) {
        // No-op
    }
    function readlinkSync(path) {
        // Return the path itself since we have no symlinks
        return resolvePath(cwd, path);
    }
    // ─── Callback API ───
    function wrapCallback(syncFn, cb) {
        queueMicrotask(() => {
            try {
                const result = syncFn();
                cb(null, result);
            }
            catch (e) {
                if (e instanceof VFSError) {
                    cb(toNodeError(e, '', ''));
                }
                else if (e.code) {
                    cb(e);
                }
                else {
                    throw e;
                }
            }
        });
    }
    function readFile(path, optionsOrCb, cb) {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        wrapCallback(() => readFileSync(path, options), callback);
    }
    function writeFile(path, data, optionsOrCb, cb) {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        wrapCallback(() => writeFileSync(path, data), callback);
    }
    function stat(path, cb) {
        wrapCallback(() => statSync(path), cb);
    }
    function lstat(path, cb) {
        wrapCallback(() => lstatSync(path), cb);
    }
    function mkdir(path, optionsOrCb, cb) {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        wrapCallback(() => mkdirSync(path, options), callback);
    }
    function readdir(path, optionsOrCb, cb) {
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        wrapCallback(() => readdirSync(path, options), callback);
    }
    function unlink(path, cb) {
        wrapCallback(() => unlinkSync(path), cb);
    }
    function rename(oldPath, newPath, cb) {
        wrapCallback(() => renameSync(oldPath, newPath), cb);
    }
    function access(path, modeOrCb, cb) {
        const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
        const mode = typeof modeOrCb === 'function' ? undefined : modeOrCb;
        wrapCallback(() => accessSync(path, mode), callback);
    }
    function exists(path, cb) {
        queueMicrotask(() => {
            cb(existsSync(path));
        });
    }
    function open(path, flagsOrCb, modeOrCb, cb) {
        let callback;
        let flags;
        let mode;
        if (typeof flagsOrCb === 'function') {
            callback = flagsOrCb;
            flags = 'r';
        }
        else if (typeof modeOrCb === 'function') {
            callback = modeOrCb;
            flags = flagsOrCb;
        }
        else {
            callback = cb;
            flags = flagsOrCb;
            mode = modeOrCb;
        }
        wrapCallback(() => openSync(path, flags, mode), callback);
    }
    function close(fd, cb) {
        wrapCallback(() => closeSync(fd), cb);
    }
    function read(fd, buffer, offset, length, position, cb) {
        wrapCallback(() => readSync(fd, buffer, offset, length, position), cb);
    }
    function fstat(fd, cb) {
        wrapCallback(() => fstatSync(fd), cb);
    }
    const realpath = Object.assign(function realpath(path, optOrCb, cb) {
        const callback = typeof optOrCb === 'function' ? optOrCb : cb;
        wrapCallback(() => realpathSync(path), callback);
    }, {
        native: function realpathNative(path, optOrCb, cb) {
            const callback = typeof optOrCb === 'function' ? optOrCb : cb;
            wrapCallback(() => realpathSync(path), callback);
        },
    });
    // ─── Stream API ───
    // NOTE: createReadStream works with mounted native filesystems via VFS delegation.
    // When the path is under a NativeFsProvider mount, vfs.readFile() delegates to the
    // mount provider, which reads from the real host filesystem. The data is still buffered
    // in memory before being pushed to the stream.
    function createReadStream(path, options) {
        const abs = resolvePath(cwd, path);
        const stream = new Readable();
        queueMicrotask(() => {
            try {
                const data = vfs.readFile(abs);
                const start = options?.start ?? 0;
                const end = options?.end !== undefined ? options.end + 1 : data.length;
                const slice = data.subarray(start, end);
                if (options?.encoding) {
                    stream.push(decode(slice));
                }
                else {
                    // Push as string since our Readable works with strings
                    stream.push(decode(slice));
                }
                stream.push(null);
            }
            catch (e) {
                stream.emit('error', e);
            }
        });
        return stream;
    }
    // NOTE: createWriteStream works with mounted native filesystems via VFS delegation.
    // When the path is under a NativeFsProvider mount, vfs.writeFile() and vfs.appendFile()
    // delegate to the mount provider, which writes to the real host filesystem.
    function createWriteStream(path, options) {
        const abs = resolvePath(cwd, path);
        const flags = options?.flags ?? 'w';
        const chunks = [];
        if (flags.includes('w')) {
            // Truncate on open
            try {
                vfs.writeFile(abs, '');
            }
            catch { /* parent may not exist yet */ }
        }
        const stream = new Writable();
        stream.write = (chunk, _encoding, cb) => {
            chunks.push(chunk);
            try {
                if (flags.includes('a')) {
                    vfs.appendFile(abs, chunk);
                }
                else {
                    vfs.writeFile(abs, chunks.join(''));
                }
            }
            catch (e) {
                stream.emit('error', e);
                return false;
            }
            if (cb)
                cb();
            return true;
        };
        stream.end = (chunk) => {
            if (chunk)
                stream.write(chunk);
            stream.emit('finish');
            stream.emit('close');
        };
        return stream;
    }
    // ─── Watch API ───
    function watch(filename, optionsOrListener, listener) {
        const abs = resolvePath(cwd, filename);
        const cb = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
        const watcher = new EventEmitter();
        // Use VFS onChange to detect changes (coarse-grained)
        const origOnChange = vfs.onChange;
        vfs.onChange = () => {
            origOnChange?.();
            const eventType = 'change';
            const name = basename(abs);
            if (cb)
                cb(eventType, name);
            watcher.emit('change', eventType, name);
        };
        watcher.close = () => {
            vfs.onChange = origOnChange;
        };
        return watcher;
    }
    // ─── Promises API ───
    const promises = {
        readFile: async (path, options) => readFileSync(path, options),
        writeFile: async (path, data) => writeFileSync(path, data),
        appendFile: async (path, data) => appendFileSync(path, data),
        stat: async (path) => statSync(path),
        lstat: async (path) => lstatSync(path),
        mkdir: async (path, options) => { mkdirSync(path, options); },
        readdir: async (path, options) => readdirSync(path, options),
        unlink: async (path) => unlinkSync(path),
        rmdir: async (path, options) => rmdirSync(path, options),
        rename: async (oldPath, newPath) => renameSync(oldPath, newPath),
        copyFile: async (src, dest) => copyFileSync(src, dest),
        access: async (path, mode) => accessSync(path, mode),
        realpath: async (path) => realpathSync(path),
        truncate: async (path, len) => truncateSync(path, len),
        chmod: async (_path, _mode) => { },
        chown: async (_path, _uid, _gid) => { },
        open: async (path, flags, mode) => {
            const fd = openSync(path, flags, mode);
            return {
                fd,
                close: async () => closeSync(fd),
                read: async (buffer, offset, length, position) => ({
                    bytesRead: readSync(fd, buffer, offset, length, position),
                    buffer,
                }),
                write: async (data) => ({
                    bytesWritten: writeSync(fd, data),
                }),
                stat: async () => fstatSync(fd),
                truncate: async (len) => ftruncateSync(fd, len),
            };
        },
        rm: async (path, options) => {
            const abs = resolvePath(cwd, path);
            try {
                const s = vfs.stat(abs);
                if (s.type === 'directory') {
                    if (options?.recursive) {
                        vfs.rmdirRecursive(abs);
                    }
                    else {
                        vfs.rmdir(abs);
                    }
                }
                else {
                    vfs.unlink(abs);
                }
            }
            catch (e) {
                if (options?.force && e instanceof VFSError && e.code === 'ENOENT')
                    return;
                throw e;
            }
        },
    };
    // ─── Constants ───
    const constants = {
        F_OK: 0,
        R_OK: 4,
        W_OK: 2,
        X_OK: 1,
        O_RDONLY,
        O_WRONLY,
        O_RDWR,
        O_CREAT,
        O_TRUNC,
        O_APPEND,
        COPYFILE_EXCL: 1,
        COPYFILE_FICLONE: 2,
        COPYFILE_FICLONE_FORCE: 4,
    };
    return {
        // Sync
        readFileSync,
        writeFileSync,
        appendFileSync,
        existsSync,
        statSync,
        lstatSync,
        mkdirSync,
        readdirSync,
        unlinkSync,
        rmdirSync,
        renameSync,
        copyFileSync,
        chmodSync,
        chownSync,
        accessSync,
        realpathSync,
        truncateSync,
        openSync,
        closeSync,
        readSync,
        writeSync,
        fstatSync,
        ftruncateSync,
        fsyncSync,
        fdatasyncSync,
        symlinkSync,
        linkSync,
        readlinkSync,
        // Callback
        readFile,
        writeFile,
        stat,
        lstat,
        mkdir,
        readdir,
        unlink,
        rename,
        access,
        exists,
        open,
        close,
        read,
        fstat,
        realpath,
        // Streams
        createReadStream,
        createWriteStream,
        // Watch
        watch,
        // Promises
        promises,
        // Constants
        constants,
    };
}
