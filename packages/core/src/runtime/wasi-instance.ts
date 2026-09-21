/**
 * wasi-instance.ts — WASI snapshot_preview1 shim for Nimbus.
 *
 * Core WASI surface:
 *   args_get / args_sizes_get / environ_get / environ_sizes_get
 *   fd_close / fd_write / fd_read / fd_seek / fd_tell
 *   fd_fdstat_get / fd_fdstat_set_flags
 *   proc_exit
 *   clock_time_get / clock_res_get
 *   random_get
 *   sched_yield
 *
 * Filesystem WASI additions:
 *   path_open
 *   path_create_directory / path_remove_directory
 *   path_unlink_file
 *   path_rename
 *   path_filestat_get / path_filestat_set_times
 *   fd_readdir                          (cookie-paginated)
 *   fd_filestat_get / fd_filestat_set_size
 *   fd_pread / fd_pwrite
 *   fd_prestat_get / fd_prestat_dir_name (real preopens, not EBADF)
 *
 * Socket, polling, and metadata additions:
 *   - fd_filestat_set_times / path_filestat_set_times, path_symlink /
 *       path_readlink / path_link and fd_allocate are answered by the
 *       authority codec (wasi/filesystem.ts): times, symlink resolution and
 *       loop detection are the filesystem's, not this layer's.
 *   - proc_raise(sig) throws __WasiExit(128 + sig) per POSIX shell convention
 *       (SIGABRT=6 -> 134, SIGTERM=15 -> 143).
 *   - fd_fdstat_set_rights tracks per-fd rights mask;
 *       fd_fdstat_get returns the tracked mask instead of wide-open).
 *
 * Socket support via cloudflare:sockets + JSPI:
 *   - sock_send / sock_recv / sock_shutdown via
 *       WebAssembly.Suspending wrapping. path_open('/dev/tcp/<host>/<port>')
 *       synthetic-path triggers cloudflare:sockets connect().
 *
 * Poll support via JSPI:
 *   - poll_oneoff handles all three subscription types in a
 *       single Promise.race wrapped via WebAssembly.Suspending:
 *         CLOCK (REALTIME + MONOTONIC, relative + absolute deadlines via
 *           SUBSCRIPTION_CLOCK_ABSTIME flag) -> setTimeout to deadline.
 *         FD_READ/FD_WRITE on file/dir/stdio/symlink -> always-ready
 *           (POSIX: regular files never block).
 *         FD_READ on socket -> real await on
 *           socket.readable.getReader().read(); data is stashed on
 *           entry.readBuf so subsequent sock_recv sees it pre-loaded.
 *         FD_WRITE on socket -> always-ready (CF Workers writable
 *           streams have unbounded queue from wasm-side perspective).
 *       Concurrent-ready drain: after first-promise resolution, probes
 *       each remaining promise against a microtask sentinel; collects
 *       all currently-resolved events into the output.
 *
 * wasi-threads:
 *   Implemented, in runtime/wasi-threads.ts, whose preamble is appended to
 *   this one — threads syscall through THESE imports, so they share one
 *   evaluated scope. This file's only stake in it is two lines: a park
 *   releases the scheduler token (withParkDeadline) and sched_yield is a
 *   real scheduling point. Correct but never parallel; see
 *   docs/wasi-threads.md.
 *
 * Architecture (filesystem WASI strategy)
 * ──────────────────────────────
 *
 * Strategy: live VFS, no cache. The session VFS (supervisor DO) is the
 * single source of truth and the facet holds none of it:
 *
 *   - `__wasiInitFS({ root, preopens })` installs the descriptor table's
 *     baseline: stdio and the preopen roots. It carries no content.
 *   - `__wasiAdoptSupervisor(stub)` binds the authority. Every file and
 *     directory syscall is answered by the codec in wasi/filesystem.ts
 *     through that stub, reading and writing the same inodes the shell does,
 *     so a write is durable the moment the syscall returns — there is no
 *     persist queue, no flush-on-exit and no diff-back.
 *   - Without a supervisor the guest has stdio, sockets and clocks and no
 *     files: a file syscall answers EBADF.
 *
 * Blocking discipline: stdio and socket ops answer a plain errno number
 * (JSPI passes it through with no suspender). File ops on a `jspi` host
 * return a Promise the Suspending wrapper parks the guest on, so the guest
 * must run under WebAssembly.promising; on a `none` host they are answered
 * by the authority's synchronous view.
 *
 * Errno values (subset)
 * ─────────────────────
 *   ESUCCESS = 0     EBADF = 8     ENOENT = 44   EEXIST = 20
 *   EISDIR   = 31    ENOTDIR = 54  EINVAL = 28   ENOSYS = 52
 *   ELOOP    = 32    ENOTEMPTY = 55  ENOTCAPABLE = 76
 *   ESPIPE   = 70    (stdio is a non-seekable pipe)
 *
 * Clock IDs
 * ─────────
 *   CLOCK_REALTIME = 0  / MONOTONIC = 1  / PROCESS_CPUTIME = 2  / THREAD = 3
 *
 * fstflags (filestat_set_times)
 * ─────────────────────────────
 *   __WASI_FSTFLAGS_ATIM     = 1
 *   __WASI_FSTFLAGS_ATIM_NOW = 2
 *   __WASI_FSTFLAGS_MTIM     = 4
 *   __WASI_FSTFLAGS_MTIM_NOW = 8
 */

import { WASI_INSTANCE_BODY_SRC } from './wasi-instance.generated.js';
import type { WasiImports } from './wasi/types.js';
import { WASI_THREADS_PREAMBLE_SRC } from './wasi-threads.js';

/**
 * Source string injected as the loader-pool `preamble`. The facet's
 * module init evaluates this verbatim so the WASI helpers (`__wasiInitFS`,
 * `__wasiMakeImports`, `__wasiRunStart`, `__wasiAdoptSupervisor`) are in scope
 * when the user fn runs. Self-contained — no closure captures, no imports.
 *
 * The wasi-threads scheduler is appended rather than inlined: it is one
 * evaluated scope with the syscall layer (it has to be — threads syscall
 * through these very imports), but it is a separate concern and lives in its
 * own file.
 */
export const WASI_INSTANCE_PREAMBLE_SRC = WASI_INSTANCE_BODY_SRC + WASI_THREADS_PREAMBLE_SRC;

/**
 * A bundle of file/dir state passed from supervisor → facet for a WASI
 * invocation. Files are base64-encoded for structured-clone transport.
 *
 * WASI socket and polling support B1+B3: added optional `times` and `symlinks` fields.
 * `roots` is additive and lets language runtimes snapshot a cwd plus targeted
 * persistent runtime state without widening every command to the whole home
 * directory. Backward-compatible — callers that omit it use `root` only.
 */
/**
 * The two WASI wire ABIs still in circulation. They share every function name
 * and every signature, differing only in fd_seek's whence constants and the
 * filestat struct layout — so binding the wrong one is silent, not a trap.
 * `preview1` is `wasi_snapshot_preview1`; `preview0` is `wasi_unstable`.
 */
export type WasiAbi = 'preview1' | 'preview0';

export const WASI_ABI_NAMESPACE: Readonly<Record<WasiAbi, string>> = Object.freeze({
  preview1: 'wasi_snapshot_preview1',
  preview0: 'wasi_unstable',
});

/**
 * The filesystem view a runner hands a facet: where its preopens are cut from.
 * There is no content here; every file the guest touches is read from and
 * written to the authority through the supervisor.
 */
export interface WasiFsSnapshot {
  /** Canonical VFS root (no leading slash). E.g. `home/user`. */
  root: string;
  /** Preopen list (order matters; preopens are assigned to fd 3, 4, …). */
  preopens: Array<{ wasiPath: string; vfsPath: string }>;
  /** Largest regular file the codec answers from a resident copy. Defaults to 8 MiB. */
  residentFileCap?: number;
}


/**
 * Names of the WASI imports implemented by this shim.
 *
 * `wasm-runner --help` prints this to users, so under-reporting sends a caller
 * away from a syscall that is right there.
 *
 * The list stays hand-ordered because it is read by people — grouped the way the
 * spec groups them — but it is no longer hand-MAINTAINED. `satisfies` rejects a
 * name the import table does not implement, and `_AllSyscallsListed` below
 * rejects a syscall the table implements that nobody added here. Both directions
 * are compile errors, so the list cannot drift from the table in either one.
 * `tests/unit/wasi-implemented-fns.mjs` remains the runtime half of the check:
 * types cannot see inside the emitted source string.
 */
export const WASI_IMPLEMENTED_FNS = Object.freeze([
  // core WASI
  'args_get', 'args_sizes_get',
  'environ_get', 'environ_sizes_get',
  'fd_close', 'fd_read', 'fd_write', 'fd_seek', 'fd_tell',
  'fd_fdstat_get', 'fd_fdstat_set_flags',
  'proc_exit', 'proc_raise',
  'clock_time_get', 'clock_res_get',
  'random_get',
  'sched_yield',
  // filesystem WASI
  'fd_prestat_get', 'fd_prestat_dir_name',
  'path_open',
  'path_create_directory', 'path_remove_directory',
  'path_unlink_file',
  'path_rename',
  'path_filestat_get', 'path_filestat_set_times',
  'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
  'fd_pread', 'fd_pwrite',
  'fd_readdir',
  'fd_renumber',
  'fd_advise', 'fd_datasync', 'fd_sync',
  // symlinks, rights, sockets, and polling
  'path_symlink', 'path_readlink', 'path_link',
  'fd_allocate',
  'fd_fdstat_set_rights',
  'sock_send', 'sock_recv', 'sock_shutdown', 'sock_accept',
  'poll_oneoff',
] as const satisfies readonly (keyof WasiImports)[]);

/**
 * Fails to compile if the import table gained a syscall that the list above did
 * not. `Exclude` is empty when the two agree, and `AssertNever` only accepts an
 * empty union — so the error names the missing syscall directly. Type-level
 * only: nothing here reaches the emitted bundle.
 */
type AssertNever<T extends never> = T;
type _AllSyscallsListed = AssertNever<
  Exclude<keyof WasiImports, (typeof WASI_IMPLEMENTED_FNS)[number]>
>;
