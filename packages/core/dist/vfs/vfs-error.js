/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */
import { dataDescriptor, Error, objectAssign, objectHasOwn, ownField, ownValue, reflectDefineProperty, reflectGet, regExpExec, SafeSet, stringOf } from '../_shared/primordials.js';
/** Linux errno numbers, negative as libuv reports them. */
export const VFS_ERRNO = {
    E2BIG: -7, EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17,
    EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOSPC: -28, EROFS: -30, ELOOP: -40,
    ENAMETOOLONG: -36, ENOTEMPTY: -39, ENOTSUP: -95, ESTALE: -116, EBADF: -9, EFBIG: -27,
};
/**
 * The engine's refusal, `${code}: ${what}`, with its reason (`detail`), which
 * a layer that reports the error for its own call keeps (the runtime bridge,
 * toVfsError). A `detail` given is the reason about the name `what` and is
 * appended to the message; without one, `what` is the whole reason. Name a
 * storage key only in `what`, never in the reason: the caller's layer names
 * the caller's own path.
 */
export function vfsError(code, what, detail = what) {
    return objectAssign(new Error(detail === what ? `${code}: ${what}` : `${code}: ${what}: ${detail}`), { code, detail });
}
/** An error's errno (an `E…` code), if it carries one. */
export function errnoCodeOf(error) {
    const code = typeof error === 'object' && error !== null ? ownField(error, 'code') : undefined;
    return typeof code === 'string' && regExpExec(/^E[A-Z0-9]+$/, code) !== null ? code : undefined;
}
export class VfsError extends Error {
    code;
    path;
    errno;
    /**
     * `message` is what Node's message says before the path: the description
     * and the syscall (`no such file or directory, open`). The path follows it
     * as Node prints one, and a second path after an arrow:
     * `ENOENT: no such file or directory, open 'x'`,
     * `EXDEV: cross-device link not permitted, rename 'a' -> 'b'`.
     */
    constructor(code, message, path, options) {
        super(systemErrorMessage(code, message, path, options === undefined ? undefined : ownValue(options, 'dest')), options);
        this.code = code;
        this.path = path;
        reflectDefineProperty(this, 'name', dataDescriptor('VfsError', true, true, true));
        this.errno = VFS_ERRNO[code];
        const syscall = options === undefined ? undefined : ownValue(options, 'syscall');
        const dest = options === undefined ? undefined : ownValue(options, 'dest');
        if (syscall !== undefined)
            reflectDefineProperty(this, 'syscall', dataDescriptor(syscall, true, true, true));
        if (dest !== undefined)
            reflectDefineProperty(this, 'dest', dataDescriptor(dest, true, true, true));
        const detail = (options === undefined ? undefined : ownValue(options, 'detail')) ?? (syscall === undefined && message !== VFS_DESCRIPTION[code] ? message : undefined);
        if (detail !== undefined)
            reflectDefineProperty(this, 'detail', dataDescriptor(detail, true, true, true));
    }
}
/**
 * Node's error for `syscall` failing on `path` with `code`, as its
 * uvException words it: `ENOENT: no such file or directory, open 'x'`.
 * `detail` stands in libuv's description where Nimbus knows the reason
 * (`/m is mounted read-only, open '/m/x'`).
 */
export function syscallError(code, syscall, path, options = {}) {
    return new VfsError(code, `${ownValue(options, 'detail') ?? VFS_DESCRIPTION[code]}, ${syscall}`, path, { ...options, syscall });
}
/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export function isVfsError(error, code) {
    return error instanceof VfsError && (code === undefined || error.code === code);
}
export function isVfsErrorCode(code) {
    return typeof code === 'string' && objectHasOwn(VFS_ERRNO, code);
}
/**
 * An error from a layer that throws `{ code }` errors (the SQLite engine, a
 * process bridge, Node's own fs) as Node's error for the call that met it:
 * `syscall` on `path`, and `dest` for a call that names two paths, each the
 * error's own where it names one. The layer's error is the cause.
 * A VfsError naming a call or a path is returned as it is; one naming
 * neither (a storage quota's) keeps its words and gains this call's.
 * A layer's own reason (`detail`) is kept as the description.
 * Anything without a known code is returned as it is.
 */
export function toVfsError(error, syscall, path, dest) {
    if (error instanceof VfsError) {
        if (ownValue(error, 'syscall') !== undefined || ownValue(error, 'path') !== undefined)
            return error;
        return syscallError(error.code, syscall, path, { detail: ownValue(error, 'detail'), dest, cause: error });
    }
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function')
        return error;
    const code = ownField(error, 'code');
    if (isVfsErrorCode(code)) {
        const named = ownField(error, 'syscall');
        const call = typeof named === 'string' ? named : syscall;
        // The caller's second path belongs to its own call, not to another the layer names.
        const its = ownField(error, 'dest');
        const second = typeof its === 'string' ? its : call === syscall ? dest : undefined;
        const reason = ownField(error, 'detail');
        const detail = typeof reason === 'string' ? reason : undefined;
        const at = ownField(error, 'path');
        return syscallError(code, call, typeof at === 'string' ? at : path, { dest: second, detail, cause: error });
    }
    return error;
}
/**
 * The codes that are a filesystem call's answer: the call was refused before
 * it changed anything (the name is not there, it is a directory, the
 * storage ledger has no room). Any other (EIO, ESTALE, EAGAIN, none at all)
 * leaves the call's outcome unknown, which is a durability failure whatever
 * the caller does with it.
 */
export const SYSCALL_VERDICTS = new SafeSet([
    'ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EBADF', 'EINVAL', 'EPERM', 'EACCES', 'ELOOP',
    'ENAMETOOLONG', 'ENOSPC', 'EROFS', 'EBUSY', 'ENOTSUP', 'EXDEV', 'ENXIO', 'E2BIG',
]);
/**
 * What rename refuses with before it changes anything. A filesystem whose
 * rename fails after making part of it answers with another code (EIO), so
 * one of these means both names are as they were. EXDEV is among them, and
 * says only that this filesystem cannot make this rename in place.
 */
export const RENAME_REFUSALS = new SafeSet([
    'EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EINVAL', 'EXDEV', 'EROFS', 'ENOSPC',
]);
export function renameOutcome(error) {
    const seen = new SafeSet();
    for (let at = error; typeof at === 'object' && at !== null && !seen.has(at); at = ownField(at, 'cause')) {
        seen.add(at);
        const renamed = ownField(at, 'renamed');
        if (renamed === 'none' || renamed === 'all')
            return renamed;
    }
    return undefined;
}
/**
 * What GNU coreutils print for a filesystem error after the operand: the
 * refusal's own reason where Nimbus gives one, else strerror(3) for its code.
 */
export function strerror(error) {
    if (error instanceof VfsError)
        return ownValue(error, 'detail') ?? VFS_STRERROR[error.code];
    const code = typeof error === 'object' && error !== null ? ownField(error, 'code') : undefined;
    if (isVfsErrorCode(code))
        return VFS_STRERROR[code];
    if (error instanceof Error)
        return reflectGet(error, 'message');
    // An errno this table does not name is printed as its name.
    return typeof code === 'string' ? code : stringOf(error);
}
/** strerror(3) for a code: the text GNU coreutils print. */
export const VFS_STRERROR = {
    EPERM: 'Operation not permitted', ENOENT: 'No such file or directory', EIO: 'Input/output error',
    ENXIO: 'No such device or address', EAGAIN: 'Resource temporarily unavailable', EACCES: 'Permission denied',
    EBUSY: 'Device or resource busy', EEXIST: 'File exists', EXDEV: 'Invalid cross-device link',
    ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EINVAL: 'Invalid argument',
    ENOSPC: 'No space left on device', EROFS: 'Read-only file system', ELOOP: 'Too many levels of symbolic links',
    E2BIG: 'Argument list too long', ENAMETOOLONG: 'File name too long', ENOTEMPTY: 'Directory not empty', ENOTSUP: 'Operation not supported',
    ESTALE: 'Stale file handle', EBADF: 'Bad file descriptor', EFBIG: 'File too large',
};
/**
 * libuv's description of each code: the words before the syscall in Node's
 * message (`util.getSystemErrorMap()`). libuv has no ESTALE; strerror's
 * words stand in.
 */
export const VFS_DESCRIPTION = {
    E2BIG: 'argument list too long', EPERM: 'operation not permitted', ENOENT: 'no such file or directory',
    EIO: 'i/o error', ENXIO: 'no such device or address', EAGAIN: 'resource temporarily unavailable',
    EACCES: 'permission denied', EBUSY: 'resource busy or locked', EEXIST: 'file already exists',
    EXDEV: 'cross-device link not permitted', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory',
    EINVAL: 'invalid argument', ENOSPC: 'no space left on device', EROFS: 'read-only file system',
    ELOOP: 'too many symbolic links encountered', ENAMETOOLONG: 'name too long', ENOTEMPTY: 'directory not empty',
    ENOTSUP: 'operation not supported on socket', ESTALE: 'stale file handle', EBADF: 'bad file descriptor',
    EFBIG: 'file too large',
};
/**
 * libuv's description of any code a filesystem call answers, the VFS's own
 * and a descriptor's (EBADF) alike. WASI's ENOTCAPABLE has none.
 */
export const ERRNO_DESCRIPTION = {
    ...VFS_DESCRIPTION,
    EBADF: 'bad file descriptor', ENODATA: 'no data available', ENOSYS: 'function not implemented',
    EMFILE: 'too many open files', ENFILE: 'file table overflow', ENOMEM: 'not enough memory', ETXTBSY: 'text file is busy',
    EMLINK: 'too many links', ENODEV: 'no such device', ESPIPE: 'invalid seek', EPIPE: 'broken pipe',
    EINTR: 'interrupted system call', ERANGE: 'result too large', EOVERFLOW: 'value too large for defined data type',
    ETIMEDOUT: 'connection timed out', ECANCELED: 'operation canceled', EFAULT: 'bad address in system call argument',
    EHOSTDOWN: 'host is down',
};
/** {@link ERRNO_DESCRIPTION} of `code`, undefined for a code libuv does not name. */
export function errnoDescription(code) {
    return objectHasOwn(ERRNO_DESCRIPTION, code) ? ERRNO_DESCRIPTION[code] : undefined;
}
/** Linux errno numbers of the codes {@link ERRNO_DESCRIPTION} names besides the VFS's, negative as libuv reports them. */
const OTHER_ERRNO = {
    ENODATA: -61, ENOSYS: -38, EMFILE: -24, ENFILE: -23, ENOMEM: -12, ETXTBSY: -26, EMLINK: -31,
    ENODEV: -19, ESPIPE: -29, EPIPE: -32, EINTR: -4, ERANGE: -34, EOVERFLOW: -75, ETIMEDOUT: -110, ECANCELED: -125,
    EFAULT: -14, EHOSTDOWN: -112,
};
/** `code`'s errno, negative as libuv reports it; undefined for a code this table does not name. */
export function errnoOf(code) {
    if (isVfsErrorCode(code))
        return VFS_ERRNO[code];
    return objectHasOwn(OTHER_ERRNO, code) ? OTHER_ERRNO[code] : undefined;
}
/**
 * Node's message for a failed system call, as its uvException words it: the
 * code, what was said of it (`no such file or directory, open`), then the
 * path quoted and a second path after an arrow. The one template: VfsError
 * and {@link fsError} both print it.
 */
export function systemErrorMessage(code, said, path, dest) {
    return `${code}: ${said}${path !== undefined ? ` '${path}'` : ''}${dest !== undefined ? ` -> '${dest}'` : ''}`;
}
/**
 * Node's error for `syscall` failing on `path` with any code, as a plain
 * Error, as Node's fs throws it (where VfsError, for the VFS's own codes, is
 * a class callers test for): `ENOENT: no such file or directory, open 'x'`,
 * `rename 'a' -> 'b'` for a call naming `dest` too, no path for a call on a
 * descriptor (`EBADF: bad file descriptor, read`). Its errno is the code's.
 * `detail` stands in the description where Nimbus knows the reason.
 */
export function fsError(code, syscall, path, dest, options = {}) {
    const given = ownValue(options, 'detail');
    const cause = ownValue(options, 'cause');
    const words = given ?? errnoDescription(code);
    const error = new Error(systemErrorMessage(code, words === undefined ? syscall : `${words}, ${syscall}`, path, dest), cause === undefined ? undefined : { cause });
    const errno = errnoOf(code);
    return objectAssign(error, {
        code,
        ...(errno === undefined ? {} : { errno }),
        syscall,
        ...(path === undefined ? {} : { path }),
        ...(dest === undefined ? {} : { dest }),
        ...(given === undefined ? {} : { detail: given }),
    });
}
