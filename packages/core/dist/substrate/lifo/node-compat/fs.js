import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { resolve, basename } from '../utils/path.js';
import { encode } from '../utils/encoding.js';
import { errnoCodeOf, fsError, isVfsError } from '../../../vfs/vfs-error.js';
import { DIRENT_TYPES, direntTypeOfStat } from '../../../vfs/dirent-type.js';
import { S_IFMT } from '../../../vfs/vfs.js';
import { nameDec } from '../../../_shared/bytes.js';
import { invalidArgType, invalidArgValue, nodeError, nodeSystemError } from '../../../_shared/node-error.js';
import { fileURLToPath } from 'node:url';
import { O_ACCMODE, O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_SYNC, O_TRUNC, O_WRONLY, nodeOwnerId, parseFileMode, stringToFlags, } from '../../../_shared/node-arguments.js';
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
/** A path argument as Node takes one: a string, a Buffer's text, or a file: URL's path (decoded; another scheme is ERR_INVALID_URL_SCHEME). */
function pathText(p) {
    if (typeof p === 'string')
        return p;
    // By shape, not by class: a program's URL or Buffer may be another realm's.
    if (ArrayBuffer.isView(p))
        return nameDec.decode(p);
    if (p.protocol !== 'file:')
        throw nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
    return fileURLToPath(p.href);
}
function resolvePath(cwd, p) {
    return resolve(cwd, pathText(p));
}
/** Node's callback check (makeCallback): a callback that is not a function is ERR_INVALID_ARG_TYPE, thrown before any work. */
function callbackOf(cb) {
    if (typeof cb !== 'function')
        throw invalidArgType('cb', 'function', cb);
    return cb;
}
// ─── Open flags ───
/** An open's flags, as Node takes them (a string or bits), for the process's open: the decisions are its. */
function openFlagsOf(flags, mode) {
    const bits = stringToFlags(flags);
    // Node's open: none (undefined or null) is 0o666.
    const parsedMode = parseFileMode(mode, 'mode', 0o666);
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
        mode: parsedMode,
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
export function createFs(vfs, cwd, stdin, reachStreams) {
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
            if (errnoCodeOf(error) === 'EBADF')
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
        // Node's: a mode in options is checked as given (null is refused), none is 0o777.
        const opts = typeof options === 'object' && options !== null ? options : null;
        const mode = opts === null ? parseFileMode(options, 'mode', 0o777) : opts.mode === undefined ? 0o777 : parseFileMode(opts.mode, 'options.mode');
        vfs.mkdir(abs, { recursive: opts?.recursive, mode });
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
    /**
     * fs.rmSync, as Node's: the name itself (lstat), never what a link names;
     * a directory only with `recursive` (ERR_FS_EISDIR); with `force`, a name
     * that is not there is no error.
     */
    function rmSync(path, options) {
        const abs = resolvePath(cwd, path);
        // With force, a name gone by the look or by the removal is no error, as in Node's rimraf.
        const gone = (e) => options?.force === true && isVfsError(e) && e.code === 'ENOENT';
        let stat;
        try {
            stat = lstatSync(abs);
        }
        catch (e) {
            if (gone(e))
                return;
            throw e;
        }
        if (stat.isDirectory() && !options?.recursive) {
            throw nodeSystemError('ERR_FS_EISDIR', 'Path is a directory', { code: 'EISDIR', message: 'is a directory', path: String(path), syscall: 'rm', errno: 21 });
        }
        try {
            if (stat.isDirectory())
                vfs.rmdirRecursive(abs);
            else
                vfs.unlink(abs);
        }
        catch (e) {
            if (!gone(e))
                throw e;
        }
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
        vfs.chmod(resolvePath(cwd, path), parseFileMode(mode, 'mode'));
    }
    // chown(2) and lchown(2): a side Node's -1 names keeps the file's, in the same change.
    function chownSync(path, uid, gid) {
        const abs = resolvePath(cwd, path);
        vfs.chown(abs, nodeOwnerId(uid, 'uid'), nodeOwnerId(gid, 'gid'), true);
    }
    function lchownSync(path, uid, gid) {
        const abs = resolvePath(cwd, path);
        vfs.chown(abs, nodeOwnerId(uid, 'uid'), nodeOwnerId(gid, 'gid'), false);
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
        return vfs.realpath(abs);
    }, {
        native: function realpathSyncNative(path) {
            const abs = resolvePath(cwd, path);
            if (!vfs.exists(abs)) {
                throw fsError('ENOENT', 'realpath', abs);
            }
            return vfs.realpath(abs);
        },
    });
    /**
     * truncate(2) as Node makes it: the file opened for writing (its errors
     * name open), cut or zero-extended to `len` (a negative one is 0), closed.
     * A descriptor in place of the path is ftruncate's (Node's DEP0081).
     */
    function truncateSync(path, len) {
        if (typeof path === 'number') {
            ftruncateSync(path, len);
            return;
        }
        const fd = vfs.open(resolvePath(cwd, path), openFlagsOf('r+', undefined));
        try {
            vfs.ftruncate(fd, Math.max(0, len ?? 0));
        }
        finally {
            vfs.close(fd);
        }
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
        // A negative length is 0, as Node clamps it.
        onDescriptor(fd, 'ftruncate', (id) => vfs.ftruncate(id, Math.max(0, len ?? 0)));
    }
    function fchownSync(fd, uid, gid) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        onDescriptor(fd, 'fchown', (id) => vfs.fchown(id, owner, group));
    }
    function fsyncSync(fd) {
        onDescriptor(fd, 'fsync', (id) => vfs.fsync(id));
    }
    function fdatasyncSync(fd) {
        onDescriptor(fd, 'fdatasync', (id) => vfs.fsync(id));
    }
    // ─── Links ───
    /** symlink(2): the link at `path` holds `target` as given (a relative target stays relative, read from the link's directory). */
    function symlinkSync(target, path, _type) {
        vfs.symlink(pathText(target), resolvePath(cwd, path));
    }
    function linkSync(_existingPath, _newPath) {
        // No-op
    }
    /** readlink(2): the link's text in `encoding` (UTF-8 by default), or its bytes with `encoding: 'buffer'`. */
    function readlinkSync(path, options) {
        // No encoding, or an empty one, is UTF-8, as Node takes it.
        const encoding = (typeof options === 'string' ? options : options?.encoding) || 'utf8';
        if (encoding !== 'buffer' && !Buffer.isEncoding(encoding))
            throw invalidArgValue('encoding', encoding, 'is invalid encoding');
        const text = vfs.readlink(resolvePath(cwd, path));
        if (encoding === 'buffer')
            return Buffer.from(text);
        return encoding === 'utf8' ? text : Buffer.from(text).toString(encoding);
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
    // Their ids are checked at once, as Node's are: a bad one throws, never calls back.
    function chown(path, uid, gid, cb) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        wrapCallback(() => vfs.chown(resolvePath(cwd, path), owner, group, true), cb);
    }
    function lchown(path, uid, gid, cb) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        wrapCallback(() => vfs.chown(resolvePath(cwd, path), owner, group, false), cb);
    }
    function fchown(fd, uid, gid, cb) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        wrapCallback(() => onDescriptor(fd, 'fchown', (id) => vfs.fchown(id, owner, group)), cb);
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
    function rm(path, optionsOrCb, cb) {
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        const done = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        if (done)
            wrapCallback(() => rmSync(path, options), done);
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
    /** Its callback is its last argument, as Node's symlink takes it. */
    function symlink(target, path, ...rest) {
        const callback = callbackOf(rest.length === 0 ? path : rest[rest.length - 1]);
        wrapCallback(() => symlinkSync(target, path), callback);
    }
    function readlink(path, optionsOrCb, cb) {
        const callback = callbackOf(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        wrapCallback(() => readlinkSync(path, options), callback);
    }
    function truncate(path, lenOrCb, cb) {
        const callback = callbackOf(typeof lenOrCb === 'function' ? lenOrCb : cb);
        const len = typeof lenOrCb === 'function' ? undefined : lenOrCb ?? undefined;
        wrapCallback(() => truncateSync(path, len), callback);
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
    /** Node's fs.read: its callback is given the bytes read and the buffer. */
    function read(fd, buffer, offset, length, position, cb) {
        wrapCallback(() => readSync(fd, buffer, offset, length, position), (err, bytesRead) => cb(err, bytesRead, buffer));
    }
    /**
     * Node's fs.write, (fd, buffer, offset?, length?, position?, callback) or
     * (fd, string, position?, encoding?, callback): its callback is given the
     * bytes written and what was written.
     */
    function write(fd, data, ...rest) {
        const callback = rest.pop();
        if (typeof callback !== 'function')
            throw invalidArgType('cb', 'function', callback);
        const [first, second, third] = rest.map((arg) => (typeof arg === 'function' ? undefined : arg));
        const at = (arg) => (typeof arg === 'string' ? undefined : arg);
        wrapCallback(() => (typeof data === 'string'
            ? writeSync(fd, data, at(first), typeof second === 'string' ? second : undefined)
            : writeSync(fd, data, at(first), typeof second === 'number' ? second : undefined, at(third))), (err, written) => callback(err, written, data));
    }
    function fsync(fd, cb) {
        wrapCallback(() => fsyncSync(fd), cb);
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
    // The engine's own read and write streams, over this filesystem: Node's
    // ReadStream and WriteStream read and write through the `fs` they are given.
    const engineFs = realm.getBuiltinModule('node:fs');
    const streamFs = { open, read, write, close, fsync };
    const streamPath = (path) => (path === null || path === undefined ? undefined : resolvePath(cwd, path));
    // A stream given no fs of its own (none, undefined or null, which Node's
    // `options.fs || fs` reads as its default) goes through this filesystem,
    // its descriptors this filesystem's: never the engine's own.
    const streamOptions = (options) => {
        const given = typeof options === 'string' ? { encoding: options } : options ?? {};
        return { ...given, fs: given.fs || streamFs };
    };
    class ReadStream extends engineFs.ReadStream {
        constructor(path, options) {
            reachStreams?.();
            super(streamPath(path), streamOptions(options));
        }
    }
    class WriteStream extends engineFs.WriteStream {
        constructor(path, options) {
            reachStreams?.();
            super(streamPath(path), streamOptions(options));
        }
    }
    const createReadStream = (path, options) => new ReadStream(path, options);
    const createWriteStream = (path, options) => new WriteStream(path, options);
    // ─── Watch API ───
    /**
     * Node's fs.watch: 'rename' when an entry appears or goes, 'change' when
     * one changes, named from the watched directory (its direct entries,
     * any depth when recursive), or as the watched file itself.
     */
    function watch(filename, optionsOrListener, listener) {
        // A copy, as Node takes: what the caller does to its options after is not the watch's.
        const options = typeof optionsOrListener === 'string' ? { encoding: optionsOrListener }
            : typeof optionsOrListener === 'object' && optionsOrListener !== null ? { ...optionsOrListener } : {};
        // Node checks the encoding first, whatever the path.
        if (options.encoding && options.encoding !== 'buffer' && !Buffer.isEncoding(options.encoding)) {
            throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'encoding' is invalid encoding. Received '${options.encoding}'`);
        }
        const given = pathText(filename);
        let abs;
        try {
            if (given === '')
                throw fsError('ENOENT', 'watch', given);
            abs = realpathSync(filename);
        }
        catch (error) {
            if (errnoCodeOf(error) === 'ENOENT')
                throw fsError('ENOENT', 'watch', given);
            throw error;
        }
        const directory = vfs.isDirectory(abs);
        const base = basename(given);
        const cb = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
        let closed = false;
        let persistent = options.persistent !== false;
        let handle;
        const watcher = new class extends EventEmitter {
            close() {
                if (closed)
                    return;
                closed = true;
                handle.close();
                queueMicrotask(() => this.emit('close'));
            }
            ref() {
                if (!closed) {
                    persistent = true;
                    handle.ref();
                }
                return this;
            }
            unref() {
                if (!closed) {
                    persistent = false;
                    handle.unref();
                }
                return this;
            }
        }();
        if (cb)
            watcher.on('change', (eventType, name) => cb(String(eventType), name instanceof Buffer ? name : String(name)));
        const inside = (path) => path === abs || (directory && path.startsWith(abs === '/' ? '/' : `${abs}/`));
        const told = (path, eventType) => {
            if (closed || !inside(path))
                return;
            const name = path === abs ? base : path.slice(abs === '/' ? 1 : abs.length + 1);
            if (path !== abs && options.recursive !== true && name.includes('/'))
                return;
            const bytes = Buffer.from(name);
            watcher.emit('change', eventType, options.encoding === 'buffer' ? bytes : bytes.toString(options.encoding));
        };
        const changed = (event) => {
            if (closed)
                return;
            // The target itself moved (or a directory above it): the namespace's watch follows it, and so do its names.
            if (event.type === 'rename' && event.oldPath === abs) {
                told(abs, 'rename');
                abs = event.path;
                return;
            }
            if (event.type === 'change') {
                told(event.path, 'change');
                return;
            }
            if (event.oldPath !== undefined)
                told(event.oldPath, 'rename');
            told(event.path, 'rename');
        };
        handle = vfs.watch(abs, changed, { persistent });
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
        // A path only: a descriptor is its FileHandle's truncate.
        truncate: async (path, len) => {
            if (typeof path === 'number')
                throw invalidArgType('path', ['string', 'Buffer', 'URL'], path);
            truncateSync(path, len);
        },
        symlink: async (target, path, type) => symlinkSync(target, path, type),
        readlink: async (path, options) => readlinkSync(path, options),
        chmod: async (path, mode) => chmodSync(path, mode),
        chown: async (path, uid, gid) => chownSync(path, uid, gid),
        lchown: async (path, uid, gid) => lchownSync(path, uid, gid),
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
                chown: async (uid, gid) => fchownSync(fd, uid, gid),
                truncate: async (len) => ftruncateSync(fd, len),
            };
        },
        rm: async (path, options) => rmSync(path, options),
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
        rmSync,
        rmdirSync,
        renameSync,
        copyFileSync,
        chmodSync,
        chownSync,
        lchownSync,
        fchownSync,
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
        rm,
        rename,
        access,
        exists,
        symlink,
        readlink,
        truncate,
        open,
        close,
        read,
        write,
        fsync,
        fstat,
        chown,
        lchown,
        fchown,
        realpath,
        // Streams
        ReadStream,
        WriteStream,
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
