/**
 * The filesystem interface: one small required core, and optional
 * capabilities a caller probes for.
 *
 * A backend implements `VFS` over whatever it stores (SQLite, memory, a
 * container, a device). `CompositeVFS` mounts backends into one namespace.
 * Paths are absolute and normalized; a mounted backend sees paths relative
 * to its own root ('/' is the mount point itself).
 *
 * An optional capability is either there or absent, never emulated where the
 * emulation would change its meaning: a compare-and-write done as read,
 * compare, write is not atomic, and a ranged read done as a whole read of a
 * 4 GB file is not a ranged read. A caller without the capability learns
 * that (ENOTSUP) and decides.
 */
import type { RuntimeDirentType, VfsAcquireOptions, VfsAcquireResult, VfsListPage } from '../runtime/os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import type { VfsEvent } from './events.js';
import { type VfsError } from './vfs-error.js';
export type Awaitable<T> = T | Promise<T>;
export declare function isPromise<T>(value: Awaitable<T>): value is Promise<T>;
/** `value`, which a synchronous face answers at once: one that would wait is its caller's fault, never a value. */
export declare function syncValue<T>(value: Awaitable<T>): T;
/** `file`, opened for no one any more: closed, its answer unheard (nothing was written through it). */
export declare function abandon(file: {
    close(): Awaitable<void>;
}): void;
/**
 * Apply `next` to a value that may or may not be a promise, staying
 * synchronous when it is not. (Not `then`: a module exporting `then` is a
 * thenable to `await import()`.)
 */
export declare function andThen<T, U>(value: Awaitable<T>, next: (resolved: T) => Awaitable<U>): Awaitable<U>;
/** A backend's version of a file: a generation number, or an opaque persisted identity. */
export type VfsRevision = number | string;
export type VfsFileType = 'file' | 'directory' | 'symlink';
export interface VfsStat {
    type: VfsFileType;
    size: number;
    mtimeMs: number;
    /**
     * The file's version at this instant, when the backend keeps one. Absent
     * means unknown, and a cache must then never hold the file's content: a
     * change it cannot see would go unnoticed.
     */
    revision?: VfsRevision;
    mode?: number;
    uid?: number;
    gid?: number;
    atimeMs?: number;
    ctimeMs?: number;
    ino?: number;
    nlink?: number;
    /** The filesystem the entry lives on (st_dev): distinct per mount. */
    dev?: number;
}
/** A directory entry; `stat` when the backend has it for free (it saves a call per child). */
/** A directory entry's type as d_type gives it (RuntimeDirentType): a backend says 'file' only of a regular file. */
export type VfsDirentType = RuntimeDirentType;
export interface VfsDirent {
    name: string;
    type: VfsDirentType;
    stat?: VfsStat;
}
export interface VfsCred {
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
    readonly umask: number;
}
/**
 * Who a view acts as. The embedder's own view has no credential. `actor` names
 * a principal finer than its uid: two agents (or a node and its origin) that
 * share a credential but see different mounts.
 */
export interface Principal {
    readonly cred: VfsCred | null;
    readonly actor?: string;
}
/** What stood, or stands, at a path a mutation landed on (VfsWriteEvent). */
export interface VfsContentRef {
    readonly type: VfsFileType;
    readonly size: number;
    /**
     * The bytes (a link's text) as they were then, whatever was written
     * since; EISDIR for a directory. Readable until the observer's callback
     * (and the promise it returned) settles, EBADF after.
     */
    read(): Awaitable<Uint8Array>;
}
/** A mutation that landed (VFS.observeWrites): reported once, after it committed. */
export interface VfsWriteEvent {
    /** 'create' when nothing stood at `path`, 'delete' when nothing does now, 'rename' with `oldPath`. */
    readonly type: 'create' | 'modify' | 'delete' | 'rename';
    readonly path: string;
    /** A rename's source. */
    readonly oldPath?: string;
    /** What stood at `path` before: null when nothing did, undefined when it was not captured. */
    readonly before: VfsContentRef | null | undefined;
    /** What stands at `path` after: null when nothing does, undefined when it was not captured. */
    readonly after: VfsContentRef | null | undefined;
    /** Who made it: the principal of the view it came through. */
    readonly principal: Principal;
}
/** Told of each landed mutation; a promise it returns holds the event's content until it settles. */
export type VfsWriteObserver = (event: VfsWriteEvent) => void | Promise<void>;
/** Which of a write's sides an observer wants read (CompositeVFS.observeWrites): both, neither, or each. */
export type VfsWriteWants = boolean | {
    readonly before: boolean;
    readonly after: boolean;
};
export interface VfsMountDescription {
    /** df's "Filesystem" column. */
    source: string;
    type: string;
    options?: readonly string[];
}
export interface VfsUsage {
    size: number;
    used: number;
    available: number;
}
/** How a principal's view of a backend reads (VFS.as). */
export interface VfsViewOptions {
    holds?: () => ReadonlySet<string>;
    landed?: boolean;
}
/** A file a backend holds open (VFS.openFile): it stays this file after its name is renamed or unlinked. */
export interface VfsOpenFile {
    /** Its name on the backend now; null once it has none (unlinked). */
    path(): Awaitable<string | null>;
    stat(): Awaitable<VfsStat>;
    /** At most `length` bytes from `offset`, clamped at its end. */
    read(offset: number, length: number): Awaitable<Uint8Array>;
    /** `bytes` at `offset`, zero-filling any gap past its end. */
    write(offset: number, bytes: Uint8Array): Awaitable<void>;
    truncate(size: number): Awaitable<void>;
    close(): Awaitable<void>;
}
export interface VFS {
    /** Null when nothing is there. `follow: false` is lstat. */
    stat(path: string, options?: {
        follow?: boolean;
    }): Awaitable<VfsStat | null>;
    readFile(path: string): Awaitable<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
    }): Awaitable<void>;
    readdir(path: string): Awaitable<VfsDirent[]>;
    /**
     * With `recursive`, it may answer the directories it made, top down
     * (none: they were all there), as Node's answers the first of them;
     * nothing: it does not say, and on a mount that resolves its own paths
     * (MountOptions.resolvesPaths) nothing it made is told
     * (CompositeVFS.watchChanges), unless its backend tells its own changes.
     */
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Awaitable<readonly string[] | void>;
    /** Removes a file; on backends without `rmdir`, also an empty directory. */
    unlink(path: string): Awaitable<void>;
    /** Removes an empty directory. Absent: the composite checks emptiness and unlinks. */
    rmdir?(path: string): Awaitable<void>;
    /**
     * Within this backend. Absent: the composite answers EXDEV, which mv
     * already handles by copying. A refusal (RENAME_REFUSALS, vfs-error.ts)
     * says nothing changed; a rename that fails after making part of itself
     * answers EIO, and may say how far it got (renameOutcome).
     */
    rename?(from: string, to: string): Awaitable<void>;
    /** At most `length` bytes from `offset`, clamped at end of file. */
    readRange?(path: string, offset: number, length: number): Awaitable<Uint8Array>;
    /** Writes `bytes` at `offset`, zero-filling any gap past the end, creating the file. */
    writeRange?(path: string, offset: number, bytes: Uint8Array): Awaitable<void>;
    truncate?(path: string, size: number): Awaitable<void>;
    /**
     * Refuses (EACCES) an open of `path` asking `mode` (r=4, w=2, x=1) the
     * principal may not have, by this backend's own policy. Absent: a backend
     * of one identity, which refuses no one at open.
     */
    access?(path: string, mode: number): Awaitable<void>;
    /**
     * Whether something is at `path` (itself: a link is not followed) as its
     * changes have been told (watchChanges), storing nothing it holds back and
     * asking nothing of another holder; a backend that holds nothing back
     * need not have it (stat answers). EACCES where it may not look.
     */
    landedAt?(path: string): Awaitable<boolean>;
    /**
     * The regular file at `path`, held open with `rights` (its access decided
     * by the open that asks, VFS.access): its operations reach that file
     * wherever it is named later, renamed or unlinked, until its close. Absent:
     * a backend that keeps no open files; its files are held by name.
     */
    openFile?(path: string, rights: {
        read: boolean;
        write: boolean;
    }): Awaitable<VfsOpenFile>;
    /**
     * The store its files' numbers (VfsStat.ino) are its own in: one object
     * for every view of the same files (`as`), whatever wraps them, and another
     * for any other files. Absent: the backend object is.
     */
    readonly fileStore?: object;
    /**
     * rm -r; nothing returned means the whole operand went.
     * `keepVanishedAncestors`: a child that vanished mid-walk keeps the
     * directories holding it, as GNU rm -r leaves them.
     */
    removeRecursive?(path: string, options?: {
        keepVanishedAncestors?: boolean;
    }): Awaitable<VfsRemoval | void>;
    symlink?(target: string, path: string): Awaitable<void>;
    readlink?(path: string): Awaitable<string>;
    chmod?(path: string, mode: number): Awaitable<void>;
    /** A null side keeps what the file has (chown(2)'s -1). */
    chown?(path: string, uid: number | null, gid: number | null): Awaitable<void>;
    /** utimensat(2), each time an FsTime: resolved and judged here, as the change commits. */
    utimes?(path: string, atime: FsTime, mtime: FsTime): Awaitable<void>;
    /** Copy within this backend (SQLite copies rows, not bytes). Returns entries copied. */
    copy?(from: string, to: string, options?: VfsCopyOptions): Awaitable<number>;
    /** Compare-and-write. Never emulated with read, compare, write. */
    writeFileIfRevision?(path: string, data: Uint8Array, expected: VfsRevision): Awaitable<VfsCasResult>;
    /** Exactly that version, or a refusal; never the current file in its place. */
    readFileAtRevision?(path: string, revision: VfsRevision, range?: VfsRange): Awaitable<Uint8Array>;
    /**
     * This backend as another principal (`actor` names it finer than its uid).
     * `options.holds`: the delegations the principal's process holds, asked at
     * each call (its own lookups recall none of them). `options.landed`: its
     * reads read what has landed, asking no holder for what it has not sent
     * (its writes still recall). Absent: the backend has one identity.
     */
    as?(cred: VfsCred, actor?: string, options?: VfsViewOptions): VFS;
    /**
     * Every mutation that lands on this backend, whoever made it, with what
     * it replaced (VfsWriteEvent); the returned function stops the reports.
     */
    observeWrites?(observer: VfsWriteObserver): () => void;
    /**
     * Every mutation that lands at `path` or under it on this backend,
     * whoever made it, by path (VfsEvent, paths absolute), in this view's
     * names and only where this view may look, once it landed, told in the
     * batches the backend makes of them: nothing read, held or waited for.
     * The returned function stops it.
     */
    watchChanges?(path: string, listener: (events: readonly VfsEvent[]) => void): () => void;
    /** The same operations, completing without waiting. Present only when every call can. */
    readonly sync?: SyncVFS;
    /**
     * What changed since a cursor, and a complete listing: what a cache of
     * this backend (a node process's staged files) is kept coherent with. A
     * backend without it is never cached.
     */
    readonly changes?: VfsChanges;
    /**
     * Whether a write of a whole regular file leaves exactly the bytes it was
     * given as its content: true for a backend that stores what it is written
     * (SQLite, memory). One that does not say so (a device that discards or
     * streams, a /proc) has its content read back where an observer asks.
     */
    readonly storesWrites?: boolean;
    describe?(): VfsMountDescription;
    usage?(): Awaitable<VfsUsage | null>;
}
/** The change feed of a backend with revisions (SqliteVFS). */
export interface VfsChanges {
    /** Changes when revisions could regress or be reused: a cursor from another epoch is a poison. */
    readonly epoch: string;
    revision(): number;
    /** Every path changed in (cursor, now], with its stat when asked; a poison when that cannot be answered. */
    since(epoch: string | null, cursor: number, options?: VfsAcquireOptions): VfsAcquireResult;
    /** One page of every name, in path order. */
    list(after: string | null, limit: number): VfsListPage;
}
export type VfsCasResult = {
    ok: true;
    revision: VfsRevision;
} | {
    ok: false;
    revision: VfsRevision;
};
export interface VfsRange {
    offset: number;
    length: number;
}
/**
 * The operations of `VFS`, returning their values: what a caller that
 * cannot wait uses. The same members, required and optional alike; no views,
 * watches or descriptions.
 */
export interface SyncVFS {
    /** VFS.fileStore: the same store as the face it is of. */
    readonly fileStore?: object;
    stat(path: string, options?: {
        follow?: boolean;
    }): VfsStat | null;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
    }): void;
    readdir(path: string): VfsDirent[];
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): readonly string[] | void;
    unlink(path: string): void;
    rmdir?(path: string): void;
    rename?(from: string, to: string): void;
    readRange?(path: string, offset: number, length: number): Uint8Array;
    writeRange?(path: string, offset: number, bytes: Uint8Array): void;
    truncate?(path: string, size: number): void;
    access?(path: string, mode: number): void;
    landedAt?(path: string): boolean;
    openFile?(path: string, rights: {
        read: boolean;
        write: boolean;
    }): VfsOpenFile;
    removeRecursive?(path: string, options?: {
        keepVanishedAncestors?: boolean;
    }): VfsRemoval | void;
    symlink?(target: string, path: string): void;
    readlink?(path: string): string;
    chmod?(path: string, mode: number): void;
    chown?(path: string, uid: number | null, gid: number | null): void;
    utimes?(path: string, atime: FsTime, mtime: FsTime): void;
    copy?(from: string, to: string, options?: VfsCopyOptions): number;
    writeFileIfRevision?(path: string, data: Uint8Array, expected: VfsRevision): VfsCasResult;
    readFileAtRevision?(path: string, revision: VfsRevision, range?: VfsRange): Uint8Array;
}
/** Whether anything is at `path`. */
export declare function exists(vfs: Pick<VFS, 'stat'>, path: string): Promise<boolean>;
/**
 * At most `length` bytes of `path` from `offset`, for a reader that can bear
 * reading the whole file (cat, a process's descriptor): a filesystem with no
 * ranged read, or one answering ENOTSUP (a namespace does, for a mount whose
 * backend has none), is read whole and cut. Synchronous when `vfs` is.
 */
export declare function readRangeOrWhole(vfs: Pick<SyncVFS, 'readFile' | 'readRange'>, path: string, offset: number, length: number): Uint8Array;
export declare function readRangeOrWhole(vfs: Pick<VFS, 'readFile' | 'readRange'>, path: string, offset: number, length: number): Awaitable<Uint8Array>;
/** The file as UTF-8 text. */
export declare function readText(vfs: Pick<VFS, 'readFile'>, path: string): Promise<string>;
/**
 * Exactly `size` bytes from `source`, in one array. `mismatch` is the error
 * for a source that runs past the size or ends short, given how many bytes it
 * had produced.
 */
export declare function readDeclaredSource(source: AsyncIterable<Uint8Array>, size: number, mismatch: (received: number) => Error): Promise<Uint8Array>;
/** Write `text` as UTF-8. */
export declare function writeText(vfs: VFS, path: string, text: string, options?: {
    mode?: number;
}): Promise<void>;
/** File type bits of a mode (st_mode & S_IFMT). */
export declare const S_IFMT = 61440;
export declare const S_IFREG = 32768;
export declare const S_IFDIR = 16384;
export declare const S_IFCHR = 8192;
export declare const S_IFLNK = 40960;
/**
 * A copy: a tree with \`recursive\` (\`preserve\` is cp -p); \`follow\`
 * copies what a link named as the source leads to, as copyfile does, where
 * a tree copy otherwise copies the link. \`keepMode\`, a file's copy as
 * copyfile makes it (libuv's fchmod): the source's permission bits exactly,
 * a file there too, where cp's are the umask's for a new file and a file
 * there keeps its own.
 */
export interface VfsCopyOptions {
    recursive?: boolean;
    preserve?: boolean;
    follow?: boolean;
    keepMode?: boolean;
}
/**
 * The permission bits a copy without preserve asks to make an entry with:
 * the source's, never its set-user-ID or set-group-ID (cp makes a new file,
 * not the source's owner's); a directory keeps its sticky bit. The
 * filesystem it lands on applies its creation policy (umask, a default ACL,
 * a setgid parent's group) as to any entry made there.
 */
export declare function copiedPermissions(mode: number, directory: boolean): number;
/**
 * The mode copyfile leaves its copy with (keepMode; libuv's fchmod to the
 * source's mode, then the data written): the source's permission bits
 * exactly, but the write of a non-empty copy by a non-root copier clears
 * set-user-ID, and set-group-ID where group-execute is set, as Linux clears
 * them on a write without CAP_FSETID. Whether the copier may set it is
 * chmod's question, asked where the copy lands.
 */
export declare function copyfileMode(mode: number, size: number, uid: number): number;
/** True for a character device such as `/dev/zero`, which streams rather than stores. */
export declare function isCharacterDevice(mode: number | undefined): boolean;
/** The `ls -l` type character for a mode, falling back to the entry's type. */
export declare function fileTypeChar(mode: number | undefined, type: VfsFileType): string;
/** The entry at `path`; ENOENT when nothing is there (for callers that treat absence as an error). */
export declare function statOrThrow<S extends VfsStat>(vfs: {
    stat(path: string, options?: {
        follow?: boolean;
    }): Awaitable<S | null>;
}, path: string, options?: {
    follow?: boolean;
}): Promise<S>;
/** The entry at `path` itself, a link not followed (lstat); ENOENT when nothing is there. */
export declare function lstatOrThrow<S extends VfsStat>(vfs: {
    stat(path: string, options?: {
        follow?: boolean;
    }): Awaitable<S | null>;
}, path: string): Promise<S>;
/** Whether `path` is a directory (links followed). */
export declare function isDirectory(vfs: Pick<VFS, 'stat'>, path: string): Promise<boolean>;
/** Whether `path` is a regular file (links followed). */
export declare function isFile(vfs: Pick<VFS, 'stat'>, path: string): Promise<boolean>;
/** Whether `path` itself is a symbolic link. */
export declare function isSymlink(vfs: Pick<VFS, 'stat'>, path: string): Promise<boolean>;
/** What rm -r of a tree did: maximal removed subtrees, entries still there, and why. */
export interface VfsRemoval {
    removed: string[];
    kept: string[];
    failures: VfsRemovalFailure[];
    /** Entries gone before this walk could remove them; consumers decide whether to diagnose them. */
    vanished?: string[];
}
export interface VfsRemovalFailure {
    path: string;
    error: VfsError;
}
//# sourceMappingURL=vfs.d.ts.map