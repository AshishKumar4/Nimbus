/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */

export type VfsErrorCode =
  | 'EPERM'
  | 'ENOENT'
  | 'EIO'
  | 'ENXIO'
  | 'EAGAIN'
  | 'EACCES'
  | 'EBUSY'
  | 'EEXIST'
  | 'EXDEV'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EINVAL'
  | 'ENOSPC'
  | 'EROFS'
  | 'ELOOP'
  | 'ENAMETOOLONG'
  | 'ENOTEMPTY'
  | 'ENOTSUP'
  | 'ESTALE';

/** Linux errno numbers, negative as libuv reports them. */
export const VFS_ERRNO: Readonly<Record<VfsErrorCode, number>> = {
  EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17,
  EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOSPC: -28, EROFS: -30, ELOOP: -40,
  ENAMETOOLONG: -36, ENOTEMPTY: -39, ENOTSUP: -95, ESTALE: -116,
};

export class VfsError extends Error {
  readonly errno: number;

  constructor(readonly code: VfsErrorCode, message: string, readonly path?: string, options?: ErrorOptions) {
    super(`${code}: ${message}${path !== undefined ? `, '${path}'` : ''}`, options);
    this.name = 'VfsError';
    this.errno = VFS_ERRNO[code];
  }
}

/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export function isVfsError(error: unknown, code?: VfsErrorCode): error is VfsError {
  return error instanceof VfsError && (code === undefined || error.code === code);
}
