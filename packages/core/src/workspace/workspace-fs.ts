/**
 * The namespace as a process with a working directory sees it: the face an
 * embedder holds as `NimbusWorkspace.fs`.
 *
 * A ProcessView takes every path from the root: a relative path is a key
 * under `/` ('etc/passwd' is /etc/passwd), and that is what Nimbus's own
 * code hands it. This is the same view with a working directory of its own,
 * as a process has one. An absolute path means what it means to the view,
 * and a relative one is taken from `cwd`, as open(2) takes it: `..` is left
 * to the walk, which takes it after a link, as the kernel does.
 *
 * The two are different types on purpose. Neither is assignable to the
 * other, so a root-relative key never reaches a view that would read it
 * from a working directory, and a user's relative path never reaches one
 * that would read it from the root.
 */

import { syscallError, VfsError } from '../vfs/vfs-error.js';
import type { VFS, VfsDirent, VfsRemoval } from '../vfs/vfs.js';
import type { ProcessStat, ProcessView } from '../runtime/process-files.js';

export class WorkspaceFs implements VFS {
  constructor(
    private readonly view: ProcessView,
    /** Where a relative path starts: this view's own, which no `cd` in a shell moves. */
    readonly cwd: string,
  ) {
    if (!cwd.startsWith('/')) throw new TypeError(`a working directory is an absolute path, got ${JSON.stringify(cwd)}`);
  }

  /**
   * The absolute path this view's operations use for `path`: itself when it
   * is absolute, else from `cwd`, with `.` components dropped and `..` kept
   * for the walk. An empty path names nothing (ENOENT), as in open(2).
   */
  resolve(path: string): string {
    if (path === '') throw new VfsError('ENOENT', 'no such file or directory', path);
    if (path.startsWith('/')) return path;
    const rest = path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
    if (rest === '') return this.cwd;
    // A trailing slash says the name is a directory; it stays.
    return `${this.cwd === '/' ? '' : this.cwd}/${rest}${/\/\.?$/.test(path) ? '/' : ''}`;
  }

  /**
   * `path` resolved, for a call that removes or replaces the entry it names:
   * a last component of `.` or `..` names a directory by its relation to
   * another, and is refused with the code Linux gives `syscall`, never
   * taken as the directory itself.
   */
  private entry(path: string, syscall: 'unlink' | 'rmdir' | 'rm' | 'rename'): string {
    const last = path.replace(/\/+$/, '').split('/').pop();
    if (last === '.' || last === '..') {
      const codes = { unlink: 'EISDIR', rmdir: last === '..' ? 'ENOTEMPTY' : 'EINVAL', rm: 'EINVAL', rename: 'EBUSY' } as const;
      throw syscallError(codes[syscall], syscall, path);
    }
    return this.resolve(path);
  }

  async stat(path: string, options?: { follow?: boolean }): Promise<ProcessStat | null> { return await this.view.stat(this.resolve(path), options); }
  /** Whether anything is at `path` (links followed). */
  async exists(path: string): Promise<boolean> { return await this.view.exists(this.resolve(path)); }
  async isFile(path: string): Promise<boolean> { return await this.view.isFile(this.resolve(path)); }
  async isDirectory(path: string): Promise<boolean> { return await this.view.isDirectory(this.resolve(path)); }
  /** Whether `path` itself is a symbolic link. */
  async isSymlink(path: string): Promise<boolean> { return await this.view.isSymlink(this.resolve(path)); }
  /** The file's bytes as UTF-8 text. */
  async readFileString(path: string): Promise<string> { return await this.view.readFileString(this.resolve(path)); }
  async readFile(path: string): Promise<Uint8Array> { return await this.view.readFile(this.resolve(path)); }
  /** `mode` applies only if this creates the file (ProcessView.writeFile). */
  async writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
    return await this.view.writeFile(this.resolve(path), data, options);
  }
  async readdir(path: string): Promise<VfsDirent[]> { return await this.view.readdir(this.resolve(path)); }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> { return await this.view.mkdir(this.resolve(path), options); }
  async unlink(path: string): Promise<void> { return await this.view.unlink(this.entry(path, 'unlink')); }
  async rmdir(path: string): Promise<void> { return await this.view.rmdir(this.entry(path, 'rmdir')); }
  /** rename(2): EXDEV across filesystems. */
  async rename(from: string, to: string): Promise<void> { return await this.view.rename(this.entry(from, 'rename'), this.entry(to, 'rename')); }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> { return await this.view.readRange(this.resolve(path), offset, length); }
  /** A ranged read that neither consults nor fills the session's content cache. */
  async readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array> {
    return await this.view.readRangeUncached(this.resolve(path), offset, length);
  }
  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void> { return await this.view.writeRange(this.resolve(path), offset, bytes); }
  /** writeFile of `size` bytes that arrive over time, published whole once they have. */
  async writeFileFrom(path: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void> {
    return await this.view.writeFileFrom(this.resolve(path), size, source);
  }
  async truncate(path: string, size: number): Promise<void> { return await this.view.truncate(this.resolve(path), size); }
  /** rm -r, with what went and what is still there (ProcessView.removeRecursive). */
  async removeRecursive(path: string): Promise<VfsRemoval> { return await this.view.removeRecursive(this.entry(path, 'rm')); }
  /** `target` is the link's text, taken from the link's directory when it is followed, never from `cwd`. */
  async symlink(target: string, path: string): Promise<void> { return await this.view.symlink(target, this.resolve(path)); }
  async readlink(path: string): Promise<string> { return await this.view.readlink(this.resolve(path)); }
  async chmod(path: string, mode: number): Promise<void> { return await this.view.chmod(this.resolve(path), mode); }
  /** chown(2): a null side keeps what the file has (chown -1). */
  async chown(path: string, uid: number | null, gid: number | null): Promise<void> { return await this.view.chown(this.resolve(path), uid, gid); }
  /** utimensat(2): null is now, undefined leaves that time; `follow: false` sets a link's own times. */
  async utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { follow?: boolean }): Promise<void> {
    return await this.view.utimes(this.resolve(path), atimeMs, mtimeMs, options);
  }
  /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
  async copy(from: string, to: string, options?: { recursive?: boolean; preserve?: boolean }): Promise<number> {
    return await this.view.copy(this.resolve(from), this.resolve(to), options);
  }
  /** Create the file if absent, and set its times to now (touch). */
  async touch(path: string): Promise<void> { return await this.view.touch(this.resolve(path)); }
  async readFileUncached(path: string): Promise<Uint8Array> { return await this.view.readFileUncached(this.resolve(path)); }
  async readArrayBufferUncached(path: string): Promise<ArrayBuffer> { return await this.view.readArrayBufferUncached(this.resolve(path)); }
  /** rm: a file, or with `recursive` a tree, whole or not at all; `force` makes a missing path no error. */
  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> { return await this.view.remove(this.entry(path, 'rm'), options); }
  /** Each entry of a directory with its own stat (links not followed). */
  async readdirStat(path: string): Promise<Array<ProcessStat & { name: string }>> { return await this.view.readdirStat(this.resolve(path)); }
  /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
  async access(path: string, mode: number): Promise<void> { return await this.view.access(this.resolve(path), mode); }
  /** Where `path` leads with every link followed: an absolute path. */
  async realpath(path: string): Promise<string> { return await this.view.realpath(this.resolve(path)); }
  /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
  async appendFile(path: string, content: Uint8Array | string): Promise<void> { return await this.view.appendFile(this.resolve(path), content); }
}
