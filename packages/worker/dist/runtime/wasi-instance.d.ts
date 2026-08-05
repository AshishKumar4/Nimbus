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
 *   - per-file mtime/atime/ctime tracking + in-memory symlink table
 *       (additive — files Map shape unchanged; parallel times/symlinks Maps)
 *   - fd_filestat_set_times / path_filestat_set_times — implementations that
 *       write mtime/atime; honor ATIM_NOW / MTIM_NOW flags via clock_realtime
 *   - path_symlink / path_readlink / path_link. Symlink
 *       resolution via __wasiResolvePathFull(baseFd, path, followFlag)
 *       with POSIX-style 40-deep loop detection (returns ELOOP).
 *   - fd_allocate extends bytes to offset+len and zero-fills.
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
 * Strategy: live VFS, seeded cache. The session VFS (supervisor DO) is the
 * single source of truth. The facet holds a CACHE of it:
 *
 *   - `__wasiInitFS(seed)` installs a metadata manifest (dirs, modes, sizes,
 *     times, symlinks) plus optional file content. Content the seed did not
 *     carry is listed in `sizes` and demand-loaded through the SUPERVISOR
 *     binding (`fsReadRange`, 64 KiB chunks) on first read — a seed miss is
 *     a cache miss, never a correctness failure.
 *   - Writes apply to the cache synchronously and enqueue write-through ops
 *     (writeFile / fsWriteRange / unlink / mkdir / rename / …) on a FIFO
 *     persist queue that drains continuously. Callers await
 *     `__wasiDrainPersist()` before returning a result and at every resident
 *     park, so a server's writes are durable while it runs — there is no
 *     flush-on-exit and no diff-back.
 *   - Any live read (content fetch, stat miss, readdir refresh) first drains
 *     the queue, so the supervisor's answer always includes this process's
 *     own writes.
 *   - A metadata miss with a supervisor present goes to a live `stat` before
 *     reporting ENOENT, so files created after spawn are visible.
 *
 * Seeds are validated supervisor-side by the per-subtree VFS revision
 * (runners rebuild the seed when the revision moved), so a served seed is
 * never stale. Without a supervisor binding the seed is authoritative and
 * behavior degrades to the closed-world snapshot semantics unit tests use.
 *
 * Blocking discipline: file/stdio ops that can be answered from the cache
 * return a plain errno number (JSPI passes it through with no suspender, so
 * sync callers — ruby _initialize, opentui render — are unaffected). Ops
 * that need the supervisor return a Promise which the Suspending wrapper
 * parks the guest on; the guest must run under WebAssembly.promising.
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
/**
 * Source string injected as the loader-pool `preamble`. The facet's
 * module init evaluates this verbatim so the WASI helpers (`__wasiInitFS`,
 * `__wasiMakeImports`, `__wasiRunStart`, `__wasiReadFilesB64`) are in scope
 * when the user fn runs. Self-contained — no closure captures, no imports.
 *
 * The wasi-threads scheduler is appended rather than inlined: it is one
 * evaluated scope with the syscall layer (it has to be — threads syscall
 * through these very imports), but it is a separate concern and lives in its
 * own file.
 */
export declare const WASI_INSTANCE_PREAMBLE_SRC: string;
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
export declare const WASI_ABI_NAMESPACE: Readonly<Record<WasiAbi, string>>;
export interface WasiFsSnapshot {
    /** Canonical VFS root (no leading slash). E.g. `home/user/wasi-files`. */
    root: string;
    /** Canonical VFS roots covered by this snapshot. Defaults to `[root]`. */
    roots?: string[];
    /** Preopen list (order matters; preopens are assigned to fd 3, 4, …). */
    preopens: Array<{
        wasiPath: string;
        vfsPath: string;
    }>;
    /** vfsPath → base64-encoded content. Empty if a fresh file. */
    files: Record<string, string>;
    /** Initial directory list (vfsPaths). */
    dirs: string[];
    /**
     * vfsPath → size for files the manifest knows but whose bytes were not
     * seeded. First read demand-loads them through the supervisor. A seed that
     * lists a file here instead of in `files` trades one round trip on first
     * access for not shipping bytes the process may never open.
     */
    sizes?: Record<string, number>;
    /**
     * Files at or above this many bytes are never held resident; reads window
     * through the supervisor instead. Defaults to 8 MiB.
     */
    residentFileCap?: number;
    /**
     * Roots this seed listed COMPLETELY. Only a producer that walked the subtree
     * with no exclusions may claim one: inside a claimed root an unlisted path
     * is treated as genuinely absent and answered without a round trip.
     */
    enumeratedRoots?: string[];
    /** Supervisor VFS revision the seed was built against (see fsRevision). */
    revision?: number;
    /** Effective read/write/execute bits for the invoking process, keyed by vfsPath. */
    modes: Record<string, number>;
    /**
     * WASI socket and polling support B1: per-path nanosecond timestamps. Values are decimal strings
     * (JSON.stringify-safe; BigInt would throw). Optional — omitted paths
     * default to wall-clock-now at init time.
     */
    times?: Record<string, {
        mtime: string;
        atime: string;
        ctime: string;
    }>;
    /**
     * WASI socket and polling support B3: initial symlink table. `vfsPath → targetPath`. Target is
     * stored verbatim per POSIX (resolution at lookup time).
     */
    symlinks?: Record<string, string>;
}
/**
 * Names of the WASI imports implemented by this shim.
 *
 * `wasm-runner --help` prints this to users, so under-reporting sends a caller
 * away from a syscall that is right there. The shim is a source string the
 * Worker cannot eval at runtime, so the list is written by hand and
 * `tests/unit/wasi-implemented-fns.mjs` holds it to what the shim actually
 * exports.
 */
export declare const WASI_IMPLEMENTED_FNS: readonly string[];
//# sourceMappingURL=wasi-instance.d.ts.map