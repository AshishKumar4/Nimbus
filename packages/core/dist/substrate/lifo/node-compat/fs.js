import { resolve, basename } from '../utils/path.js';
import { encode, decode } from '../utils/encoding.js';
import { Readable, Writable } from './stream.js';
import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
import { fsError, isVfsError } from '../../../vfs/vfs-error.js';
import { DIRENT_TYPES, direntTypeOfStat } from '../../../vfs/dirent-type.js';
import { S_IFMT } from '../../../vfs/vfs.js';
/**
 * Node's Stats for a filesystem stat: its identity, links, owner, mode and
 * times as the filesystem has them (no birth time is kept: ctime stands in),
 * the mode with its type's format bits where the filesystem's has none.
 */
function toNodeStat(stat) {
    const type = DIRENT_TYPES[direntTypeOfStat(stat)];
    const holds = type.node;
    return {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode & S_IFMT ? stat.mode : type.format | stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        rdev: 0,
        size: stat.size,
        blksize: 4096,
        blocks: Math.ceil(stat.size / 512),
        atimeMs: stat.atime,
        mtimeMs: stat.mtime,
        ctimeMs: stat.ctime,
        birthtimeMs: stat.ctime,
        atime: new Date(stat.atime),
        mtime: new Date(stat.mtime),
        ctime: new Date(stat.ctime),
        birthtime: new Date(stat.ctime),
        isFile: () => holds === 'isFile',
        isDirectory: () => holds === 'isDirectory',
        isSymbolicLink: () => holds === 'isSymbolicLink',
        isBlockDevice: () => holds === 'isBlockDevice',
        isCharacterDevice: () => holds === 'isCharacterDevice',
        isFIFO: () => holds === 'isFIFO',
        isSocket: () => holds === 'isSocket',
    };
}
function resolvePath(cwd, p) {
    const str = typeof p === 'string' ? p : p.pathname;
    return resolve(cwd, str);
}
// ─── Open flags ───
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_ACCMODE = 3;
const O_CREAT = 64;
const O_EXCL = 128;
const O_TRUNC = 512;
const O_APPEND = 1024;
const O_DIRECTORY = 65536;
const O_NOFOLLOW = 131072;
const O_SYNC = 1052672;
/** Node's flag strings (stringToFlags), as bits. */
const FLAG_STRINGS = {
    r: O_RDONLY, rs: O_RDONLY | O_SYNC, sr: O_RDONLY | O_SYNC,
    'r+': O_RDWR, 'rs+': O_RDWR | O_SYNC, 'sr+': O_RDWR | O_SYNC,
    w: O_TRUNC | O_CREAT | O_WRONLY, wx: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL, xw: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
    'w+': O_TRUNC | O_CREAT | O_RDWR, 'wx+': O_TRUNC | O_CREAT | O_RDWR | O_EXCL, 'xw+': O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
    a: O_APPEND | O_CREAT | O_WRONLY, ax: O_APPEND | O_CREAT | O_WRONLY | O_EXCL, xa: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
    as: O_APPEND | O_CREAT | O_WRONLY | O_SYNC, sa: O_APPEND | O_CREAT | O_WRONLY | O_SYNC,
    'a+': O_APPEND | O_CREAT | O_RDWR, 'ax+': O_APPEND | O_CREAT | O_RDWR | O_EXCL, 'xa+': O_APPEND | O_CREAT | O_RDWR | O_EXCL,
    'as+': O_APPEND | O_CREAT | O_RDWR | O_SYNC, 'sa+': O_APPEND | O_CREAT | O_RDWR | O_SYNC,
};
/** An open's flags, as Node takes them (a string or bits), for the process's open: the decisions are its. */
function openFlagsOf(flags, mode) {
    const bits = flags === undefined ? O_RDONLY : typeof flags === 'number' ? flags : FLAG_STRINGS[flags];
    if (bits === undefined) {
        throw Object.assign(new TypeError(`The argument 'flags' is invalid. Received '${String(flags)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    const access = bits & O_ACCMODE;
    return {
        read: access !== O_WRONLY,
        write: access !== O_RDONLY,
        append: (bits & O_APPEND) !== 0,
        create: (bits & O_CREAT) !== 0,
        exclusive: (bits & O_EXCL) !== 0,
        truncate: (bits & O_TRUNC) !== 0,
        directory: (bits & O_DIRECTORY) !== 0,
        followSymlinks: (bits & O_NOFOLLOW) === 0,
        ...((bits & O_SYNC) === O_SYNC ? { sync: true } : {}),
        ...(mode === undefined ? {} : { mode }),
    };
}
/** A position as Node takes it: null or -1 is the descriptor's own offset. */
function positionOf(position) {
    return position === undefined || position === null || position === -1 ? null : position;
}
/** The paths that name fd 0. */
const STDIN_PATHS = { '/dev/stdin': true, '/dev/fd/0': true, '/proc/self/fd/0': true };
/**
 * `stdin` reads fd 0 to its end, blocking until it ends, as a synchronous
 * read of it does in Node; what it returned is all fd 0 holds, so a second
 * read finds it at its end.
 */
export function createFs(vfs, cwd, stdin) {
    let stdinRead = false;
    const readStdin = () => {
        if (stdinRead)
            return new Uint8Array(0);
        stdinRead = true;
        return stdin ? stdin() : new Uint8Array(0);
    };
    // ─── File descriptors ───
    // A descriptor is the process's own (NodeFilesystem.open): its file,
    // offset, rights and O_APPEND are the process's descriptor table's, shared
    // with fs/promises and anything else the process opens. Node's 0, 1 and 2
    // are its standard streams, so a descriptor numbers the process's 1 as 3.
    const STDIO = 3;
    /** `fd`'s call `syscall` on the process's descriptor: EBADF as Node says it, for no descriptor or one without the right. */
    function onDescriptor(fd, syscall, run) {
        if (!Number.isSafeInteger(fd) || fd < STDIO)
            throw fsError('EBADF', syscall);
        try {
            return run(fd - STDIO + 1);
        }
        catch (error) {
            if (error.code === 'EBADF')
                throw fsError('EBADF', syscall);
            throw error;
        }
    }
    // ─── Sync API ───
    function readFileSync(path, options) {
        const encoding = typeof options === 'string' ? options : options?.encoding;
        if (path === 0 || (typeof path === 'string' && Object.hasOwn(STDIN_PATHS, path))) {
            const bytes = readStdin();
            return encoding ? new TextDecoder().decode(bytes) : Buffer.from(bytes);
        }
        if (typeof path === 'number') {
            // From the descriptor's offset to the end, as Node reads a descriptor.
            const parts = [];
            for (let part = readDescriptor(path, null, 65536); part.byteLength > 0; part = readDescriptor(path, null, 65536))
                parts.push(part);
            const bytes = Buffer.concat(parts);
            return encoding ? new TextDecoder().decode(bytes) : bytes;
        }
        const abs = resolvePath(cwd, path);
        try {
            if (encoding) {
                return vfs.readFileString(abs);
            }
            // Return Buffer (not raw Uint8Array) so .toString() yields UTF-8 text.
            // Many packages do JSON.parse(fs.readFileSync('package.json')) without
            // encoding, expecting Buffer.toString() to return the file contents.
            const raw = vfs.readFile(abs);
            return Buffer.from(raw);
        }
        catch (e) {
            // Node opens a directory, then fails to read it: the error is read's,
            // on the descriptor, with no path.
            if (e.code === 'EISDIR')
                throw fsError('EISDIR', 'read');
            throw e;
        }
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
        return toNodeStat(vfs.lstat(resolvePath(cwd, path)));
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
            // d_type, or where the backend cannot say, lstat's.
            return entries.map((e) => {
                const holds = DIRENT_TYPES[e.type === 'unknown' ? direntTypeOfStat(vfs.lstat(resolvePath(abs, e.name))) : e.type].node;
                return {
                    name: e.name,
                    path: abs,
                    isFile: () => holds === 'isFile',
                    isDirectory: () => holds === 'isDirectory',
                    isSymbolicLink: () => holds === 'isSymbolicLink',
                    isBlockDevice: () => holds === 'isBlockDevice',
                    isCharacterDevice: () => holds === 'isCharacterDevice',
                    isFIFO: () => holds === 'isFIFO',
                    isSocket: () => holds === 'isSocket',
                };
            });
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
    function chmodSync(path, mode) {
        vfs.chmod(resolvePath(cwd, path), mode);
    }
    function chownSync(_path, _uid, _gid) {
        // No-op in VFS
    }
    function accessSync(path, _mode) {
        const abs = resolvePath(cwd, path);
        if (!vfs.exists(abs)) {
            throw fsError('ENOENT', 'access', abs);
        }
    }
    const realpathSync = Object.assign(function realpathSync(path) {
        const abs = resolvePath(cwd, path);
        // Node's realpathSync lstats the path's components: a missing one is lstat's.
        if (!vfs.exists(abs)) {
            throw fsError('ENOENT', 'lstat', abs);
        }
        return abs;
    }, {
        native: function realpathSyncNative(path) {
            const abs = resolvePath(cwd, path);
            if (!vfs.exists(abs)) {
                throw fsError('ENOENT', 'realpath', abs);
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
    function openSync(path, flags, mode) {
        return vfs.open(resolvePath(cwd, path), openFlagsOf(flags, mode)) - 1 + STDIO;
    }
    function closeSync(fd) {
        onDescriptor(fd, 'close', (id) => vfs.close(id));
    }
    function readDescriptor(fd, position, length) {
        return onDescriptor(fd, 'read', (id) => vfs.read(id, position, length));
    }
    function readSync(fd, buffer, offset = 0, length = buffer.byteLength - offset, position) {
        const bytes = readDescriptor(fd, positionOf(position), length);
        buffer.set(bytes, offset);
        return bytes.byteLength;
    }
    function writeSync(fd, bufferOrString, offsetOrPosition, lengthOrEncoding, position) {
        let data;
        let at;
        if (typeof bufferOrString === 'string') {
            data = encode(bufferOrString);
            at = positionOf(offsetOrPosition);
        }
        else {
            const offset = offsetOrPosition ?? 0;
            const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : bufferOrString.length - offset;
            data = bufferOrString.subarray(offset, offset + length);
            at = positionOf(position);
        }
        return onDescriptor(fd, 'write', (id) => vfs.write(id, at, data));
    }
    function fstatSync(fd) {
        return toNodeStat(onDescriptor(fd, 'fstat', (id) => vfs.fstat(id)));
    }
    function ftruncateSync(fd, len) {
        onDescriptor(fd, 'ftruncate', (id) => vfs.ftruncate(id, len ?? 0));
    }
    function fsyncSync(fd) {
        onDescriptor(fd, 'fsync', (id) => vfs.fsync(id));
    }
    function fdatasyncSync(fd) {
        onDescriptor(fd, 'fdatasync', (id) => vfs.fsync(id));
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
                // The filesystem's errors and this module's are Node's already.
                if (isVfsError(e) || e.code) {
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
    // The whole file is read, then pushed to the stream.
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
        chmod: async (path, mode) => chmodSync(path, mode),
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
                if (options?.force && isVfsError(e) && e.code === 'ENOENT')
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
        O_EXCL,
        O_TRUNC,
        O_APPEND,
        O_DIRECTORY,
        O_NOFOLLOW,
        O_SYNC,
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
