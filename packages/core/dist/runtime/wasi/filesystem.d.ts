import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeFsPath, RuntimeVfsStat } from '../os-contracts.js';
import type { Errno, WasiImports } from './types.js';
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
 * the descriptor is local. Nothing on the authority side is held for it.
 */
export interface ResidentFd {
    kind: 'resident';
    stat: RuntimeVfsStat;
    bytes: Uint8Array;
    position: number;
    rights: bigint;
    rightsInheriting: bigint;
    fdflags: number;
}
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
export declare function filesystemErrno(error: unknown): Errno;
export declare function after<T, R>(value: Awaitable<T>, next: (value: T) => Awaitable<R>): Awaitable<R>;
/** A lookup's answer, and whether it came from memory rather than the authority just now. */
export interface HeldLookup {
    stat: RuntimeVfsStat | null;
    held: boolean;
}
/**
 * Lookup answers (a stat, or its absence) a parked WASI guest is given from
 * memory, under the ACQUIRE barrier node facets use for their resident cells.
 *
 * Invariant: an answer is served from memory only when nothing the guest has
 * observed is newer than the barrier it was validated at. So every live
 * answer the guest receives (any authority call but the barrier itself) and
 * every resumption from outside the filesystem ({@link resumed}) leaves the
 * cache unverified, and the next answer from memory first takes the barrier
 * and applies its delta. A run of lookups with nothing live between them, an
 * interpreter re-probing its load path, costs nothing.
 *
 * Absence in a directory that keeps missing is answered from its listing,
 * taken only where it answers exactly as a stat would: the directory is
 * searchable and readable by this credential, and its real path is the one
 * the guest named, so a delta naming a path in it reaches the listing.
 */
export declare class AuthorityLookupCache {
    private readonly answers;
    private readonly listings;
    private readonly misses;
    private entries;
    private cursor;
    private verified;
    private resumptions;
    private window;
    /** The guest observed something the barrier has not covered: take it before the next held answer. */
    resumed(): void;
    /** This process changed a file's bytes or metadata; which names exist is unchanged. */
    touched(): void;
    /** This process changed which names exist, or the view cannot be repaired. */
    forget(): void;
    stat(fs: RuntimeFsBridge, target: RuntimeFsPath, followSymlinks: boolean): Awaitable<HeldLookup>;
    /** Stat live and record it, for a caller about to act on current bytes. */
    fresh(fs: RuntimeFsBridge, target: RuntimeFsPath, followSymlinks: boolean): Awaitable<RuntimeVfsStat | null>;
    private fill;
    private record;
    private verify;
    private apply;
    private list;
}
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
     * Largest regular file a read-only open answers from a resident copy. A
     * guest that reopens the same file for every module (CPython's zipimport,
     * a shell's scripts) then pays one stat per open and one read per revision,
     * rather than a round trip per descriptor call. Content is keyed by inode
     * and validated against the stat revision, so a file rewritten by anyone
     * is fetched again on its next open. Zero keeps every open on the authority.
     */
    residentBytes?: number;
    /** Where lookups are answered between resumptions; see {@link AuthorityLookupCache}. Asynchronous guests only. */
    lookups?: AuthorityLookupCache;
}
/** Installs the same filesystem codec in the generic WASI and Bash fd domains. */
export declare function installAuthorityFilesystem(imports: Partial<FilesystemImports>, options: AuthorityFilesystemOptions): asserts imports is FilesystemImports;
//# sourceMappingURL=filesystem.d.ts.map