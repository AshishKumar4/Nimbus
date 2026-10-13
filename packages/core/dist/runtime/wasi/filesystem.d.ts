import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeFsPath, RuntimeOpenedFile, RuntimeOpenFlags, RuntimeSynchronousFs, RuntimeVfsStat } from '../os-contracts.js';
import type { Errno, NimbusFsImports, WasiImports } from './types.js';
import type { PinnedContent } from './resident-filesystem.js';
/** WASI encoding only. Paths, permissions, inode identity and storage belong to fs. */
export interface AuthorityFd {
    kind: 'authority';
    handle: RuntimeFileHandle;
    type: 'file' | 'directory' | 'symlink';
    rights: bigint;
    rightsInheriting: bigint;
    fdflags: number;
    entries?: {
        name: string;
        type: string;
    }[];
}
/**
 * A read-only open of a regular file, answered from this isolate: the bytes
 * are the file's content at its stat revision, so every read, seek and stat on
 * the descriptor is local.
 */
export interface ResidentFd {
    kind: 'resident';
    /** The file's stat at its open. */
    stat: RuntimeVfsStat;
    bytes: Uint8Array;
    hold: ResidentHold;
    /**
     * Descriptors on this open: dup(2), dup2(2) and a fork's copy share it,
     * and with it its offset (shareResident, closeResident).
     */
    opens: number;
    position: number;
    rights: bigint;
    rightsInheriting: bigint;
    fdflags: number;
}
/**
 * How a resident copy's file is opened again (an open of /dev/fd/N): by the
 * session's O_PATH descriptor of it (AuthorityFilesystemOptions.residentHolds),
 * held while the copy lives; else by the name it was read at, while that
 * name has it, with the filesystem's pin on its bytes when it pinned them
 * (pinContent), given back with the copy.
 */
export type ResidentHold = SessionHold | {
    readonly name: RuntimeFsPath;
    readonly follow: boolean;
    readonly pin?: PinnedContent;
};
/** A session descriptor a copy holds: `key`, the name it was opened by (ResidentHolds.keyOf), where it may be kept once the copy goes. */
export interface SessionHold {
    readonly handle: number;
    readonly key?: string;
}
/** Another descriptor on a resident open, as dup(2) makes one: the same offset, the same hold. */
export declare function shareResident(open: ResidentFd): ResidentFd;
/**
 * One descriptor on a resident open closed. The last gives back its hold:
 * a pin here, and the session descriptor it answers, for the caller to let
 * go (ResidentHolds.letGo), as nothing of the guest's depends on it.
 */
export declare function closeResident(open: ResidentFd): SessionHold | null;
export interface AuthorityPreopen {
    kind: 'preopen';
    vfsPath: string;
    wasiPath: string;
    rights?: bigint;
    rightsInheriting?: bigint;
}
export type FilesystemFd = AuthorityFd | ResidentFd | AuthorityPreopen | {
    kind: 'stdin' | 'stdout' | 'stderr' | 'file' | 'dir' | 'socket' | 'listener' | 'pipe';
};
export type FilesystemImports = Pick<WasiImports, 'path_open' | 'path_filestat_get' | 'fd_filestat_get' | 'fd_read' | 'fd_pread' | 'fd_write' | 'fd_pwrite' | 'fd_close' | 'fd_renumber' | 'fd_seek' | 'fd_tell' | 'fd_fdstat_get' | 'fd_fdstat_set_flags' | 'fd_fdstat_set_rights' | 'fd_filestat_set_size' | 'fd_sync' | 'fd_datasync' | 'fd_allocate' | 'fd_advise' | 'fd_readdir' | 'path_create_directory' | 'path_remove_directory' | 'path_unlink_file' | 'path_rename' | 'path_symlink' | 'path_readlink' | 'path_link' | 'fd_filestat_set_times' | 'path_filestat_set_times'>;
/**
 * Synthetic paths that name a socket rather than a file, and the one place
 * their spelling lives — the codec recognises them to hand them back, the host
 * recognises them to open them, and a second literal would let the two drift.
 *
 * No filesystem holds any of them, so a path_open naming one belongs to the
 * host's own socket bodies.
 */
/** Dial: mirrors bash's /dev/tcp/<host>/<port> redirection convention. */
export declare const WASI_TCP_PATH_PREFIX = "/dev/tcp/";
/**
 * Listen, as a descriptor. Reading it is accept(2): the read suspends until a
 * connection is queued and yields that connection's id, so a server's accept
 * loop is an ordinary blocking read with no cooperative pump behind it.
 */
export declare const WASI_LISTEN_PATH_PREFIX = "/dev/nimbus/listen/";
/**
 * The accept half of the dial: binds a connection the kernel has already
 * accepted to a descriptor. It goes through path_open like the dial half
 * because guests layered over wasi-vfs (ruby.wasm) resolve descriptors through
 * their own fd table, so one handed to them out of band is unusable.
 */
export declare const WASI_ACCEPTED_PATH_PREFIX = "/dev/nimbus/socket/";
/**
 * A refused filesystem call as the guest's errno. The session's refusal of a
 * process it no longer holds (process-table.ts noSuchProcess: it restarted,
 * or ended the process, while the program ran) answers ESRCH and is also
 * handed to `gone`, so the run can end naming it ({@link processGoneMessage}).
 */
export declare function refusalErrno(error: unknown, gone?: (refusal: string) => void): Errno;
/** How a run whose session no longer holds its process ends. */
export declare function processGoneMessage(refusal: string): string;
export declare function after<T, R>(value: Awaitable<T>, next: (value: T) => Awaitable<R>): Awaitable<R>;
/**
 * The session descriptors that hold resident copies (residentHolds), for one
 * filesystem. A hold its copy let go is kept, a few at most, at the name it
 * was opened by: the next copy of the same file there takes it again after
 * a stat, which is all main's copy cost, rather than an open of its own.
 * Past those, and a hold no name keeps, it waits to be closed with the next
 * open (RuntimeOpenFlags.closing), as a close of its own would be a second
 * call to the session.
 */
export declare class ResidentHolds {
    private readonly keep;
    private released;
    private readonly kept;
    constructor(keep?: number);
    /** The name a hold is kept by: what `open` was asked of, followed or not. */
    static keyOf(name: RuntimeFsPath, follow: boolean): string;
    /** `hold`, its copy of the file `stat` describes let go. */
    letGo(hold: SessionHold, stat: {
        readonly dev: number;
        readonly ino: number;
    }): void;
    /** The hold kept at `key`, taken out. */
    takeKept(key: string): {
        readonly handle: number;
        readonly dev: number;
        readonly ino: number;
    } | undefined;
    /** A hold no copy will take again. */
    release(handle: number): void;
    /** The holds the next open closes, handed out once. */
    take(): readonly number[] | undefined;
}
/** A session descriptor nothing of the guest's waits to see closed: closed, a refusal of it dropped. */
export declare function closeUnawaited(fs: RuntimeFsBridge | RuntimeSynchronousFs, handle: number): void;
/**
 * Opens `name` as the file `identity` (dev, ino) is, where the process holds
 * no descriptor of it to reopen by (an open of /dev/fd/N on a copy): ENOENT
 * once the name has another file, or none. `follow`: as the name was first
 * looked up. Never creates one, and empties it only once it is known to be
 * that file.
 */
export declare function openIdentified(fs: RuntimeFsBridge | RuntimeSynchronousFs, name: RuntimeFsPath, follow: boolean, flags: RuntimeOpenFlags, identity: {
    dev: number;
    ino: number;
}): Awaitable<RuntimeOpenedFile>;
export interface AuthorityFilesystemOptions {
    fs(): RuntimeFsBridge | null;
    memory(): WebAssembly.Memory;
    fds: Map<number, FilesystemFd>;
    allocateFd(): number;
    abi?: 'preview0' | 'preview1';
    synchronous: boolean;
    /** The guest's live umask when its process can move it after boot (bash's `umask` builtin). */
    umask?(): number;
    /**
     * The session answered that it holds no such process: it restarted (or
     * ended the process) while the guest ran. The call itself gets ESRCH; the
     * runner names why when the run ends.
     */
    processGone?(refusal: string): void;
    /**
     * Largest regular file a read-only open answers from a resident copy. A
     * guest that reopens the same file for every module (CPython's zipimport,
     * a shell's scripts) then pays one open per open and one read per revision,
     * rather than a round trip per descriptor call. Content is keyed by inode
     * and validated against the stat revision, so a file rewritten by anyone
     * is fetched again on its next open. Zero keeps every open on the authority.
     */
    residentBytes?: number;
    /**
     * Where a resident copy's hold of its file at the session goes when the
     * copy is let go: an O_PATH descriptor (RuntimeOpenFlags.path) its open
     * answers the stat with, so the file itself, renamed or unlinked since, is
     * what /dev/fd/N opens again. Without (a host that cannot hold one, or
     * pins bytes itself), a copy is opened again by the name it was read at,
     * while that name has it.
     */
    residentHolds?: ResidentHolds;
    /**
     * Whether a resident copy outlives its descriptor (default true). A guest
     * whose host process already holds the filesystem's content (a node
     * process's resident view) gains nothing from a second copy per inode and
     * pays for it in heap, so it reads afresh on every open and the copy dies
     * with the descriptor.
     */
    retainResident?: boolean;
    /**
     * Where the resident copies are kept, when the guest's owner outlives one
     * instance and clears them itself (a bash process reused for another fork).
     */
    resident?: Map<string, {
        revision: number;
        bytes: Uint8Array;
    }>;
    /**
     * The Nimbus filesystem extension's table (NimbusFsImports), filled for
     * the descriptors and paths this codec answers. A call on any other
     * descriptor goes to what the table held.
     */
    extension?: Partial<NimbusFsImports>;
    /**
     * A new descriptor, at the next free number, on what the host's own
     * descriptor `fd` holds (a standard stream, a pipe end), as dup(2) makes
     * one; null when that kind cannot be shared (a socket). A path naming a
     * descriptor (descriptorNamed) opens a stream the host holds through this;
     * without it, those paths are the filesystem's.
     */
    duplicate?(fd: number): number | null;
}
/**
 * The descriptor `path` names, as Linux's /dev/fd/N, /proc/self/fd/N and
 * /dev/std{in,out,err} do; null for any other path. No filesystem holds what
 * these name: each is the process's own descriptor. A relative `path` is
 * relative to descriptor `fd` of `fds` (a preopen, or a directory the codec
 * holds), or to `cwd` for AT_FDCWD (-1). Every call that takes a path asks
 * this one question: path_open, path_filestat_get, the extension's path_stat
 * and bash's stat_metadata.
 *
 * Linux's answer to what such a path opens: the file or directory itself
 * is opened again, with the new open's flags (a new description, its own
 * offset, O_TRUNC and O_APPEND honored), even one renamed or unlinked
 * since; a stream or a pipe end is shared. Stat'd, it is that descriptor's
 * stat.
 */
export declare function descriptorNamed(fds: ReadonlyMap<number, FilesystemFd>, fd: number, path: string, cwd?: string): number | null;
/**
 * st_mode of a stat: its type's format bits, and its permission bits, or
 * Node's defaults (0755 for a directory, 0644 otherwise) where the backend
 * keeps none, as a node process's fs.stat reports them.
 */
export declare function statMode(st: Pick<RuntimeVfsStat, 'mode' | 'type'>): number;
/** Installs the same filesystem codec in the generic WASI and Bash fd domains. */
export declare function installAuthorityFilesystem(imports: Partial<FilesystemImports>, options: AuthorityFilesystemOptions): asserts imports is FilesystemImports;
//# sourceMappingURL=filesystem.d.ts.map