/**
 * Node's `fs`, written once over the file faces (Kinu ask 67): each
 * operation is a generator (node-compat/drive.ts) whose body holds its
 * argument checks, paths, encodings and the shaping of Stats, Dirents and
 * errors, and yields each file call as a step. Its `*Sync` form answers
 * from the synchronous face; its callbacks and `fs.promises` from the
 * asynchronous one, or the synchronous one where there is no other. lifo's
 * Node runs it over its synchronous filesystem; a session client's
 * (createNodeCompat) over the session's asynchronous calls.
 */
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { fileURLToPath } from 'node:url';
import { operandPath, basename } from '../substrate/lifo/utils/path.js';
import { encode } from '../substrate/lifo/utils/encoding.js';
import { errnoCodeOf, fsError, isVfsError } from '../vfs/vfs-error.js';
import { DIRENT_TYPES, direntTypeOfStat } from '../vfs/dirent-type.js';
import { S_IFMT } from '../vfs/vfs.js';
import { nameDec } from '../_shared/bytes.js';
import { invalidArgType, invalidArgValue, nodeError, nodeSystemError } from '../_shared/node-error.js';
import { O_ACCMODE, O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_SYNC, O_TRUNC, O_WRONLY, nodeOwnerId, parseFileMode, stringToFlags, validateInt32, } from '../_shared/node-arguments.js';
import { lacks, runAsync, runSync, step } from './drive.js';
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
        // 512-byte blocks, allocated 4096 at a time, as a Linux filesystem reports them.
        blocks: Math.ceil(stat.size / 4096) * 8,
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
/** A failure a callback is given: the filesystem's, or one this module made, either with its code. */
function codedError(error) {
    return isVfsError(error) || (error instanceof Error && Reflect.get(error, 'code') !== undefined);
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
    return operandPath(cwd, pathText(p));
}
/** `p` as the face takes it, and as it was given: a failure names it as given, as Node's does. */
function namedPath(cwd, p) {
    const given = pathText(p);
    return { abs: operandPath(cwd, given), given };
}
/** A truncate length as Node takes one (validateInteger, a safe integer), a negative one 0; none is 0. */
function lengthOf(len) {
    return len === undefined ? 0 : Math.max(0, validateInt32(len, 'len', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
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
export function createNodeFs(faces, { cwd, stdin, reachStreams }) {
    let stdinRead = false;
    const readStdin = () => {
        if (stdinRead)
            return new Uint8Array(0);
        stdinRead = true;
        return stdin ? stdin() : new Uint8Array(0);
    };
    // ─── Drivers ───
    /** `op`, the `name` form's, answered at once. */
    const sync = (name, op) => runSync(faces, name, op);
    /**
     * `op` for a callback, never called back in its caller's turn. Where the
     * synchronous face answers, it is answered in the next microtask, as it
     * always has been. A failure with a code is the callback's; any other is
     * thrown, as a callback's own throw is.
     */
    function callback(op, cb) {
        queueMicrotask(() => {
            if (faces.async === undefined) {
                try {
                    const result = runSync(faces, 'callback', op());
                    cb(null, result);
                }
                catch (e) {
                    if (codedError(e))
                        cb(e);
                    else
                        throw e;
                }
                return;
            }
            new Promise((resolve) => { resolve(runAsync(faces, op())); }).then((result) => ({ result }), (error) => ({ error })).then((outcome) => {
                if (!('error' in outcome)) {
                    cb(null, outcome.result);
                    return;
                }
                if (!codedError(outcome.error))
                    throw outcome.error;
                cb(outcome.error);
            }).catch((error) => queueMicrotask(() => { throw error; }));
        });
    }
    /** `op` for `fs.promises`. */
    const promised = (op) => runAsync(faces, op);
    // ─── File descriptors ───
    // A descriptor is the process's own (NodeFilesystem.open): its file,
    // offset, rights and O_APPEND are the process's descriptor table's, shared
    // with fs/promises and anything else the process opens. Node's 0, 1 and 2
    // are its standard streams, so a descriptor numbers the process's 1 as 3.
    const STDIO = 3;
    /** `fd`'s call `syscall` on the process's descriptor: EBADF as Node says it, for no descriptor or one without the right. */
    function* onDescriptor(fd, syscall, run) {
        if (!Number.isSafeInteger(fd) || fd < STDIO)
            throw fsError('EBADF', syscall);
        try {
            return yield* run(fd - STDIO + 1);
        }
        catch (error) {
            if (errnoCodeOf(error) === 'EBADF')
                throw fsError('EBADF', syscall);
            throw error;
        }
    }
    // ─── Operations ───
    function* readDescriptor(fd, position, length) {
        return yield* onDescriptor(fd, 'read', (id) => step('read', undefined, (f) => {
            if (f.read === undefined)
                throw lacks('read');
            return f.read(id, position, length);
        }));
    }
    function* readFileOp(path, options) {
        const encoding = typeof options === 'string' ? options : options?.encoding;
        if (path === 0 || (typeof path === 'string' && Object.hasOwn(STDIN_PATHS, path))) {
            const bytes = readStdin();
            return encoding ? new TextDecoder().decode(bytes) : Buffer.from(bytes);
        }
        if (typeof path === 'number') {
            // From the descriptor's offset to the end, as Node reads a descriptor.
            const parts = [];
            for (let part = yield* readDescriptor(path, null, 65536); part.byteLength > 0; part = yield* readDescriptor(path, null, 65536))
                parts.push(part);
            const bytes = Buffer.concat(parts);
            return encoding ? new TextDecoder().decode(bytes) : bytes;
        }
        const at = namedPath(cwd, path);
        const abs = at.abs;
        try {
            if (encoding) {
                return yield* step('open', at, (f) => f.readFileString(abs));
            }
            // Return Buffer (not raw Uint8Array) so .toString() yields UTF-8 text.
            // Many packages do JSON.parse(fs.readFileSync('package.json')) without
            // encoding, expecting Buffer.toString() to return the file contents.
            const raw = yield* step('open', at, (f) => f.readFile(abs));
            return Buffer.from(raw);
        }
        catch (e) {
            // Node opens a directory, then fails to read it: the error is read's,
            // on the descriptor, with no path.
            if (errnoCodeOf(e) === 'EISDIR')
                throw fsError('EISDIR', 'read');
            throw e;
        }
    }
    function* writeFileOp(path, data) {
        const at = namedPath(cwd, path);
        yield* step('open', at, (f) => f.writeFile(at.abs, data));
    }
    function* appendFileOp(path, data) {
        const at = namedPath(cwd, path);
        yield* step('open', at, (f) => {
            if (f.appendFile === undefined)
                throw lacks('open', at.given);
            return f.appendFile(at.abs, data);
        });
    }
    function* existsOp(path) {
        const at = namedPath(cwd, path);
        return yield* step('access', at, (f) => f.exists(at.abs));
    }
    function* statOp(path) {
        const at = namedPath(cwd, path);
        return toNodeStat(yield* step('stat', at, (f) => f.stat(at.abs)));
    }
    function* lstatOp(path) {
        const at = namedPath(cwd, path);
        return toNodeStat(yield* step('lstat', at, (f) => f.lstat(at.abs)));
    }
    function* mkdirOp(path, options) {
        const at = namedPath(cwd, path);
        // Node's: a mode in options is checked as given (null is refused), none is 0o777.
        const opts = typeof options === 'object' && options !== null ? options : null;
        const mode = opts === null ? parseFileMode(options, 'mode', 0o777) : opts.mode === undefined ? 0o777 : parseFileMode(opts.mode, 'options.mode');
        yield* step('mkdir', at, (f) => {
            if (f.mkdir === undefined)
                throw lacks('mkdir', at.given);
            return f.mkdir(at.abs, { recursive: opts?.recursive, mode });
        });
    }
    function* readdirOp(path, options) {
        const at = namedPath(cwd, path);
        const abs = at.abs;
        const entries = yield* step('scandir', at, (f) => f.readdir(abs));
        if (!options?.withFileTypes)
            return entries.map((e) => e.name);
        // d_type, or where the backend cannot say, lstat's.
        const dirents = [];
        for (const e of entries) {
            const entry = resolvePath(abs, e.name);
            const holds = DIRENT_TYPES[e.type === 'unknown' ? direntTypeOfStat(yield* step('lstat', { abs: entry, given: entry }, (f) => f.lstat(entry))) : e.type].node;
            dirents.push({
                name: e.name,
                path: abs,
                isFile: () => holds === 'isFile',
                isDirectory: () => holds === 'isDirectory',
                isSymbolicLink: () => holds === 'isSymbolicLink',
                isBlockDevice: () => holds === 'isBlockDevice',
                isCharacterDevice: () => holds === 'isCharacterDevice',
                isFIFO: () => holds === 'isFIFO',
                isSocket: () => holds === 'isSocket',
            });
        }
        return dirents;
    }
    function* unlinkOp(path) {
        const at = namedPath(cwd, path);
        yield* step('unlink', at, (f) => {
            if (f.unlink === undefined)
                throw lacks('unlink', at.given);
            return f.unlink(at.abs);
        });
    }
    function* rmdirRecursiveStep(path) {
        const at = namedPath(cwd, path);
        yield* step('rmdir', at, (f) => {
            if (f.rmdirRecursive === undefined)
                throw lacks('rmdir', at.given);
            return f.rmdirRecursive(at.abs);
        });
    }
    /**
     * fs.rm, as Node's: the name itself (lstat), never what a link names;
     * a directory only with `recursive` (ERR_FS_EISDIR); with `force`, a name
     * that is not there is no error.
     */
    function* rmOp(path, options) {
        // With force, a name gone by the look or by the removal is no error, as in Node's rimraf.
        const gone = (e) => options?.force === true && isVfsError(e) && e.code === 'ENOENT';
        let stat;
        try {
            stat = yield* lstatOp(path);
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
                yield* rmdirRecursiveStep(path);
            else
                yield* unlinkOp(path);
        }
        catch (e) {
            if (!gone(e))
                throw e;
        }
    }
    function* rmdirOp(path, options) {
        if (options?.recursive) {
            yield* rmdirRecursiveStep(path);
            return;
        }
        const at = namedPath(cwd, path);
        yield* step('rmdir', at, (f) => {
            if (f.rmdir === undefined)
                throw lacks('rmdir', at.given);
            return f.rmdir(at.abs);
        });
    }
    function* renameOp(oldPath, newPath) {
        const from = namedPath(cwd, oldPath);
        const to = namedPath(cwd, newPath);
        yield* step('rename', from, (f) => {
            if (f.rename === undefined)
                throw lacks('rename', from.given);
            return f.rename(from.abs, to.abs);
        }, to);
    }
    function* copyFileOp(src, dest) {
        const from = namedPath(cwd, src);
        const to = namedPath(cwd, dest);
        yield* step('copyfile', from, (f) => {
            if (f.copyFile === undefined)
                throw lacks('copyfile', from.given);
            return f.copyFile(from.abs, to.abs);
        }, to);
    }
    function* chmodOp(path, mode) {
        const at = namedPath(cwd, path);
        const bits = parseFileMode(mode, 'mode');
        yield* step('chmod', at, (f) => {
            if (f.chmod === undefined)
                throw lacks('chmod', at.given);
            return f.chmod(at.abs, bits);
        });
    }
    // chown(2) and lchown(2): a side Node's -1 names keeps the file's, in the same change.
    function* chownAt(at, owner, group, follow) {
        const syscall = follow ? 'chown' : 'lchown';
        yield* step(syscall, at, (f) => {
            if (f.chown === undefined)
                throw lacks(syscall, at.given);
            return f.chown(at.abs, owner, group, follow);
        });
    }
    /** chown as its `*Sync` form and its promise take it: the path, then the ids, checked as they are used. */
    function* chownOp(path, uid, gid, follow) {
        const at = namedPath(cwd, path);
        yield* chownAt(at, nodeOwnerId(uid, 'uid'), nodeOwnerId(gid, 'gid'), follow);
    }
    function* accessOp(path) {
        const at = namedPath(cwd, path);
        if (!(yield* step('access', at, (f) => f.exists(at.abs)))) {
            throw fsError('ENOENT', 'access', at.given);
        }
    }
    /** realpath(3); a missing path is `missing`'s ENOENT (Node's realpathSync lstats the path's components: a missing one is lstat's). */
    function* realpathOp(path, missing) {
        const at = namedPath(cwd, path);
        if (!(yield* step(missing, at, (f) => f.exists(at.abs)))) {
            throw fsError('ENOENT', missing, at.given);
        }
        return yield* step('realpath', at, (f) => {
            if (f.realpath === undefined)
                throw lacks('realpath', at.given);
            return f.realpath(at.abs);
        });
    }
    function* openOp(path, flags, mode) {
        const at = namedPath(cwd, path);
        const how = openFlagsOf(flags, mode);
        return (yield* step('open', at, (f) => {
            if (f.open === undefined)
                throw lacks('open', at.given);
            return f.open(at.abs, how);
        })) - 1 + STDIO;
    }
    function* closeOp(fd) {
        yield* onDescriptor(fd, 'close', (id) => step('close', undefined, (f) => {
            if (f.close === undefined)
                throw lacks('close');
            return f.close(id);
        }));
    }
    function* readOp(fd, buffer, offset = 0, length = buffer.byteLength - offset, position) {
        const bytes = yield* readDescriptor(fd, positionOf(position), length);
        buffer.set(bytes, offset);
        return bytes.byteLength;
    }
    function* writeOp(fd, bufferOrString, offsetOrPosition, lengthOrEncoding, position) {
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
        return yield* onDescriptor(fd, 'write', (id) => step('write', undefined, (f) => {
            if (f.write === undefined)
                throw lacks('write');
            return f.write(id, at, data);
        }));
    }
    function* fstatOp(fd) {
        return toNodeStat(yield* onDescriptor(fd, 'fstat', (id) => step('fstat', undefined, (f) => {
            if (f.fstat === undefined)
                throw lacks('fstat');
            return f.fstat(id);
        })));
    }
    /** Its length is checked before its descriptor (an int32 from 0), as Node's are. */
    function* ftruncateOp(fd, len) {
        const length = lengthOf(len);
        validateInt32(fd, 'fd', 0);
        yield* onDescriptor(fd, 'ftruncate', (id) => step('ftruncate', undefined, (f) => {
            if (f.ftruncate === undefined)
                throw lacks('ftruncate');
            return f.ftruncate(id, length);
        }));
    }
    function* fchownOp(fd, uid, gid) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        yield* onDescriptor(fd, 'fchown', (id) => step('fchown', undefined, (f) => {
            if (f.fchown === undefined)
                throw lacks('fchown');
            return f.fchown(id, owner, group);
        }));
    }
    function* fsyncOp(fd, syscall) {
        yield* onDescriptor(fd, syscall, (id) => step(syscall, undefined, (f) => {
            if (f.fsync === undefined)
                throw lacks(syscall);
            return f.fsync(id);
        }));
    }
    /**
     * truncate(2) as Node makes it: the file opened for writing (its errors
     * name open), cut or zero-extended to `len` (a negative one is 0), closed.
     * The length is checked once the file is open, as Node's ftruncate checks it.
     * A face with a path's truncate is asked for it. A descriptor in place of
     * the path is ftruncate's (Node's DEP0081).
     */
    function* truncateOp(path, len) {
        if (typeof path === 'number') {
            yield* ftruncateOp(path, len);
            return;
        }
        const at = namedPath(cwd, path);
        const abs = at.abs;
        const pathTruncates = yield* step('open', at, (f) => f.truncate !== undefined);
        if (pathTruncates) {
            const length = lengthOf(len);
            yield* step('open', at, (f) => {
                if (f.truncate === undefined)
                    throw lacks('open', at.given);
                return f.truncate(abs, length);
            });
            return;
        }
        const fd = yield* step('open', at, (f) => {
            if (f.open === undefined)
                throw lacks('open', at.given);
            return f.open(abs, openFlagsOf('r+', undefined));
        });
        try {
            const length = lengthOf(len);
            yield* step('ftruncate', undefined, (f) => {
                if (f.ftruncate === undefined)
                    throw lacks('ftruncate');
                return f.ftruncate(fd, length);
            });
        }
        finally {
            yield* step('close', undefined, (f) => {
                if (f.close === undefined)
                    throw lacks('close');
                return f.close(fd);
            });
        }
    }
    /** symlink(2): the link at `path` holds `target` as given (a relative target stays relative, read from the link's directory). */
    function* symlinkOp(target, path) {
        const text = pathText(target);
        const at = namedPath(cwd, path);
        yield* step('symlink', at, (f) => {
            if (f.symlink === undefined)
                throw lacks('symlink', at.given);
            return f.symlink(text, at.abs);
        });
    }
    /** readlink(2): the link's text in `encoding` (UTF-8 by default), or its bytes with `encoding: 'buffer'`. */
    function* readlinkOp(path, options) {
        // No encoding, or an empty one, is UTF-8, as Node takes it.
        const encoding = (typeof options === 'string' ? options : options?.encoding) || 'utf8';
        if (encoding !== 'buffer' && !Buffer.isEncoding(encoding))
            throw invalidArgValue('encoding', encoding, 'is invalid encoding');
        const at = namedPath(cwd, path);
        const text = yield* step('readlink', at, (f) => {
            if (f.readlink === undefined)
                throw lacks('readlink', at.given);
            return f.readlink(at.abs);
        });
        if (encoding === 'buffer')
            return Buffer.from(text);
        return encoding === 'utf8' ? text : Buffer.from(text).toString(encoding);
    }
    // ─── Sync API ───
    const readFileSync = (path, options) => sync('readFileSync', readFileOp(path, options));
    const writeFileSync = (path, data, _options) => sync('writeFileSync', writeFileOp(path, data));
    const appendFileSync = (path, data) => sync('appendFileSync', appendFileOp(path, data));
    const existsSync = (path) => sync('existsSync', existsOp(path));
    const statSync = (path) => sync('statSync', statOp(path));
    const lstatSync = (path) => sync('lstatSync', lstatOp(path));
    const mkdirSync = (path, options) => sync('mkdirSync', mkdirOp(path, options));
    const readdirSync = (path, options) => sync('readdirSync', readdirOp(path, options));
    const unlinkSync = (path) => sync('unlinkSync', unlinkOp(path));
    const rmSync = (path, options) => sync('rmSync', rmOp(path, options));
    const rmdirSync = (path, options) => sync('rmdirSync', rmdirOp(path, options));
    const renameSync = (oldPath, newPath) => sync('renameSync', renameOp(oldPath, newPath));
    const copyFileSync = (src, dest) => sync('copyFileSync', copyFileOp(src, dest));
    const chmodSync = (path, mode) => sync('chmodSync', chmodOp(path, mode));
    const chownSync = (path, uid, gid) => sync('chownSync', chownOp(path, uid, gid, true));
    const lchownSync = (path, uid, gid) => sync('lchownSync', chownOp(path, uid, gid, false));
    const accessSync = (path, _mode) => sync('accessSync', accessOp(path));
    const realpathSync = Object.assign(function realpathSync(path) { return sync('realpathSync', realpathOp(path, 'lstat')); }, { native: function realpathSyncNative(path) { return sync('realpathSync', realpathOp(path, 'realpath')); } });
    const truncateSync = (path, len) => sync('truncateSync', truncateOp(path, len));
    const openSync = (path, flags, mode) => sync('openSync', openOp(path, flags, mode));
    const closeSync = (fd) => sync('closeSync', closeOp(fd));
    const readSync = (fd, buffer, offset, length, position) => sync('readSync', readOp(fd, buffer, offset, length, position));
    const writeSync = (fd, bufferOrString, offsetOrPosition, lengthOrEncoding, position) => sync('writeSync', writeOp(fd, bufferOrString, offsetOrPosition, lengthOrEncoding, position));
    const fstatSync = (fd) => sync('fstatSync', fstatOp(fd));
    const ftruncateSync = (fd, len) => sync('ftruncateSync', ftruncateOp(fd, len));
    const fchownSync = (fd, uid, gid) => sync('fchownSync', fchownOp(fd, uid, gid));
    const fsyncSync = (fd) => sync('fsyncSync', fsyncOp(fd, 'fsync'));
    const fdatasyncSync = (fd) => sync('fdatasyncSync', fsyncOp(fd, 'fdatasync'));
    const symlinkSync = (target, path, _type) => sync('symlinkSync', symlinkOp(target, path));
    const readlinkSync = (path, options) => sync('readlinkSync', readlinkOp(path, options));
    /**
     * link(2), refused (ENOSYS) as the hosted node refuses it: the filesystem
     * has no hard links, and a copy would claim an inode the names do not share.
     */
    function linkSync(existingPath, newPath) {
        throw fsError('ENOSYS', 'link', pathText(existingPath), pathText(newPath));
    }
    // ─── Callback API ───
    // Their ids are checked at once, as Node's are: a bad one throws, never calls back.
    function chown(path, uid, gid, cb) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        callback(() => chownAt(namedPath(cwd, path), owner, group, true), cb);
    }
    function lchown(path, uid, gid, cb) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        callback(() => chownAt(namedPath(cwd, path), owner, group, false), cb);
    }
    function fchown(fd, uid, gid, cb) {
        const owner = nodeOwnerId(uid, 'uid');
        const group = nodeOwnerId(gid, 'gid');
        callback(() => onDescriptor(fd, 'fchown', (id) => step('fchown', undefined, (f) => {
            if (f.fchown === undefined)
                throw lacks('fchown');
            return f.fchown(id, owner, group);
        })), cb);
    }
    function readFile(path, optionsOrCb, cb) {
        const callbackFn = callbackOf(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        callback(() => readFileOp(path, options), callbackFn);
    }
    function writeFile(path, data, optionsOrCb, cb) {
        callback(() => writeFileOp(path, data), callbackOf(typeof optionsOrCb === 'function' ? optionsOrCb : cb));
    }
    function stat(path, cb) {
        callback(() => statOp(path), cb);
    }
    function lstat(path, cb) {
        callback(() => lstatOp(path), cb);
    }
    function mkdir(path, optionsOrCb, cb) {
        const callbackFn = callbackOf(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        callback(() => mkdirOp(path, options), callbackFn);
    }
    function readdir(path, optionsOrCb, cb) {
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        callback(() => readdirOp(path, options), callbackOf(typeof optionsOrCb === 'function' ? optionsOrCb : cb));
    }
    function rm(path, optionsOrCb, cb) {
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        const done = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        if (done)
            callback(() => rmOp(path, options), done);
    }
    function unlink(path, cb) {
        callback(() => unlinkOp(path), cb);
    }
    function rename(oldPath, newPath, cb) {
        callback(() => renameOp(oldPath, newPath), cb);
    }
    function access(path, modeOrCb, cb) {
        callback(() => accessOp(path), callbackOf(typeof modeOrCb === 'function' ? modeOrCb : cb));
    }
    /** Its callback is its last argument, as Node's symlink takes it. */
    function symlink(target, path, ...rest) {
        const callbackFn = callbackOf(rest.length === 0 ? path : rest[rest.length - 1]);
        callback(() => symlinkOp(target, path), callbackFn);
    }
    function readlink(path, optionsOrCb, cb) {
        const callbackFn = callbackOf(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        callback(() => readlinkOp(path, options), callbackFn);
    }
    function link(existingPath, newPath, cb) {
        const callbackFn = callbackOf(cb);
        const from = pathText(existingPath);
        const to = pathText(newPath);
        callback(function* () { linkSync(from, to); }, callbackFn);
    }
    /** Its length and callback are checked before anything is done, as Node's are. */
    function truncate(path, lenOrCb, cb) {
        if (typeof path === 'number') {
            ftruncate(path, lenOrCb, cb);
            return;
        }
        const length = lengthOf(typeof lenOrCb === 'function' ? undefined : lenOrCb);
        const callbackFn = callbackOf(typeof lenOrCb === 'function' ? lenOrCb : cb);
        callback(() => truncateOp(path, length), callbackFn);
    }
    /** Its length, callback and descriptor are checked before anything is done, in that order, as Node's are. */
    function ftruncate(fd, lenOrCb, cb) {
        const length = lengthOf(typeof lenOrCb === 'function' ? undefined : lenOrCb);
        const callbackFn = callbackOf(typeof lenOrCb === 'function' ? lenOrCb : cb);
        validateInt32(fd, 'fd', 0);
        callback(() => ftruncateOp(fd, length), callbackFn);
    }
    function exists(path, cb) {
        callback(() => existsOp(path), (err, result) => cb(err === null && result === true));
    }
    function open(path, flagsOrCb, modeOrCb, cb) {
        let callbackFn;
        let flags;
        let mode;
        if (typeof flagsOrCb === 'function') {
            callbackFn = flagsOrCb;
            flags = 'r';
        }
        else if (typeof modeOrCb === 'function') {
            callbackFn = modeOrCb;
            flags = flagsOrCb;
        }
        else {
            callbackFn = callbackOf(cb);
            flags = flagsOrCb;
            mode = modeOrCb;
        }
        callback(() => openOp(path, flags, mode), callbackFn);
    }
    function close(fd, cb) {
        callback(() => closeOp(fd), cb);
    }
    /** Node's fs.read: its callback is given the bytes read and the buffer. */
    function read(fd, buffer, offset, length, position, cb) {
        callback(() => readOp(fd, buffer, offset, length, position), (err, bytesRead) => cb(err, bytesRead, buffer));
    }
    /**
     * Node's fs.write, (fd, buffer, offset?, length?, position?, callback) or
     * (fd, string, position?, encoding?, callback): its callback is given the
     * bytes written and what was written.
     */
    function write(fd, data, ...rest) {
        const callbackFn = rest.pop();
        if (typeof callbackFn !== 'function')
            throw invalidArgType('cb', 'function', callbackFn);
        const [first, second, third] = rest.map((arg) => (typeof arg === 'function' ? undefined : arg));
        const at = (arg) => (typeof arg === 'string' ? undefined : arg);
        callback(() => (typeof data === 'string'
            ? writeOp(fd, data, at(first), typeof second === 'string' ? second : undefined)
            : writeOp(fd, data, at(first), typeof second === 'number' ? second : undefined, at(third))), (err, written) => callbackFn(err, written, data));
    }
    function fsync(fd, cb) {
        callback(() => fsyncOp(fd, 'fsync'), cb);
    }
    function fstat(fd, cb) {
        callback(() => fstatOp(fd), cb);
    }
    const realpath = Object.assign(function realpath(path, optOrCb, cb) {
        callback(() => realpathOp(path, 'lstat'), callbackOf(typeof optOrCb === 'function' ? optOrCb : cb));
    }, {
        native: function realpathNative(path, optOrCb, cb) {
            callback(() => realpathOp(path, 'lstat'), callbackOf(typeof optOrCb === 'function' ? optOrCb : cb));
        },
    });
    // ─── Stream API ───
    // The engine's own read and write streams, over this filesystem: Node's
    // ReadStream and WriteStream read and write through the `fs` they are given.
    // A face without descriptors has none to give them (ENOSYS).
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
    const streamsOpen = (path) => {
        if ((faces.sync ?? faces.async).open === undefined)
            throw lacks('open', streamPath(path));
    };
    class ReadStream extends engineFs.ReadStream {
        constructor(path, options) {
            streamsOpen(path);
            reachStreams?.();
            super(streamPath(path), streamOptions(options));
        }
    }
    class WriteStream extends engineFs.WriteStream {
        constructor(path, options) {
            streamsOpen(path);
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
     * any depth when recursive), or as the watched file itself. It is made at
     * once, so it needs the synchronous face.
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
        const face = faces.sync;
        // A watch is made at once: a face that cannot answer now, or has none, has no watch to give.
        if (face === undefined || face.watch === undefined)
            throw lacks('watch', given);
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
        const directory = face.isDirectory(abs);
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
        handle = face.watch(abs, changed, { persistent });
        return watcher;
    }
    // ─── Promises API ───
    const promises = {
        readFile: (path, options) => promised(readFileOp(path, options)),
        writeFile: (path, data) => promised(writeFileOp(path, data)),
        appendFile: (path, data) => promised(appendFileOp(path, data)),
        stat: (path) => promised(statOp(path)),
        lstat: (path) => promised(lstatOp(path)),
        mkdir: (path, options) => promised(mkdirOp(path, options)),
        readdir: (path, options) => promised(readdirOp(path, options)),
        unlink: (path) => promised(unlinkOp(path)),
        rmdir: (path, options) => promised(rmdirOp(path, options)),
        rename: (oldPath, newPath) => promised(renameOp(oldPath, newPath)),
        copyFile: (src, dest) => promised(copyFileOp(src, dest)),
        access: (path, _mode) => promised(accessOp(path)),
        realpath: (path) => promised(realpathOp(path, 'lstat')),
        // A path only: a descriptor is its FileHandle's truncate.
        truncate: (path, len) => promised((function* () {
            if (typeof path === 'number')
                throw invalidArgType('path', ['string', 'Buffer', 'URL'], path);
            yield* truncateOp(path, len);
        })()),
        symlink: (target, path, _type) => promised(symlinkOp(target, path)),
        link: (existingPath, newPath) => promised((function* () { linkSync(existingPath, newPath); })()),
        readlink: (path, options) => promised(readlinkOp(path, options)),
        chmod: (path, mode) => promised(chmodOp(path, mode)),
        chown: (path, uid, gid) => promised(chownOp(path, uid, gid, true)),
        lchown: (path, uid, gid) => promised(chownOp(path, uid, gid, false)),
        open: (path, flags, mode) => promised((function* () {
            const fd = yield* openOp(path, flags, mode);
            let closed = false;
            // A closed handle refuses each call before its arguments, as Node's FileHandle does
            // (its descriptor number may be another file's by then); closing it again is nothing.
            const isOpen = (syscall) => {
                if (closed)
                    throw Object.assign(new Error('file closed'), { code: 'EBADF', syscall });
            };
            return {
                fd,
                close: () => promised((function* () {
                    if (closed)
                        return;
                    closed = true;
                    yield* closeOp(fd);
                })()),
                read: (buffer, offset, length, position) => promised((function* () {
                    isOpen('read');
                    return { bytesRead: yield* readOp(fd, buffer, offset, length, position), buffer };
                })()),
                write: (data) => promised((function* () {
                    isOpen('write');
                    return { bytesWritten: yield* writeOp(fd, data) };
                })()),
                stat: () => promised((function* () {
                    isOpen('fstat');
                    return yield* fstatOp(fd);
                })()),
                chown: (uid, gid) => promised((function* () {
                    isOpen('fchown');
                    yield* fchownOp(fd, uid, gid);
                })()),
                truncate: (len) => promised((function* () {
                    isOpen('ftruncate');
                    yield* ftruncateOp(fd, len);
                })()),
            };
        })()),
        rm: (path, options) => promised(rmOp(path, options)),
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
        link,
        readlink,
        truncate,
        ftruncate,
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
