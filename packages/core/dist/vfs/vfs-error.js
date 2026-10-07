/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */
/** Linux errno numbers, negative as libuv reports them. */
export const VFS_ERRNO = {
    E2BIG: -7, EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17,
    EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOSPC: -28, EROFS: -30, ELOOP: -40,
    ENAMETOOLONG: -36, ENOTEMPTY: -39, ENOTSUP: -95, ESTALE: -116, EBADF: -9,
};
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
        super(systemErrorMessage(code, message, path, options?.dest), options);
        this.code = code;
        this.path = path;
        this.name = 'VfsError';
        this.errno = VFS_ERRNO[code];
        if (options?.syscall !== undefined)
            this.syscall = options.syscall;
        if (options?.dest !== undefined)
            this.dest = options.dest;
        const detail = options?.detail ?? (options?.syscall === undefined && message !== VFS_DESCRIPTION[code] ? message : undefined);
        if (detail !== undefined)
            this.detail = detail;
    }
}
/**
 * Node's error for `syscall` failing on `path` with `code`, as its
 * uvException words it: `ENOENT: no such file or directory, open 'x'`.
 * `detail` stands in libuv's description where Nimbus knows the reason
 * (`/m is mounted read-only, open '/m/x'`).
 */
export function syscallError(code, syscall, path, options = {}) {
    return new VfsError(code, `${options.detail ?? VFS_DESCRIPTION[code]}, ${syscall}`, path, { ...options, syscall });
}
/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export function isVfsError(error, code) {
    return error instanceof VfsError && (code === undefined || error.code === code);
}
export function isVfsErrorCode(code) {
    return typeof code === 'string' && Object.hasOwn(VFS_ERRNO, code);
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
        if (error.syscall !== undefined || error.path !== undefined)
            return error;
        return syscallError(error.code, syscall, path, { detail: error.detail, dest, cause: error });
    }
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function')
        return error;
    const code = 'code' in error ? error.code : undefined;
    if (isVfsErrorCode(code)) {
        const call = 'syscall' in error && typeof error.syscall === 'string' ? error.syscall : syscall;
        // The caller's second path belongs to its own call, not to another the layer names.
        const second = 'dest' in error && typeof error.dest === 'string' ? error.dest : call === syscall ? dest : undefined;
        const detail = 'detail' in error && typeof error.detail === 'string' ? error.detail : undefined;
        return syscallError(code, call, 'path' in error && typeof error.path === 'string' ? error.path : path, { dest: second, detail, cause: error });
    }
    return error;
}
/**
 * What rename refuses with before it changes anything. A filesystem whose
 * rename fails after making part of it answers with another code (EIO), so
 * one of these means both names are as they were. EXDEV is among them, and
 * says only that this filesystem cannot make this rename in place.
 */
export const RENAME_REFUSALS = new Set([
    'EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EINVAL', 'EXDEV', 'EROFS', 'ENOSPC',
]);
export function renameOutcome(error) {
    const seen = new Set();
    for (let at = error; typeof at === 'object' && at !== null && !seen.has(at); at = at.cause) {
        seen.add(at);
        const renamed = at.renamed;
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
        return error.detail ?? VFS_STRERROR[error.code];
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (isVfsErrorCode(code))
        return VFS_STRERROR[code];
    if (error instanceof Error)
        return error.message;
    // An errno this table does not name is printed as its name.
    return typeof code === 'string' ? code : String(error);
}
/** strerror(3) for a code: the text GNU coreutils print. */
export const VFS_STRERROR = {
    EPERM: 'Operation not permitted', ENOENT: 'No such file or directory', EIO: 'Input/output error',
    ENXIO: 'No such device or address', EAGAIN: 'Resource temporarily unavailable', EACCES: 'Permission denied',
    EBUSY: 'Device or resource busy', EEXIST: 'File exists', EXDEV: 'Invalid cross-device link',
    ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EINVAL: 'Invalid argument',
    ENOSPC: 'No space left on device', EROFS: 'Read-only file system', ELOOP: 'Too many levels of symbolic links',
    E2BIG: 'Argument list too long', ENAMETOOLONG: 'File name too long', ENOTEMPTY: 'Directory not empty', ENOTSUP: 'Operation not supported',
    ESTALE: 'Stale file handle', EBADF: 'Bad file descriptor',
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
};
/**
 * libuv's description of any code a filesystem call answers, the VFS's own
 * and a descriptor's (EBADF) alike. WASI's ENOTCAPABLE has none.
 */
export const ERRNO_DESCRIPTION = {
    ...VFS_DESCRIPTION,
    EBADF: 'bad file descriptor', EFBIG: 'file too large', ENODATA: 'no data available', ENOSYS: 'function not implemented',
    EMFILE: 'too many open files', ENFILE: 'file table overflow', ENOMEM: 'not enough memory', ETXTBSY: 'text file is busy',
    EMLINK: 'too many links', ENODEV: 'no such device', ESPIPE: 'invalid seek', EPIPE: 'broken pipe',
    EINTR: 'interrupted system call', ERANGE: 'result too large', EOVERFLOW: 'value too large for defined data type',
    ETIMEDOUT: 'connection timed out', ECANCELED: 'operation canceled', EFAULT: 'bad address in system call argument',
};
/** {@link ERRNO_DESCRIPTION} of `code`, undefined for a code libuv does not name. */
export function errnoDescription(code) {
    return Object.prototype.hasOwnProperty.call(ERRNO_DESCRIPTION, code) ? ERRNO_DESCRIPTION[code] : undefined;
}
/** Linux errno numbers of the codes {@link ERRNO_DESCRIPTION} names besides the VFS's, negative as libuv reports them. */
const OTHER_ERRNO = {
    EFBIG: -27, ENODATA: -61, ENOSYS: -38, EMFILE: -24, ENFILE: -23, ENOMEM: -12, ETXTBSY: -26, EMLINK: -31,
    ENODEV: -19, ESPIPE: -29, EPIPE: -32, EINTR: -4, ERANGE: -34, EOVERFLOW: -75, ETIMEDOUT: -110, ECANCELED: -125,
    EFAULT: -14,
};
/** `code`'s errno, negative as libuv reports it; undefined for a code this table does not name. */
export function errnoOf(code) {
    if (isVfsErrorCode(code))
        return VFS_ERRNO[code];
    return Object.prototype.hasOwnProperty.call(OTHER_ERRNO, code) ? OTHER_ERRNO[code] : undefined;
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
    const words = options.detail ?? errnoDescription(code);
    const error = new Error(systemErrorMessage(code, words === undefined ? syscall : `${words}, ${syscall}`, path, dest), options.cause === undefined ? undefined : { cause: options.cause });
    const errno = errnoOf(code);
    return Object.assign(error, {
        code,
        ...(errno === undefined ? {} : { errno }),
        syscall,
        ...(path === undefined ? {} : { path }),
        ...(dest === undefined ? {} : { dest }),
        ...(options.detail === undefined ? {} : { detail: options.detail }),
    });
}
