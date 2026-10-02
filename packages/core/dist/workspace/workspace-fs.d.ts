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
import { type MoveOptions } from '../vfs/move.js';
import type { VFS, VfsDirent, VfsRemoval } from '../vfs/vfs.js';
import type { ProcessStat, ProcessView } from '../runtime/process-files.js';
export declare class WorkspaceFs implements VFS {
    private readonly view;
    /** Where a relative path starts: this view's own, which no `cd` in a shell moves. */
    readonly cwd: string;
    constructor(view: ProcessView, 
    /** Where a relative path starts: this view's own, which no `cd` in a shell moves. */
    cwd: string);
    /**
     * The absolute path this view's operations use for `path`: itself when it
     * is absolute, else `cwd` and then `path` as it is spelled. Every `.` and
     * `..` is left to the walk: `.` after a link makes it followed, so with
     * `cwd` a link to a directory, `.` is that directory, as it is to a
     * process. An empty path names nothing (ENOENT), as in open(2).
     */
    resolve(path: string): string;
    /**
     * `path` resolved, for a call that removes or replaces the entry it names:
     * a last component of `.` or `..` names a directory by its relation to
     * another, and is refused with the code Linux gives `syscall`, never
     * taken as the directory itself.
     */
    private entry;
    stat(path: string, options?: {
        follow?: boolean;
    }): Promise<ProcessStat | null>;
    /** Whether anything is at `path` (links followed). */
    exists(path: string): Promise<boolean>;
    isFile(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    /** Whether `path` itself is a symbolic link. */
    isSymlink(path: string): Promise<boolean>;
    /** The file's bytes as UTF-8 text. */
    readFileString(path: string): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    /** `mode` applies only if this creates the file (ProcessView.writeFile). */
    writeFile(path: string, data: Uint8Array | string, options?: {
        mode?: number;
    }): Promise<void>;
    readdir(path: string): Promise<VfsDirent[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    /** rename(2): EXDEV across filesystems, where {@link move} copies. */
    rename(from: string, to: string): Promise<void>;
    /**
     * mv: one rename, or across filesystems (and on one that cannot rename in
     * place) a copy that happens whole or not at all, directories included.
     * `to` is the new name, as rename's is. See vfs/move.ts.
     */
    move(from: string, to: string, options?: MoveOptions): Promise<void>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    /** A ranged read that neither consults nor fills the session's content cache. */
    readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array>;
    writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void>;
    /** writeFile of `size` bytes that arrive over time, published whole once they have. */
    writeFileFrom(path: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    /** rm -r, with what went and what is still there (ProcessView.removeRecursive). */
    removeRecursive(path: string): Promise<VfsRemoval>;
    /** `target` is the link's text, taken from the link's directory when it is followed, never from `cwd`. */
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    /** chown(2): a null side keeps what the file has (chown -1). */
    chown(path: string, uid: number | null, gid: number | null): Promise<void>;
    /** utimensat(2): null is now, undefined leaves that time; `follow: false` sets a link's own times. */
    utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: {
        follow?: boolean;
    }): Promise<void>;
    /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
    copy(from: string, to: string, options?: {
        recursive?: boolean;
        preserve?: boolean;
    }): Promise<number>;
    /** Create the file if absent, and set its times to now (touch). */
    touch(path: string): Promise<void>;
    readFileUncached(path: string): Promise<Uint8Array>;
    readArrayBufferUncached(path: string): Promise<ArrayBuffer>;
    /** rm: a file, or with `recursive` a tree, whole or not at all; `force` makes a missing path no error. */
    remove(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    /** Each entry of a directory with its own stat (links not followed). */
    readdirStat(path: string): Promise<Array<ProcessStat & {
        name: string;
    }>>;
    /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
    access(path: string, mode: number): Promise<void>;
    /** Where `path` leads with every link followed: an absolute path. */
    realpath(path: string): Promise<string>;
    /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
    appendFile(path: string, content: Uint8Array | string): Promise<void>;
}
//# sourceMappingURL=workspace-fs.d.ts.map