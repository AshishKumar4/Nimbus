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
import { type VfsError } from './vfs-error.js';
export type Awaitable<T> = T | Promise<T>;
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
export interface VfsOpenFlags {
    read?: boolean;
    write?: boolean;
    append?: boolean;
    create?: boolean;
    exclusive?: boolean;
    truncate?: boolean;
    directory?: boolean;
    follow?: boolean;
}
/** An open file on a backend with real handles: it stays readable after its name is unlinked. */
export interface VfsHandle {
    read(position: number, length: number): Awaitable<Uint8Array>;
    write(position: number, bytes: Uint8Array): Awaitable<number>;
    stat(): Awaitable<VfsStat>;
    truncate(size: number): Awaitable<void>;
    close(): Awaitable<void>;
}
export interface VfsEvent {
    type: 'create' | 'modify' | 'delete' | 'rename';
    path: string;
    oldPath?: string;
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
    readonly type: VfsEvent['type'];
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
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Awaitable<void>;
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
    /** rm -r; nothing returned means the whole operand went. */
    removeRecursive?(path: string): Awaitable<VfsRemoval | void>;
    symlink?(target: string, path: string): Awaitable<void>;
    readlink?(path: string): Awaitable<string>;
    chmod?(path: string, mode: number): Awaitable<void>;
    chown?(path: string, uid: number, gid: number): Awaitable<void>;
    utimes?(path: string, atimeMs: number, mtimeMs: number): Awaitable<void>;
    /** Copy within this backend (SQLite copies rows, not bytes). Returns entries copied. */
    copy?(from: string, to: string, options?: {
        recursive?: boolean;
        preserve?: boolean;
    }): Awaitable<number>;
    /** Compare-and-write. Never emulated with read, compare, write. */
    writeFileIfRevision?(path: string, data: Uint8Array, expected: VfsRevision): Awaitable<VfsCasResult>;
    /** Exactly that version, or a refusal; never the current file in its place. */
    readFileAtRevision?(path: string, revision: VfsRevision, range?: VfsRange): Awaitable<Uint8Array>;
    open?(path: string, flags: VfsOpenFlags): Awaitable<VfsHandle>;
    /** This backend as another principal (`actor` names it finer than its uid). Absent: the backend has one identity. */
    as?(cred: VfsCred, actor?: string): VFS;
    /**
     * Every mutation that lands on this backend, whoever made it, with what
     * it replaced (VfsWriteEvent); the returned function stops the reports.
     */
    observeWrites?(observer: VfsWriteObserver): () => void;
    /** The same operations, completing without waiting. Present only when every call can. */
    readonly sync?: SyncVFS;
    /**
     * What changed since a cursor, and a complete listing: what a cache of
     * this backend (a node process's staged files) is kept coherent with. A
     * backend without it is never cached.
     */
    readonly changes?: VfsChanges;
    watch?(path: string, listener: (event: VfsEvent) => void): () => void;
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
    }): void;
    unlink(path: string): void;
    rmdir?(path: string): void;
    rename?(from: string, to: string): void;
    readRange?(path: string, offset: number, length: number): Uint8Array;
    writeRange?(path: string, offset: number, bytes: Uint8Array): void;
    truncate?(path: string, size: number): void;
    removeRecursive?(path: string): VfsRemoval | void;
    symlink?(target: string, path: string): void;
    readlink?(path: string): string;
    chmod?(path: string, mode: number): void;
    chown?(path: string, uid: number, gid: number): void;
    utimes?(path: string, atimeMs: number, mtimeMs: number): void;
    copy?(from: string, to: string, options?: {
        recursive?: boolean;
        preserve?: boolean;
    }): number;
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
}
export interface VfsRemovalFailure {
    path: string;
    error: VfsError;
}
//# sourceMappingURL=vfs.d.ts.map