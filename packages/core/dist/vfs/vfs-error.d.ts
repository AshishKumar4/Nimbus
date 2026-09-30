/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */
export type VfsErrorCode = 'E2BIG' | 'EPERM' | 'ENOENT' | 'EIO' | 'ENXIO' | 'EAGAIN' | 'EACCES' | 'EBUSY' | 'EEXIST' | 'EXDEV' | 'ENOTDIR' | 'EISDIR' | 'EINVAL' | 'ENOSPC' | 'EROFS' | 'ELOOP' | 'ENAMETOOLONG' | 'ENOTEMPTY' | 'ENOTSUP' | 'ESTALE';
/** Linux errno numbers, negative as libuv reports them. */
export declare const VFS_ERRNO: Readonly<Record<VfsErrorCode, number>>;
/** What a VfsError carries besides its cause: Node's `err.syscall` and `err.dest`. */
export interface VfsErrorOptions extends ErrorOptions {
    /** The call that failed (`open`, `scandir`, `rename`), as Node names it. */
    syscall?: string;
    /** The second path of a call that names two (rename, copyfile, symlink). */
    dest?: string;
}
export declare class VfsError extends Error {
    readonly code: VfsErrorCode;
    readonly path?: string | undefined;
    readonly errno: number;
    readonly syscall?: string;
    readonly dest?: string;
    /**
     * `message` is what Node's message says before the path: the description
     * and the syscall (`no such file or directory, open`). The path follows it
     * as Node prints one, and a second path after an arrow:
     * `ENOENT: no such file or directory, open 'x'`,
     * `EXDEV: cross-device link not permitted, rename 'a' -> 'b'`.
     */
    constructor(code: VfsErrorCode, message: string, path?: string | undefined, options?: VfsErrorOptions);
}
/**
 * Node's error for `syscall` failing on `path` with `code`, as its
 * uvException words it: `ENOENT: no such file or directory, open 'x'`.
 * `detail` stands in libuv's description where Nimbus knows the reason
 * (`/m is mounted read-only, open '/m/x'`).
 */
export declare function syscallError(code: VfsErrorCode, syscall: string, path?: string, options?: VfsErrorOptions & {
    detail?: string;
}): VfsError;
/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export declare function isVfsError(error: unknown, code?: VfsErrorCode): error is VfsError;
/**
 * An error from a layer that throws `{ code }` errors (the SQLite engine, a
 * process bridge) as Node's error for the call that met it: `syscall` on
 * `path` (a bridge error's own syscall and path when it names them), and
 * `dest` for a call that names two paths. The layer's error is the cause.
 * A VfsError naming a call or a path is returned as it is; one naming
 * neither (a storage quota's) keeps its words and gains this call's.
 * Anything without a known code is returned as it is.
 */
export declare function toVfsError(error: unknown, syscall: string, path: string, dest?: string): unknown;
/** strerror(3) for a code: the text GNU coreutils print. */
export declare const VFS_STRERROR: Readonly<Record<VfsErrorCode, string>>;
/**
 * libuv's description of each code: the words before the syscall in Node's
 * message (`util.getSystemErrorMap()`). libuv has no ESTALE; strerror's
 * words stand in.
 */
export declare const VFS_DESCRIPTION: Readonly<Record<VfsErrorCode, string>>;
/**
 * libuv's description of any code a filesystem call answers, the VFS's own
 * and a descriptor's (EBADF) alike. WASI's ENOTCAPABLE has none.
 */
export declare const ERRNO_DESCRIPTION: Readonly<Record<string, string>>;
/** {@link ERRNO_DESCRIPTION} of `code`, undefined for a code libuv does not name. */
export declare function errnoDescription(code: string): string | undefined;
//# sourceMappingURL=vfs-error.d.ts.map