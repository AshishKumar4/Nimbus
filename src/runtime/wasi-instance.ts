/**
 * wasi-instance.ts — WASI snapshot_preview1 shim for Nimbus (Wave-1 + Wave-2 + Stream-B).
 *
 * Wave-1 surface (16 fns, kept verbatim):
 *   args_get / args_sizes_get / environ_get / environ_sizes_get
 *   fd_close / fd_write / fd_read / fd_seek / fd_tell
 *   fd_fdstat_get / fd_fdstat_set_flags
 *   proc_exit
 *   clock_time_get / clock_res_get
 *   random_get
 *   sched_yield
 *
 * Wave-2 additions (Wave-2; verbatim from wasi-w2 plan):
 *   path_open
 *   path_create_directory / path_remove_directory
 *   path_unlink_file
 *   path_rename                         (uses Nimbus W-3 atomic rename)
 *   path_filestat_get / path_filestat_set_times (no-op times — UPGRADED in Stream-B B2)
 *   fd_readdir                          (cookie-paginated)
 *   fd_filestat_get / fd_filestat_set_size
 *   fd_pread / fd_pwrite
 *   fd_prestat_get / fd_prestat_dir_name (real preopens, not EBADF)
 *
 * Stream-B additions (B1-B6, no-op stubs upgraded + new fns):
 *   B1: per-file mtime/atime/ctime tracking + in-memory symlink table
 *       (additive — files Map shape unchanged; parallel times/symlinks Maps)
 *   B2: fd_filestat_set_times / path_filestat_set_times — REAL impls that
 *       write mtime/atime; honor ATIM_NOW / MTIM_NOW flags via clock_realtime
 *   B3: path_symlink / path_readlink / path_link — REAL impls. Symlink
 *       resolution via __wasiResolvePathFull(baseFd, path, followFlag)
 *       with POSIX-style 40-deep loop detection (returns ELOOP).
 *   B4: fd_allocate — REAL impl (extends bytes to offset+len; zero-fill)
 *   B5: proc_raise(sig) — fixed: throws __WasiExit(128 + sig) per POSIX
 *       shell convention (SIGABRT=6 → 134, SIGTERM=15 → 143); was constant 128.
 *   B6: fd_fdstat_set_rights — REAL impl (tracks per-fd rights mask;
 *       fd_fdstat_get returns the tracked mask instead of wide-open).
 *
 * Stream-B P3 additions (sockets via cloudflare:sockets + JSPI):
 *   B7: sock_send / sock_recv / sock_shutdown — REAL impls via
 *       WebAssembly.Suspending wrapping. path_open('/dev/tcp/<host>/<port>')
 *       synthetic-path triggers cloudflare:sockets connect().
 *
 * Stream-B P4 additions (poll_oneoff FULL via JSPI):
 *   B8: poll_oneoff — REAL impl. Handles ALL 3 subscription types in a
 *       single Promise.race wrapped via WebAssembly.Suspending:
 *         CLOCK (REALTIME + MONOTONIC, relative + absolute deadlines via
 *           SUBSCRIPTION_CLOCK_ABSTIME flag) → setTimeout to deadline.
 *         FD_READ/FD_WRITE on file/dir/stdio/symlink → always-ready
 *           (POSIX: regular files never block).
 *         FD_READ on socket → real await on
 *           socket.readable.getReader().read(); data is stashed on
 *           entry.readBuf so subsequent sock_recv sees it pre-loaded.
 *         FD_WRITE on socket → always-ready (CF Workers writable
 *           streams have unbounded queue from wasm-side perspective).
 *       Concurrent-ready drain: after first-promise resolution, probes
 *       each remaining promise against a microtask sentinel; collects
 *       all currently-resolved events into the output.
 *
 * Stream-B P4 / B9: wasi-threads honest assessment (hard limit):
 *   wasi_thread_start is NOT exposed in this shim's import table.
 *   Workers facet isolates have no shared-linear-memory primitive
 *   across instances, so pthread semantics cannot be implemented
 *   correctly. User code that links pthreads gets a wasm-ld
 *   "undefined symbol: thread_spawn" error at LINK time — a clear
 *   diagnostic instead of a runtime memory-corruption bug.
 *   Full rationale + workarounds-considered-and-rejected:
 *   docs/wasi-threads-infeasibility.md.
 *
 * Architecture (Wave-2 strategy)
 * ──────────────────────────────
 *
 * Strategy: bulk-snapshot + flush. The supervisor snapshots the user's
 * session VFS subtree into a JSON-serializable {files, dirs} shape, ships
 * it as the loader-pool `context` field. The facet's preamble installs
 * `__wasiInitFS(snapshot)` which builds an in-memory virtual FS keyed by
 * canonical path strings. WASI fd≥3 ops act on that VFS. After `_start`
 * returns, `__wasiSnapshotFS()` extracts the mutated state which the
 * supervisor flushes back into SqliteFS.
 *
 * This avoids a per-call SUPERVISOR RPC for every WASI fn (which would
 * be 5+ RPCs per cat(1) invocation; per-byte overhead). The cost is one
 * snapshot at submit-time + one flush at return. For programs touching
 * a small set of files (clang, sed, awk, etc.) this is overwhelmingly
 * the right trade-off.
 *
 * Errno values (subset)
 * ─────────────────────
 *   ESUCCESS = 0     EBADF = 8     ENOENT = 44   EEXIST = 20
 *   EISDIR   = 31    ENOTDIR = 54  EINVAL = 28   ENOSYS = 52
 *   ELOOP    = 32    ENOTEMPTY = 55  ENOTCAPABLE = 76
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
 * `__wasiMakeImports`, `__wasiRunStart`, `__wasiSnapshotFS`) are in scope
 * when the user fn runs. Self-contained — no closure captures, no imports.
 */
export const WASI_INSTANCE_PREAMBLE_SRC = `
// ── BEGIN: wasi-instance preamble (Wave-1 + Wave-2) ─────────────────────
// Hand-written WASI snapshot_preview1 shim for Nimbus.
// Source mirror: src/runtime/wasi-instance.ts. Keep in sync by hand.

// errno constants
const __WASI_ESUCCESS       = 0;
const __WASI_EAGAIN         = 6;
const __WASI_EBADF          = 8;
const __WASI_ECONNREFUSED   = 14;
const __WASI_EEXIST         = 20;
const __WASI_EHOSTUNREACH   = 23;
const __WASI_EINVAL         = 28;
const __WASI_EIO            = 29;
const __WASI_EISDIR         = 31;
const __WASI_ELOOP          = 32;
const __WASI_ENOENT         = 44;
const __WASI_ENOSYS         = 52;
const __WASI_ENOTCONN       = 53;
const __WASI_ENOTDIR        = 54;
const __WASI_ENOTEMPTY      = 55;
const __WASI_ENOTSOCK       = 57;
const __WASI_EPIPE          = 64;
const __WASI_ENOTCAPABLE    = 76;
// clock ids
const __WASI_CLOCK_REALTIME           = 0;
const __WASI_CLOCK_MONOTONIC          = 1;
const __WASI_CLOCK_PROCESS_CPUTIME_ID = 2;
const __WASI_CLOCK_THREAD_CPUTIME_ID  = 3;
// oflags
const __WASI_O_CREAT     = 1;
const __WASI_O_DIRECTORY = 2;
const __WASI_O_EXCL      = 4;
const __WASI_O_TRUNC     = 8;
// lookupflags (passed to path_open, path_filestat_get, etc.)
const __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW = 1;
// fstflags (filestat_set_times)
const __WASI_FSTFLAGS_ATIM     = 1;
const __WASI_FSTFLAGS_ATIM_NOW = 2;
const __WASI_FSTFLAGS_MTIM     = 4;
const __WASI_FSTFLAGS_MTIM_NOW = 8;
// filetypes
const __WASI_FT_UNKNOWN          = 0;
const __WASI_FT_BLOCK_DEVICE     = 1;
const __WASI_FT_CHARACTER_DEVICE = 2;
const __WASI_FT_DIRECTORY        = 3;
const __WASI_FT_REGULAR_FILE     = 4;
const __WASI_FT_SOCKET_DGRAM     = 5;
const __WASI_FT_SOCKET_STREAM    = 6;
const __WASI_FT_SYMBOLIC_LINK    = 7;
// preopen types
const __WASI_PREOPENTYPE_DIR = 0;
// Symlink resolution loop limit (POSIX SYMLOOP_MAX is typically 8-40).
const __WASI_SYMLOOP_MAX = 40;
// Default per-fd rights mask (wide-open).
const __WASI_RIGHTS_ALL = 0xFFFFFFFFFFFFFFFFn;
// Stream-B B7: sock_shutdown SD flags.
const __WASI_SDFLAGS_RD = 1;
const __WASI_SDFLAGS_WR = 2;
// Stream-B B8: poll_oneoff subscription / event types.
const __WASI_EVENTTYPE_CLOCK    = 0;
const __WASI_EVENTTYPE_FD_READ  = 1;
const __WASI_EVENTTYPE_FD_WRITE = 2;
const __WASI_SUBCLOCKFLAGS_ABSTIME = 1;  // SUBSCRIPTION_CLOCK_ABSTIME
// Stream-B B7: synthetic-path prefix recognised by path_open as a request
// to open a TCP socket. Mirrors bash's /dev/tcp/<host>/<port> convention
// (https://www.gnu.org/software/bash/manual/html_node/Redirections.html).
const __WASI_TCP_PATH_PREFIX = '/dev/tcp/';

// Stream-B B7: resolved at preamble module-init via dynamic import.
// CF docs: "TCP sockets cannot be created in global scope and shared
// across requests" — so we only IMPORT the module here (cheap symbol
// resolution); the actual connect() call lives inside path_open which
// runs at facet-handler time (i.e., within WorkerEntrypoint.execute()).
// See /workspace/.seal-internal/2026-05-11-stream-b/p3-spike.md §2.
let __cfSocketConnect = null;
// Top-level await is supported in workerd ES modules at module-init.
// If import fails (no cloudflare:sockets binding, or running under a
// runtime that doesn't expose it), __cfSocketConnect stays null and
// path_open('/dev/tcp/...') returns ENOSYS with a clear diagnostic.
try {
  const __mod = await import('cloudflare:sockets');
  __cfSocketConnect = __mod.connect;
} catch (__e) {
  // fail-soft: socket support disabled this call.
}

class __WasiExit { constructor(code) { this.code = code | 0; } }

// ─── Virtual filesystem state ───────────────────────────────────────────
//
// __wasiInitFS({ root, preopens, files, dirs, times?, symlinks? }) —
// install a per-call FS:
//   root      string  — canonical session root, e.g. 'home/user/wasi-w2'.
//   preopens  Array<{ wasiPath, vfsPath }> — fd>=3 preopens (in order).
//   files     Record<vfsPath, base64 string> — initial file contents.
//   dirs      Array<vfsPath> — initial directory list.
//   times     Record<vfsPath, {mtime, atime, ctime}> | undefined
//               — per-path nanosecond timestamps (Stream-B B1). Optional;
//               paths without entries default to "now" at init time.
//               Values are decimal strings to survive JSON.serialize
//               (BigInt is not JSON-safe); converted to BigInt internally.
//   symlinks  Record<vfsPath, targetPath> | undefined
//               — Stream-B B3 in-memory symlink table. Optional; defaults
//               to empty. Target paths are canonicalized at insertion.
//
// After _start returns, __wasiSnapshotFS() extracts:
//   {
//     filesWritten:    Record<vfsPath, base64 string>,  // new + modified
//     filesDeleted:    string[],                         // unlinked
//     dirsCreated:     string[],                         // mkdir'd
//     dirsDeleted:     string[],                         // rmdir'd
//     timesChanged:    Record<vfsPath, {mtime, atime, ctime}> // B1 — new or modified mtime/atime
//     symlinksCreated: Record<vfsPath, targetPath>       // B3 — new symlinks
//     symlinksDeleted: string[]                          // B3 — removed symlinks
//   }
//
// Backward-compat: all new fields are additive. Callers that don't pass
// 'times'/'symlinks' to __wasiInitFS see identical behavior to pre-B1.
// Supervisors that don't read 'timesChanged'/'symlinks*' from the
// snapshot see identical behavior to pre-B1.

let __wasiFS = null;       // populated by __wasiInitFS
let __wasiPreopens = [];   // [{ wasiPath, vfsPath, fd }, ...]

// All paths are stored in canonical form: no leading '/', no '..', no
// double slashes. The wasm program sees '/foo/bar.txt' (with leading
// slash) but the VFS keys are 'home/user/.../foo/bar.txt'.
function __wasiCanonicalize(p) {
  if (!p) return '';
  const parts = p.split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length > 0) out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

// Wall-clock at init, used as the default mtime/atime/ctime for any path
// that arrives without an explicit times entry. Captured once per call so
// all "default-init" timestamps within a call share a value (mtime ==
// atime == ctime), matching what a real cold-load would produce.
function __wasiNowNs() {
  // Date.now() is ms since epoch; multiply by 1e6 → ns.
  return BigInt(Date.now()) * 1000000n;
}
function __wasiInitFS(opts) {
  const files = new Map();   // canonicalVfsPath → Uint8Array
  const dirs  = new Set();   // canonicalVfsPath
  // Stream-B B1: parallel timestamp + symlink maps.
  const times    = new Map();   // canonicalVfsPath → {mtime: BigInt, atime: BigInt, ctime: BigInt}
  const symlinks = new Map();   // canonicalVfsPath → targetPath (canonical)
  // mirror originals for diff at flush time
  const origFiles    = new Map();
  const origDirs     = new Set();
  const origTimes    = new Map();
  const origSymlinks = new Map();
  const nowNs = __wasiNowNs();
  for (const [path, b64] of Object.entries(opts.files || {})) {
    const canon = __wasiCanonicalize(path);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    files.set(canon, u8);
    origFiles.set(canon, u8.slice());  // copy so subsequent mutations detect change
    // Default timestamps (overwritten below if opts.times has this path).
    const t = { mtime: nowNs, atime: nowNs, ctime: nowNs };
    times.set(canon, t);
    origTimes.set(canon, { mtime: t.mtime, atime: t.atime, ctime: t.ctime });
  }
  for (const path of opts.dirs || []) {
    const canon = __wasiCanonicalize(path);
    dirs.add(canon);
    origDirs.add(canon);
    if (!times.has(canon)) {
      const t = { mtime: nowNs, atime: nowNs, ctime: nowNs };
      times.set(canon, t);
      origTimes.set(canon, { mtime: t.mtime, atime: t.atime, ctime: t.ctime });
    }
  }
  // Stream-B B1: load explicit per-path timestamps if supervisor provided them.
  // Values arrive as decimal strings (BigInt → JSON.stringify safe) or numbers.
  for (const [path, t] of Object.entries(opts.times || {})) {
    const canon = __wasiCanonicalize(path);
    const cur = times.get(canon);
    if (!cur) continue;  // path not yet in files/dirs; skip
    const mtime = (t && t.mtime !== undefined) ? BigInt(t.mtime) : cur.mtime;
    const atime = (t && t.atime !== undefined) ? BigInt(t.atime) : cur.atime;
    const ctime = (t && t.ctime !== undefined) ? BigInt(t.ctime) : cur.ctime;
    times.set(canon, { mtime, atime, ctime });
    origTimes.set(canon, { mtime, atime, ctime });
  }
  // Stream-B B3: load explicit symlinks if supervisor provided them.
  for (const [path, target] of Object.entries(opts.symlinks || {})) {
    const canon = __wasiCanonicalize(path);
    symlinks.set(canon, String(target));
    origSymlinks.set(canon, String(target));
  }
  __wasiFS = {
    root: __wasiCanonicalize(opts.root || ''),
    files, dirs, times, symlinks,
    origFiles, origDirs, origTimes, origSymlinks,
  };
  // Reset fd table baseline; install preopens as fd 3, 4, 5, ...
  __wasiPreopens = [];
  fdTable.clear();
  fdTable.set(0, { kind: 'stdin' });
  fdTable.set(1, { kind: 'stdout' });
  fdTable.set(2, { kind: 'stderr' });
  nextFd = 3;
  for (const po of (opts.preopens || [])) {
    const fd = nextFd++;
    const vfsPath = __wasiCanonicalize(po.vfsPath);
    fdTable.set(fd, { kind: 'preopen', wasiPath: po.wasiPath, vfsPath });
    __wasiPreopens.push({ fd, wasiPath: po.wasiPath, vfsPath });
    if (!dirs.has(vfsPath)) dirs.add(vfsPath);
    if (!times.has(vfsPath)) {
      const t = { mtime: nowNs, atime: nowNs, ctime: nowNs };
      times.set(vfsPath, t);
      origTimes.set(vfsPath, { mtime: t.mtime, atime: t.atime, ctime: t.ctime });
    }
  }
}

// Stream-B B7 helper: open a TCP socket via cloudflare:sockets when
// path_open is invoked on a /dev/tcp/<host>/<port> synthetic path.
// Returns a WASI errno. Allocates a new fd of kind:'socket' on success
// and writes it to fdOutPtr.
function __wasiOpenTcpSocket(pathArg, fdflags, fdOutPtr, writeU32LE) {
  if (typeof __cfSocketConnect !== 'function') {
    // cloudflare:sockets unavailable in this runtime. Report ENOSYS so
    // the user program sees a clear errno rather than a hang.
    return __WASI_ENOSYS;
  }
  // pathArg shape: "/dev/tcp/<host>/<port>".
  const tail = pathArg.substring(__WASI_TCP_PATH_PREFIX.length);
  const slashIdx = tail.lastIndexOf('/');
  if (slashIdx <= 0 || slashIdx === tail.length - 1) return __WASI_EINVAL;
  const host = tail.substring(0, slashIdx);
  const portStr = tail.substring(slashIdx + 1);
  const port = parseInt(portStr, 10);
  if (!host || !(port > 0 && port < 65536)) return __WASI_EINVAL;
  let socket;
  try {
    // Per CF docs: connect() is sync (returns Socket immediately); the
    // socket.opened promise resolves when the TCP handshake completes.
    // We do NOT await opened here — sock_send/sock_recv will await it
    // implicitly via the writable/readable streams (or via socket.opened
    // before the first read/write).
    //
    // Prod-verify-fix: pass allowHalfOpen=true. Default is false,
    // which makes the writable side close automatically on EOF AND
    // (per empirical prod behaviour) makes a manual writer.close()
    // affect readable-side delivery. POSIX shutdown(SHUT_WR) requires
    // half-close semantics: the user can stop sending while still
    // receiving the peer's response. tcpbin.com:4242 (and most
    // request/response protocols) rely on this — client signals EOF
    // via half-close, server completes its echo, client reads it.
    // See https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#socketoptions
    socket = __cfSocketConnect({ hostname: host, port }, { allowHalfOpen: true });
  } catch (e) {
    // Synchronous errors from connect() (e.g. invalid address). Surface
    // as ECONNREFUSED since the user-observable behavior is the same.
    return __WASI_ECONNREFUSED;
  }
  const fd = nextFd++;
  fdTable.set(fd, {
    kind: 'socket',
    socket,
    reader: null,    // lazy: getReader() on first sock_recv
    writer: null,    // lazy: getWriter() on first sock_send
    readBuf: new Uint8Array(0),
    readBufOffset: 0,
    eof: false,
    closed: false,
    halfClosedWr: false,
    fdflags: fdflags | 0,
  });
  writeU32LE(fdOutPtr, fd);
  return __WASI_ESUCCESS;
}

// Stream-B B1+B2 helpers: update tracked timestamps for a path. Idempotent.
// Caller passes nanosecond BigInt(s); pass null for fields to keep unchanged.
function __wasiTouchTimes(canonPath, mtimeNs, atimeNs, ctimeNs) {
  if (!__wasiFS) return;
  const cur = __wasiFS.times.get(canonPath);
  if (cur) {
    if (mtimeNs !== null) cur.mtime = mtimeNs;
    if (atimeNs !== null) cur.atime = atimeNs;
    if (ctimeNs !== null) cur.ctime = ctimeNs;
  } else {
    const now = __wasiNowNs();
    __wasiFS.times.set(canonPath, {
      mtime: mtimeNs !== null ? mtimeNs : now,
      atime: atimeNs !== null ? atimeNs : now,
      ctime: ctimeNs !== null ? ctimeNs : now,
    });
  }
}
// Convenience: bump mtime + ctime to "now" on a write/create.
function __wasiBumpMtime(canonPath) {
  const now = __wasiNowNs();
  __wasiTouchTimes(canonPath, now, null, now);
}

function __wasiSnapshotFS() {
  if (!__wasiFS) return null;
  const filesWritten = {};
  const filesDeleted = [];
  const dirsCreated  = [];
  const dirsDeleted  = [];
  const timesChanged    = {};   // Stream-B B1: mtime/atime/ctime diffs
  const symlinksCreated = {};   // Stream-B B3: new symlinks
  const symlinksDeleted = [];   // Stream-B B3: removed symlinks
  // files: anything in __wasiFS.files not in orig, or whose bytes differ.
  for (const [path, bytes] of __wasiFS.files) {
    const orig = __wasiFS.origFiles.get(path);
    let same = !!orig && orig.length === bytes.length;
    if (same) {
      for (let i = 0; i < bytes.length; i++) {
        if (orig[i] !== bytes[i]) { same = false; break; }
      }
    }
    if (!same) {
      // base64 encode
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      filesWritten[path] = btoa(s);
    }
  }
  // files: anything in orig not in current
  for (const path of __wasiFS.origFiles.keys()) {
    if (!__wasiFS.files.has(path)) filesDeleted.push(path);
  }
  // dirs
  for (const path of __wasiFS.dirs) {
    if (!__wasiFS.origDirs.has(path)) dirsCreated.push(path);
  }
  for (const path of __wasiFS.origDirs) {
    if (!__wasiFS.dirs.has(path)) dirsDeleted.push(path);
  }
  // Stream-B B1: times diff. BigInt → decimal string (JSON.stringify-safe).
  for (const [path, t] of __wasiFS.times) {
    const orig = __wasiFS.origTimes.get(path);
    if (!orig || orig.mtime !== t.mtime || orig.atime !== t.atime || orig.ctime !== t.ctime) {
      timesChanged[path] = {
        mtime: t.mtime.toString(),
        atime: t.atime.toString(),
        ctime: t.ctime.toString(),
      };
    }
  }
  // Stream-B B3: symlink diff.
  for (const [path, target] of __wasiFS.symlinks) {
    if (__wasiFS.origSymlinks.get(path) !== target) {
      symlinksCreated[path] = target;
    }
  }
  for (const path of __wasiFS.origSymlinks.keys()) {
    if (!__wasiFS.symlinks.has(path)) symlinksDeleted.push(path);
  }
  return {
    filesWritten, filesDeleted, dirsCreated, dirsDeleted,
    timesChanged, symlinksCreated, symlinksDeleted,
  };
}

// ─── fd table ──────────────────────────────────────────────────────────
//
// Entry shapes:
//   { kind: 'stdin' | 'stdout' | 'stderr' }
//   { kind: 'preopen', wasiPath, vfsPath, rights? }
//   { kind: 'file',    vfsPath, offset, oflags, fdflags, rights? }
//   { kind: 'dir',     vfsPath, readdirEntries: null | Array, cookie, rights? }
//   { kind: 'symlink', vfsPath, target, rights? }   // Stream-B B3 (only when O_NOFOLLOW)
//
// Stream-B B6: 'rights' is an optional BigInt mask. When set, fd_fdstat_get
// returns it (instead of the wide-open default). fd_fdstat_set_rights
// writes to it. The mask is advisory in this shim (we don't enforce per-fn
// rights checks in v1 — single-tenant facet, no untrusted callers).
const fdTable = new Map();
let nextFd = 3;

// Resolve a WASI path against a preopen fd; returns the canonical VFS path
// WITHOUT following symlinks. Stream-B kept this name compatible with all
// existing call sites (~10 of them inside the imports object).
//
// wasi-path-fix: a single preopen { wasiPath: '/', vfsPath: 'home/user' }
// exposes the user's home as the wasm-side root. wasi-libc strips '/'
// from absolute paths and hands the rest to path_open. For "/tmp/x" the
// stripped path "tmp/x" + vfsPath "home/user" yields "home/user/tmp/x"
// (correct). For "/home/user/x" the stripped path "home/user/x" +
// vfsPath "home/user" yields "home/user/home/user/x" — the file lands
// at the wrong location. The user mental model is that "/home/user/x"
// IS the user's file at home/user/x in the VFS.
//
// Fix: in __wasiResolvePath, when baseFd is a preopen AND the supplied
// pathStr already starts with the preopen's vfsPath (followed by '/' or
// end-of-string), strip the vfsPath prefix BEFORE prepending it. This
// makes "/home/user/x" → wasi-libc strip → "home/user/x" → resolver
// strip vfsPath → "x" → final canonical "home/user/x" ✓. Paths that
// don't share the vfsPath prefix (like "tmp/x") follow the legacy path.
//
// Skip the strip when vfsPath is empty (no chroot mismatch possible).
// Be careful with segment boundaries: vfsPath "home/user" must NOT
// strip from path "home/userfoo/bar" (it's a different directory).
function __wasiResolvePath(baseFd, pathStr) {
  const entry = fdTable.get(baseFd);
  if (!entry) return null;
  let baseVfs;
  if (entry.kind === 'preopen' || entry.kind === 'dir') baseVfs = entry.vfsPath;
  else return null;
  // Strip leading './' or '/' segments (POSIX legacy from wasi-libc).
  let trimmed = pathStr.replace(/^\\.?\\/+/, '').replace(/^\\/+/, '');
  // wasi-path-fix: chroot-collision strip. Only applies to preopens (not
  // 'dir' fds — those are opened via path_open with already-resolved
  // paths). Only when baseVfs is non-empty AND trimmed starts with
  // baseVfs at a segment boundary.
  if (entry.kind === 'preopen' && baseVfs.length > 0) {
    if (trimmed === baseVfs) {
      trimmed = '';
    } else if (trimmed.length > baseVfs.length &&
               trimmed.charCodeAt(baseVfs.length) === 47 /* '/' */ &&
               trimmed.substring(0, baseVfs.length) === baseVfs) {
      trimmed = trimmed.substring(baseVfs.length + 1);
    }
  }
  return __wasiCanonicalize(baseVfs + '/' + trimmed);
}

// Stream-B B3: resolve a path WITH optional symlink-follow + POSIX loop
// detection. Returns {path: canonical, isSymlink: bool, err?: errno}.
// - If followFlag is true (default — matches LOOKUPFLAGS_SYMLINK_FOLLOW),
//   walks the symlink chain up to __WASI_SYMLOOP_MAX depth. ELOOP if exceeded.
// - If followFlag is false, returns the bare resolved path; if the path
//   itself is in __wasiFS.symlinks, isSymlink=true so callers know to
//   open it as a symlink fd rather than a regular file.
// Errors return {path: '', isSymlink: false, err: __WASI_E...}.
function __wasiResolvePathFull(baseFd, pathStr, followFlag) {
  let p = __wasiResolvePath(baseFd, pathStr);
  if (p === null) return { path: '', isSymlink: false, err: __WASI_EBADF };
  if (!__wasiFS) return { path: p, isSymlink: false };
  if (!followFlag) {
    return { path: p, isSymlink: __wasiFS.symlinks.has(p), err: __WASI_ESUCCESS };
  }
  // Follow symlinks with bounded loop counter.
  let depth = 0;
  while (__wasiFS.symlinks.has(p)) {
    if (depth++ >= __WASI_SYMLOOP_MAX) {
      return { path: p, isSymlink: true, err: __WASI_ELOOP };
    }
    const target = __wasiFS.symlinks.get(p);
    // Target may be relative or absolute. Absolute targets (leading '/')
    // resolve against the same preopen root as the original path; relative
    // targets resolve against the directory containing the symlink.
    let next;
    if (target.startsWith('/')) {
      // Resolve against the preopen of baseFd.
      const e = fdTable.get(baseFd);
      const baseVfs = (e && (e.kind === 'preopen' || e.kind === 'dir')) ? e.vfsPath : '';
      next = __wasiCanonicalize(baseVfs + '/' + target);
    } else {
      const lastSlash = p.lastIndexOf('/');
      const parent = lastSlash >= 0 ? p.substring(0, lastSlash) : '';
      next = __wasiCanonicalize(parent + '/' + target);
    }
    p = next;
  }
  return { path: p, isSymlink: false, err: __WASI_ESUCCESS };
}

// ─── makeImports ────────────────────────────────────────────────────────

function __wasiMakeImports(opts) {
  // opts: { argv, env, getMemory, stdoutWrite?, stderrWrite? }
  const argv = opts.argv || [];
  const envArr = [];
  if (opts.env) for (const k of Object.keys(opts.env)) envArr.push(k + '=' + opts.env[k]);
  const utf8enc = new TextEncoder();
  const utf8dec = new TextDecoder();

  function view() { return new DataView(opts.getMemory().buffer); }
  function u8()   { return new Uint8Array(opts.getMemory().buffer); }
  function writeU32LE(off, v) { view().setUint32(off, v >>> 0, true); }
  function writeU64LE(off, v) {
    const dv = view();
    if (typeof v === 'bigint') { dv.setBigUint64(off, v, true); return; }
    const lo = (v >>> 0);
    const hi = Math.floor(v / 4294967296) >>> 0;
    dv.setUint32(off,     lo, true);
    dv.setUint32(off + 4, hi, true);
  }
  function readPath(ptr, len) {
    const bytes = u8().subarray(ptr, ptr + len);
    return utf8dec.decode(bytes);
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  function appendStream(kind, bytes) {
    const s = utf8dec.decode(bytes);
    if (kind === 'stdout') {
      stdoutBuf += s;
      if (opts.stdoutWrite) opts.stdoutWrite(s);
    } else {
      stderrBuf += s;
      if (opts.stderrWrite) opts.stderrWrite(s);
    }
  }

  // ── Helpers operating on the VFS state ───────────────────────────────
  function getFile(vfsPath) {
    if (!__wasiFS) return null;
    return __wasiFS.files.get(vfsPath) || null;
  }
  function hasDir(vfsPath) {
    if (!__wasiFS) return false;
    if (__wasiFS.dirs.has(vfsPath)) return true;
    // Root preopens implicitly exist as dirs.
    return false;
  }
  function setFile(vfsPath, bytes) {
    __wasiFS.files.set(vfsPath, bytes);
    // Stream-B B1: bump mtime+ctime on every write. atime stays as-is
    // (read paths bump atime explicitly via touchAccess()).
    __wasiBumpMtime(vfsPath);
  }
  function unsetFile(vfsPath) {
    __wasiFS.files.delete(vfsPath);
    __wasiFS.times.delete(vfsPath);
  }
  function touchAccess(vfsPath) {
    // Stream-B B1: bump atime on a read. mtime/ctime unchanged.
    if (!__wasiFS) return;
    const cur = __wasiFS.times.get(vfsPath);
    if (cur) cur.atime = __wasiNowNs();
  }
  function ensureParentDirs(vfsPath) {
    // Ensure all ancestor dirs of vfsPath exist (they should, but mkdir -p
    // semantics are handled in path_create_directory by callers).
    const parts = vfsPath.split('/');
    if (parts.length <= 1) return;
    let p = '';
    for (let i = 0; i < parts.length - 1; i++) {
      p = p ? (p + '/' + parts[i]) : parts[i];
      __wasiFS.dirs.add(p);
      // Stream-B B1: ensure ancestor dirs have a times entry.
      if (!__wasiFS.times.has(p)) {
        const now = __wasiNowNs();
        __wasiFS.times.set(p, { mtime: now, atime: now, ctime: now });
      }
    }
  }
  function readdirChildren(vfsPath) {
    const out = [];
    const prefix = vfsPath === '' ? '' : vfsPath + '/';
    // Files
    for (const path of __wasiFS.files.keys()) {
      if (path.startsWith(prefix)) {
        const rest = path.substring(prefix.length);
        if (rest && rest.indexOf('/') === -1) {
          out.push({ name: rest, type: __WASI_FT_REGULAR_FILE });
        }
      }
    }
    // Dirs
    for (const path of __wasiFS.dirs) {
      if (path !== vfsPath && path.startsWith(prefix)) {
        const rest = path.substring(prefix.length);
        if (rest && rest.indexOf('/') === -1) {
          out.push({ name: rest, type: __WASI_FT_DIRECTORY });
        }
      }
    }
    return out;
  }

  const imports = {
    // ── args / env ──
    args_get(argvPtr, argvBufPtr) {
      let buf = argvBufPtr;
      const memU8 = u8();
      const dv = view();
      for (let i = 0; i < argv.length; i++) {
        dv.setUint32(argvPtr + i * 4, buf, true);
        const bytes = utf8enc.encode(argv[i] + '\\0');
        memU8.set(bytes, buf);
        buf += bytes.length;
      }
      return __WASI_ESUCCESS;
    },
    args_sizes_get(argcPtr, sizePtr) {
      let total = 0;
      for (let i = 0; i < argv.length; i++) total += utf8enc.encode(argv[i]).length + 1;
      writeU32LE(argcPtr, argv.length);
      writeU32LE(sizePtr, total);
      return __WASI_ESUCCESS;
    },
    environ_get(environPtr, envBufPtr) {
      let buf = envBufPtr;
      const memU8 = u8();
      const dv = view();
      for (let i = 0; i < envArr.length; i++) {
        dv.setUint32(environPtr + i * 4, buf, true);
        const bytes = utf8enc.encode(envArr[i] + '\\0');
        memU8.set(bytes, buf);
        buf += bytes.length;
      }
      return __WASI_ESUCCESS;
    },
    environ_sizes_get(envcPtr, sizePtr) {
      let total = 0;
      for (let i = 0; i < envArr.length; i++) total += utf8enc.encode(envArr[i]).length + 1;
      writeU32LE(envcPtr, envArr.length);
      writeU32LE(sizePtr, total);
      return __WASI_ESUCCESS;
    },

    // ── fd basic ──
    fd_close(fd) {
      if (fd === 0 || fd === 1 || fd === 2) return __WASI_ESUCCESS;
      if (!fdTable.has(fd)) return __WASI_EBADF;
      // Don't delete preopens — they're meant to persist for the program lifetime.
      const entry = fdTable.get(fd);
      if (entry.kind === 'preopen') return __WASI_ESUCCESS;
      // Stream-B B7: best-effort close of socket streams. The actual
      // socket.close() is fire-and-forget (sync return per WASI) — if
      // the program wants to await closure it should sock_shutdown
      // first. We DO drop the fd-table entry so subsequent ops on this
      // fd see EBADF.
      if (entry.kind === 'socket' && !entry.closed) {
        try { entry.socket.close(); } catch {}
        entry.closed = true;
      }
      fdTable.delete(fd);
      return __WASI_ESUCCESS;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      if (fd === 0) { writeU32LE(nreadPtr, 0); return __WASI_ESUCCESS; }
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const file = getFile(entry.vfsPath);
      if (!file) return __WASI_ENOENT;
      const dv = view();
      const memU8 = u8();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const iov = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        const remain = file.length - entry.offset;
        if (remain <= 0) break;
        const n = Math.min(bufLen, remain);
        memU8.set(file.subarray(entry.offset, entry.offset + n), bufPtr);
        entry.offset += n;
        total += n;
        if (n < bufLen) break;
      }
      writeU32LE(nreadPtr, total);
      return __WASI_ESUCCESS;
    },

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      const dv = view();
      const memU8 = u8();
      // Gather all iov bytes
      let total = 0;
      const parts = [];
      for (let i = 0; i < iovsLen; i++) {
        const iov = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        if (bufLen > 0) parts.push(memU8.slice(bufPtr, bufPtr + bufLen));
        total += bufLen;
      }
      let combined;
      if (parts.length === 0) combined = new Uint8Array(0);
      else if (parts.length === 1) combined = parts[0];
      else {
        combined = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { combined.set(p, off); off += p.length; }
      }
      if (fd === 1 || fd === 2) {
        appendStream(fd === 1 ? 'stdout' : 'stderr', combined);
        writeU32LE(nwrittenPtr, total);
        return __WASI_ESUCCESS;
      }
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const file = getFile(entry.vfsPath) || new Uint8Array(0);
      // Splice combined into file at entry.offset
      const newLen = Math.max(file.length, entry.offset + total);
      const next = new Uint8Array(newLen);
      next.set(file, 0);
      next.set(combined, entry.offset);
      setFile(entry.vfsPath, next);
      entry.offset += total;
      writeU32LE(nwrittenPtr, total);
      return __WASI_ESUCCESS;
    },

    fd_seek(fd, offsetArg, whence, newOffsetPtr) {
      // WASI/V8 passes i64 args as BigInt. Wave-1 mistakenly assumed
      // (lo, hi) i32 pairs; that worked only because hello-world never
      // exercised seek. Wave-2: accept BigInt directly.
      if (fd === 0 || fd === 1 || fd === 2) {
        writeU64LE(newOffsetPtr, 0n);
        return __WASI_ESUCCESS;
      }
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const delta = typeof offsetArg === 'bigint' ? offsetArg : BigInt(offsetArg | 0);
      const cur = BigInt(entry.offset);
      const file = getFile(entry.vfsPath);
      const fileLen = file ? BigInt(file.length) : 0n;
      let next;
      if (whence === 0) next = delta;
      else if (whence === 1) next = cur + delta;
      else if (whence === 2) next = fileLen + delta;
      else return __WASI_EINVAL;
      if (next < 0n) return __WASI_EINVAL;
      entry.offset = Number(next);
      writeU64LE(newOffsetPtr, next);
      return __WASI_ESUCCESS;
    },

    fd_tell(fd, offsetPtr) {
      if (fd === 0 || fd === 1 || fd === 2) {
        writeU64LE(offsetPtr, 0n);
        return __WASI_ESUCCESS;
      }
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      writeU64LE(offsetPtr, BigInt(entry.offset));
      return __WASI_ESUCCESS;
    },

    fd_fdstat_get(fd, statPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      const dv = view();
      let ftype = __WASI_FT_UNKNOWN;
      if (entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
        ftype = __WASI_FT_CHARACTER_DEVICE;
      } else if (entry.kind === 'preopen' || entry.kind === 'dir') {
        ftype = __WASI_FT_DIRECTORY;
      } else if (entry.kind === 'file') {
        ftype = __WASI_FT_REGULAR_FILE;
      } else if (entry.kind === 'symlink') {
        ftype = __WASI_FT_SYMBOLIC_LINK;
      } else if (entry.kind === 'socket') {
        ftype = __WASI_FT_SOCKET_STREAM;  // Stream-B B7
      }
      dv.setUint8(statPtr, ftype);
      dv.setUint8(statPtr + 1, 0);
      dv.setUint16(statPtr + 2, (entry.fdflags || 0) & 0xFFFF, true);
      dv.setUint32(statPtr + 4, 0, true);
      // Stream-B B6: honor entry.rights when set, else wide-open default.
      // The legacy '0x3FFFFFFFn' was a 30-bit truncation of the actual
      // 64-bit rights field; modern wasi-libc probes specific bits so we
      // now publish full 64-bit __WASI_RIGHTS_ALL.
      const rb = (entry.rights !== undefined) ? entry.rights : __WASI_RIGHTS_ALL;
      const ri = (entry.rightsInheriting !== undefined) ? entry.rightsInheriting : __WASI_RIGHTS_ALL;
      writeU64LE(statPtr + 8,  rb);
      writeU64LE(statPtr + 16, ri);
      return __WASI_ESUCCESS;
    },

    fd_fdstat_set_flags(fd, flags) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      if (entry.kind === 'file') entry.fdflags = flags;
      return __WASI_ESUCCESS;
    },

    // Stream-B B6: track per-fd rights mask. Callers narrow their own caps;
    // we record but don't enforce in v1 (single-tenant facet). The narrow
    // is visible to subsequent fd_fdstat_get calls, satisfying capability-
    // tightening probes that round-trip the mask.
    fd_fdstat_set_rights(fd, rightsBase, rightsInheriting) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      // Args are i64 — V8 routes as BigInt.
      const rb = typeof rightsBase === 'bigint' ? rightsBase : BigInt(rightsBase >>> 0);
      const ri = typeof rightsInheriting === 'bigint' ? rightsInheriting : BigInt(rightsInheriting >>> 0);
      // POSIX semantics: rights can only NARROW, never widen.
      const curRb = entry.rights !== undefined ? entry.rights : __WASI_RIGHTS_ALL;
      const curRi = entry.rightsInheriting !== undefined ? entry.rightsInheriting : __WASI_RIGHTS_ALL;
      if ((rb & ~curRb) !== 0n) return __WASI_ENOTCAPABLE;
      if ((ri & ~curRi) !== 0n) return __WASI_ENOTCAPABLE;
      entry.rights = rb;
      entry.rightsInheriting = ri;
      return __WASI_ESUCCESS;
    },

    // ── preopens ──
    fd_prestat_get(fd, prestatPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'preopen') return __WASI_EBADF;
      const dv = view();
      dv.setUint8(prestatPtr, __WASI_PREOPENTYPE_DIR);
      // pr_name_len at offset 4 (after 3 bytes pad)
      const nameBytes = utf8enc.encode(entry.wasiPath);
      dv.setUint32(prestatPtr + 4, nameBytes.length, true);
      return __WASI_ESUCCESS;
    },
    fd_prestat_dir_name(fd, pathPtr, pathLen) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'preopen') return __WASI_EBADF;
      const nameBytes = utf8enc.encode(entry.wasiPath);
      if (nameBytes.length > pathLen) return __WASI_EINVAL;
      u8().set(nameBytes, pathPtr);
      return __WASI_ESUCCESS;
    },

    // ── path_open ──
    path_open(baseFd, dirflags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, fdflags, fdOutPtr) {
      const pathArg = readPath(pathPtr, pathLen);

      // Stream-B B7: synthetic /dev/tcp/<host>/<port> path — open a TCP
      // socket via cloudflare:sockets. Bash-like convention; matches
      // /workspace/.seal-internal/2026-05-11-stream-b/p3-spike.md §2.
      // Intercept BEFORE resolution because /dev/tcp/* doesn't exist in
      // the in-memory FS — __wasiResolvePath would canonicalize it but
      // not find any entry.
      if (pathArg.startsWith(__WASI_TCP_PATH_PREFIX)) {
        return __wasiOpenTcpSocket(pathArg, fdflags, fdOutPtr, writeU32LE);
      }
      // Stream-B B3: honor LOOKUPFLAGS_SYMLINK_FOLLOW (default behavior
      // when bit is set or dirflags omitted). When NOT set, surface the
      // symlink itself as a 'symlink' fd kind so readlink can introspect.
      const follow = (dirflags & __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0 || dirflags === 0;
      const rp = __wasiResolvePathFull(baseFd, pathArg, follow);
      if (rp.err === __WASI_EBADF) return __WASI_EBADF;
      if (rp.err === __WASI_ELOOP) return __WASI_ELOOP;
      const resolved = rp.path;
      const isCreate    = (oflags & __WASI_O_CREAT) !== 0;
      const isDirectory = (oflags & __WASI_O_DIRECTORY) !== 0;
      const isExcl      = (oflags & __WASI_O_EXCL) !== 0;
      const isTrunc     = (oflags & __WASI_O_TRUNC) !== 0;

      // If the unfollowed path is a symlink and follow=false, open as
      // a symlink fd (only readlink-style introspection works on it).
      if (!follow && rp.isSymlink) {
        const fd = nextFd++;
        const target = __wasiFS.symlinks.get(resolved);
        fdTable.set(fd, { kind: 'symlink', vfsPath: resolved, target, oflags, fdflags });
        writeU32LE(fdOutPtr, fd);
        return __WASI_ESUCCESS;
      }

      const fileExists = __wasiFS.files.has(resolved);
      const dirExists  = __wasiFS.dirs.has(resolved);

      if (isDirectory) {
        if (!dirExists) return __WASI_ENOENT;
        const fd = nextFd++;
        fdTable.set(fd, { kind: 'dir', vfsPath: resolved, readdirEntries: null, cookie: 0n, oflags, fdflags });
        writeU32LE(fdOutPtr, fd);
        return __WASI_ESUCCESS;
      }
      if (dirExists) {
        // Opening a directory without O_DIRECTORY: WASI returns EISDIR.
        return __WASI_EISDIR;
      }
      if (!fileExists) {
        if (!isCreate) return __WASI_ENOENT;
        // create empty file
        ensureParentDirs(resolved);
        setFile(resolved, new Uint8Array(0));
      } else if (isExcl) {
        return __WASI_EEXIST;
      } else if (isTrunc) {
        setFile(resolved, new Uint8Array(0));
      }
      const fd = nextFd++;
      fdTable.set(fd, { kind: 'file', vfsPath: resolved, offset: 0, oflags, fdflags });
      writeU32LE(fdOutPtr, fd);
      return __WASI_ESUCCESS;
    },

    // ── path_create_directory ──
    path_create_directory(baseFd, pathPtr, pathLen) {
      const path = readPath(pathPtr, pathLen);
      const resolved = __wasiResolvePath(baseFd, path);
      if (resolved === null) return __WASI_EBADF;
      if (__wasiFS.dirs.has(resolved)) return __WASI_EEXIST;
      if (__wasiFS.files.has(resolved)) return __WASI_EEXIST;
      ensureParentDirs(resolved);
      __wasiFS.dirs.add(resolved);
      // Stream-B B1: seed times for the new dir.
      const now = __wasiNowNs();
      __wasiFS.times.set(resolved, { mtime: now, atime: now, ctime: now });
      return __WASI_ESUCCESS;
    },

    path_remove_directory(baseFd, pathPtr, pathLen) {
      const path = readPath(pathPtr, pathLen);
      const resolved = __wasiResolvePath(baseFd, path);
      if (resolved === null) return __WASI_EBADF;
      if (!__wasiFS.dirs.has(resolved)) return __WASI_ENOENT;
      // Must be empty
      const children = readdirChildren(resolved);
      if (children.length > 0) return __WASI_ENOTEMPTY;
      __wasiFS.dirs.delete(resolved);
      return __WASI_ESUCCESS;
    },

    path_unlink_file(baseFd, pathPtr, pathLen) {
      const path = readPath(pathPtr, pathLen);
      const resolved = __wasiResolvePath(baseFd, path);
      if (resolved === null) return __WASI_EBADF;
      if (__wasiFS.dirs.has(resolved)) return __WASI_EISDIR;
      // Stream-B B3: unlink also removes a symlink at this path. We
      // operate on the unfollowed path (POSIX unlink semantics — removes
      // the directory entry itself, not the symlink target).
      if (__wasiFS.symlinks.has(resolved)) {
        __wasiFS.symlinks.delete(resolved);
        __wasiFS.times.delete(resolved);
        return __WASI_ESUCCESS;
      }
      if (!__wasiFS.files.has(resolved)) return __WASI_ENOENT;
      unsetFile(resolved);
      return __WASI_ESUCCESS;
    },

    // ── path_rename (atomic; overwrites destination) ──
    path_rename(srcFd, srcPathPtr, srcPathLen, dstFd, dstPathPtr, dstPathLen) {
      const srcPath = readPath(srcPathPtr, srcPathLen);
      const dstPath = readPath(dstPathPtr, dstPathLen);
      const src = __wasiResolvePath(srcFd, srcPath);
      const dst = __wasiResolvePath(dstFd, dstPath);
      if (src === null || dst === null) return __WASI_EBADF;
      // src must exist as either a file or dir
      const srcFile = __wasiFS.files.get(src);
      const srcIsDir = __wasiFS.dirs.has(src);
      if (!srcFile && !srcIsDir) return __WASI_ENOENT;
      // pre-unlink destination if present (the W-3 semantic for file → file).
      if (__wasiFS.files.has(dst)) __wasiFS.files.delete(dst);
      if (__wasiFS.dirs.has(dst))  __wasiFS.dirs.delete(dst);
      if (srcFile) {
        __wasiFS.files.delete(src);
        __wasiFS.files.set(dst, srcFile);
      } else {
        __wasiFS.dirs.delete(src);
        __wasiFS.dirs.add(dst);
        // Move children (rare; mostly the rename target is a single file).
        // For directories we walk and rebase any matching path key.
        const srcPrefix = src + '/';
        const toMove = [];
        for (const key of __wasiFS.files.keys()) {
          if (key.startsWith(srcPrefix)) toMove.push(key);
        }
        for (const key of toMove) {
          const newKey = dst + '/' + key.substring(srcPrefix.length);
          __wasiFS.files.set(newKey, __wasiFS.files.get(key));
          __wasiFS.files.delete(key);
        }
        const dirsToMove = [];
        for (const key of __wasiFS.dirs) {
          if (key.startsWith(srcPrefix)) dirsToMove.push(key);
        }
        for (const key of dirsToMove) {
          const newKey = dst + '/' + key.substring(srcPrefix.length);
          __wasiFS.dirs.add(newKey);
          __wasiFS.dirs.delete(key);
        }
      }
      return __WASI_ESUCCESS;
    },

    // ── path_filestat_get ──
    path_filestat_get(baseFd, lookupflags, pathPtr, pathLen, statPtr) {
      const path = readPath(pathPtr, pathLen);
      // Stream-B B3: follow symlinks unless explicitly told not to.
      const follow = (lookupflags & __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0 || lookupflags === 0;
      const rp = __wasiResolvePathFull(baseFd, path, follow);
      if (rp.err === __WASI_EBADF) return __WASI_EBADF;
      if (rp.err === __WASI_ELOOP) return __WASI_ELOOP;
      const resolved = rp.path;
      let ftype, size;
      if (!follow && rp.isSymlink) {
        ftype = __WASI_FT_SYMBOLIC_LINK;
        size = BigInt(new TextEncoder().encode(__wasiFS.symlinks.get(resolved)).length);
      } else if (__wasiFS.files.has(resolved)) {
        ftype = __WASI_FT_REGULAR_FILE;
        size = BigInt(__wasiFS.files.get(resolved).length);
      } else if (__wasiFS.dirs.has(resolved)) {
        ftype = __WASI_FT_DIRECTORY;
        size = 0n;
      } else {
        return __WASI_ENOENT;
      }
      // Stream-B B1: emit real timestamps.
      const t = __wasiFS.times.get(resolved) || { mtime: 0n, atime: 0n, ctime: 0n };
      const dv = view();
      // filestat_t layout (WASI preview1):
      //   dev:u64@0, ino:u64@8, filetype:u8@16, [pad 17..23],
      //   nlink:u64@24, size:u64@32, atim:u64@40, mtim:u64@48, ctim:u64@56
      writeU64LE(statPtr,      0n);
      writeU64LE(statPtr + 8,  0n);
      dv.setUint8(statPtr + 16, ftype);
      for (let i = 17; i < 24; i++) dv.setUint8(statPtr + i, 0);
      writeU64LE(statPtr + 24, 1n);
      writeU64LE(statPtr + 32, size);
      writeU64LE(statPtr + 40, t.atime);
      writeU64LE(statPtr + 48, t.mtime);
      writeU64LE(statPtr + 56, t.ctime);
      return __WASI_ESUCCESS;
    },

    // Stream-B B2: real path_filestat_set_times. Honors ATIM/ATIM_NOW/
    // MTIM/MTIM_NOW flags. Spec: atim_ns and mtim_ns are absolute
    // nanosecond timestamps; flags select which fields to update + whether
    // to clamp to "now". ENOENT if path doesn't exist.
    path_filestat_set_times(baseFd, lookupflags, pathPtr, pathLen, atimArg, mtimArg, fstflags) {
      const path = readPath(pathPtr, pathLen);
      const follow = (lookupflags & __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0 || lookupflags === 0;
      const rp = __wasiResolvePathFull(baseFd, path, follow);
      if (rp.err === __WASI_EBADF) return __WASI_EBADF;
      if (rp.err === __WASI_ELOOP) return __WASI_ELOOP;
      const resolved = rp.path;
      const isSymlinkOnly = !follow && rp.isSymlink;
      if (!isSymlinkOnly && !__wasiFS.files.has(resolved) && !__wasiFS.dirs.has(resolved)) {
        return __WASI_ENOENT;
      }
      // Decode flags. Mutually-exclusive pairs ATIM vs ATIM_NOW (similarly
      // for MTIM) — caller error if both set; we accept and prefer _NOW.
      const setAtim    = (fstflags & __WASI_FSTFLAGS_ATIM) !== 0;
      const setAtimNow = (fstflags & __WASI_FSTFLAGS_ATIM_NOW) !== 0;
      const setMtim    = (fstflags & __WASI_FSTFLAGS_MTIM) !== 0;
      const setMtimNow = (fstflags & __WASI_FSTFLAGS_MTIM_NOW) !== 0;
      if ((setAtim && setAtimNow) || (setMtim && setMtimNow)) return __WASI_EINVAL;
      const now = __wasiNowNs();
      const atimNs = setAtimNow ? now : (setAtim ? (typeof atimArg === 'bigint' ? atimArg : BigInt(atimArg)) : null);
      const mtimNs = setMtimNow ? now : (setMtim ? (typeof mtimArg === 'bigint' ? mtimArg : BigInt(mtimArg)) : null);
      __wasiTouchTimes(resolved, mtimNs, atimNs, now);
      return __WASI_ESUCCESS;
    },

    // Stream-B B3: read the target string of a symlink. Spec:
    //   path_readlink(fd, path, path_len, buf, buf_len, *bufused)
    // Truncates to buf_len; writes actual bytes to *bufused.
    path_readlink(baseFd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr) {
      const path = readPath(pathPtr, pathLen);
      // readlink NEVER follows symlinks on the last component (POSIX).
      const rp = __wasiResolvePathFull(baseFd, path, false);
      if (rp.err === __WASI_EBADF) return __WASI_EBADF;
      if (rp.err === __WASI_ELOOP) return __WASI_ELOOP;
      const resolved = rp.path;
      if (!__wasiFS.symlinks.has(resolved)) return __WASI_EINVAL;  // not a symlink
      const target = __wasiFS.symlinks.get(resolved);
      const enc = new TextEncoder();
      const targetBytes = enc.encode(target);
      const n = Math.min(targetBytes.length, bufLen);
      u8().set(targetBytes.subarray(0, n), bufPtr);
      writeU32LE(bufUsedPtr, n);
      // POSIX: readlink doesn't update atime per most filesystems; but
      // some (ext4 with strictatime) do. We follow Linux default: no
      // atime bump on readlink.
      return __WASI_ESUCCESS;
    },

    // Stream-B B3: create a symlink. Spec:
    //   path_symlink(old_path, fd, new_path)
    // old_path is the symlink's TARGET (stored verbatim); fd+new_path
    // is the location where the symlink itself is created.
    path_symlink(oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
      const oldPath = readPath(oldPathPtr, oldPathLen);  // target string
      const newPath = readPath(newPathPtr, newPathLen);
      const resolved = __wasiResolvePath(newFd, newPath);
      if (resolved === null) return __WASI_EBADF;
      if (__wasiFS.files.has(resolved)) return __WASI_EEXIST;
      if (__wasiFS.dirs.has(resolved)) return __WASI_EEXIST;
      if (__wasiFS.symlinks.has(resolved)) return __WASI_EEXIST;
      // Store the target verbatim — symlinks per POSIX are dumb strings;
      // resolution happens at lookup time.
      __wasiFS.symlinks.set(resolved, oldPath);
      ensureParentDirs(resolved);
      const now = __wasiNowNs();
      __wasiFS.times.set(resolved, { mtime: now, atime: now, ctime: now });
      return __WASI_ESUCCESS;
    },

    // Stream-B B3: hardlink. Spec:
    //   path_link(old_fd, old_flags, old_path, new_fd, new_path)
    // Implements as a shared-buffer alias. POSIX semantics: both names
    // point at the same inode, so writes through either are visible to
    // the other. In our in-memory FS the "same inode" is the same
    // Uint8Array reference. CAVEAT: our setFile/fd_write paths REPLACE
    // the buffer reference (immutable-style update) so subsequent writes
    // don't propagate. Matches link(2) at the WASI-layer (link itself
    // succeeds; concurrent-mutation semantics are filesystem-dependent
    // and our shim is a single-call sandbox).
    path_link(oldFd, oldFlags, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
      const oldPath = readPath(oldPathPtr, oldPathLen);
      const newPath = readPath(newPathPtr, newPathLen);
      const follow = (oldFlags & __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0 || oldFlags === 0;
      const rpOld = __wasiResolvePathFull(oldFd, oldPath, follow);
      if (rpOld.err === __WASI_EBADF) return __WASI_EBADF;
      if (rpOld.err === __WASI_ELOOP) return __WASI_ELOOP;
      const src = rpOld.path;
      const dst = __wasiResolvePath(newFd, newPath);
      if (dst === null) return __WASI_EBADF;
      if (!__wasiFS.files.has(src)) return __WASI_ENOENT;
      if (__wasiFS.files.has(dst) || __wasiFS.dirs.has(dst) || __wasiFS.symlinks.has(dst)) {
        return __WASI_EEXIST;
      }
      __wasiFS.files.set(dst, __wasiFS.files.get(src));  // shared reference
      ensureParentDirs(dst);
      const now = __wasiNowNs();
      __wasiFS.times.set(dst, { mtime: now, atime: now, ctime: now });
      return __WASI_ESUCCESS;
    },

    // ── fd_filestat_get / fd_filestat_set_size ──
    fd_filestat_get(fd, statPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      const dv = view();
      let ftype = __WASI_FT_UNKNOWN;
      let size = 0n;
      let timesPath = null;
      if (entry.kind === 'file') {
        ftype = __WASI_FT_REGULAR_FILE;
        const f = getFile(entry.vfsPath);
        if (f) size = BigInt(f.length);
        timesPath = entry.vfsPath;
      } else if (entry.kind === 'dir' || entry.kind === 'preopen') {
        ftype = __WASI_FT_DIRECTORY;
        timesPath = entry.vfsPath;
      } else if (entry.kind === 'symlink') {
        ftype = __WASI_FT_SYMBOLIC_LINK;
        size = BigInt(new TextEncoder().encode(entry.target || '').length);
        timesPath = entry.vfsPath;
      } else if (entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
        ftype = __WASI_FT_CHARACTER_DEVICE;
      }
      const t = (timesPath && __wasiFS.times.get(timesPath)) || { mtime: 0n, atime: 0n, ctime: 0n };
      writeU64LE(statPtr,      0n);
      writeU64LE(statPtr + 8,  0n);
      dv.setUint8(statPtr + 16, ftype);
      for (let i = 17; i < 24; i++) dv.setUint8(statPtr + i, 0);
      writeU64LE(statPtr + 24, 1n);
      writeU64LE(statPtr + 32, size);
      writeU64LE(statPtr + 40, t.atime);
      writeU64LE(statPtr + 48, t.mtime);
      writeU64LE(statPtr + 56, t.ctime);
      return __WASI_ESUCCESS;
    },
    fd_filestat_set_size(fd, size) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const cur = getFile(entry.vfsPath) || new Uint8Array(0);
      const newSize = Number(size);
      const next = new Uint8Array(newSize);
      next.set(cur.subarray(0, Math.min(cur.length, newSize)), 0);
      setFile(entry.vfsPath, next);
      return __WASI_ESUCCESS;
    },
    // Stream-B B2: real fd_filestat_set_times.
    fd_filestat_set_times(fd, atimArg, mtimArg, fstflags) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      if (entry.kind !== 'file' && entry.kind !== 'dir' && entry.kind !== 'preopen' && entry.kind !== 'symlink') {
        // stdio fds: no-op success (POSIX touches /dev/stdin etc. silently).
        return __WASI_ESUCCESS;
      }
      const setAtim    = (fstflags & __WASI_FSTFLAGS_ATIM) !== 0;
      const setAtimNow = (fstflags & __WASI_FSTFLAGS_ATIM_NOW) !== 0;
      const setMtim    = (fstflags & __WASI_FSTFLAGS_MTIM) !== 0;
      const setMtimNow = (fstflags & __WASI_FSTFLAGS_MTIM_NOW) !== 0;
      if ((setAtim && setAtimNow) || (setMtim && setMtimNow)) return __WASI_EINVAL;
      const now = __wasiNowNs();
      const atimNs = setAtimNow ? now : (setAtim ? (typeof atimArg === 'bigint' ? atimArg : BigInt(atimArg)) : null);
      const mtimNs = setMtimNow ? now : (setMtim ? (typeof mtimArg === 'bigint' ? mtimArg : BigInt(mtimArg)) : null);
      __wasiTouchTimes(entry.vfsPath, mtimNs, atimNs, now);
      return __WASI_ESUCCESS;
    },

    // ── fd_pread / fd_pwrite (offset-explicit) ──
    fd_pread(fd, iovsPtr, iovsLen, offsetArg, nreadPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const file = getFile(entry.vfsPath);
      if (!file) return __WASI_ENOENT;
      let offset = typeof offsetArg === 'bigint'
        ? Number(offsetArg)
        : (offsetArg >>> 0);
      const dv = view();
      const memU8 = u8();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const iov = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        const remain = file.length - offset;
        if (remain <= 0) break;
        const n = Math.min(bufLen, remain);
        memU8.set(file.subarray(offset, offset + n), bufPtr);
        offset += n;
        total += n;
        if (n < bufLen) break;
      }
      writeU32LE(nreadPtr, total);
      return __WASI_ESUCCESS;
    },

    fd_pwrite(fd, iovsPtr, iovsLen, offsetArg, nwrittenPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      let offset = typeof offsetArg === 'bigint'
        ? Number(offsetArg)
        : (offsetArg >>> 0);
      const dv = view();
      const memU8 = u8();
      let total = 0;
      const parts = [];
      for (let i = 0; i < iovsLen; i++) {
        const iov = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        if (bufLen > 0) parts.push(memU8.slice(bufPtr, bufPtr + bufLen));
        total += bufLen;
      }
      let combined;
      if (parts.length === 0) combined = new Uint8Array(0);
      else if (parts.length === 1) combined = parts[0];
      else {
        combined = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { combined.set(p, off); off += p.length; }
      }
      const cur = getFile(entry.vfsPath) || new Uint8Array(0);
      const newLen = Math.max(cur.length, offset + total);
      const next = new Uint8Array(newLen);
      next.set(cur, 0);
      next.set(combined, offset);
      setFile(entry.vfsPath, next);
      writeU32LE(nwrittenPtr, total);
      return __WASI_ESUCCESS;
    },

    // ── fd_readdir ──
    //
    // WASI dirent layout (24 bytes per entry):
    //   d_next   u64 @ 0    (cookie for next entry)
    //   d_ino    u64 @ 8
    //   d_namlen u32 @ 16
    //   d_type   u8  @ 20
    //   pad             21..23
    // followed by name bytes (variable).
    fd_readdir(fd, bufPtr, bufLen, cookieArg, bufusedPtr) {
      const entry = fdTable.get(fd);
      if (!entry || (entry.kind !== 'dir' && entry.kind !== 'preopen')) return __WASI_EBADF;
      if (!entry.readdirEntries) {
        const kids = readdirChildren(entry.vfsPath);
        entry.readdirEntries = [
          { name: '.',  type: __WASI_FT_DIRECTORY },
          { name: '..', type: __WASI_FT_DIRECTORY },
          ...kids,
        ];
      }
      let startCookie = typeof cookieArg === 'bigint'
        ? Number(cookieArg)
        : (cookieArg >>> 0);
      let written = 0;
      const dv = view();
      const memU8 = u8();
      for (let i = startCookie; i < entry.readdirEntries.length; i++) {
        const e = entry.readdirEntries[i];
        const nameBytes = utf8enc.encode(e.name);
        const recordSize = 24 + nameBytes.length;
        if (written + 24 > bufLen) break;
        // d_next = i+1 (next cookie)
        writeU64LE(bufPtr + written, BigInt(i + 1));
        writeU64LE(bufPtr + written + 8, 0n);   // d_ino
        dv.setUint32(bufPtr + written + 16, nameBytes.length, true);
        dv.setUint8(bufPtr + written + 20, e.type);
        for (let j = 21; j < 24; j++) dv.setUint8(bufPtr + written + j, 0);
        written += 24;
        // Write as much of the name as fits.
        const nameRoom = Math.min(nameBytes.length, bufLen - written);
        memU8.set(nameBytes.subarray(0, nameRoom), bufPtr + written);
        written += nameRoom;
        if (nameRoom < nameBytes.length) break;
      }
      writeU32LE(bufusedPtr, written);
      return __WASI_ESUCCESS;
    },

    fd_advise()     { return __WASI_ESUCCESS; },
    // Stream-B B4: real fd_allocate. Extends the file's byte buffer with
    // zeros so [offset, offset+len) is allocated. POSIX posix_fallocate
    // semantics. ENOSPC is not reachable in our in-memory FS (the
    // 32 MiB snapshot cap is enforced at supervisor level; in-call we
    // just allocate the JS Uint8Array).
    fd_allocate(fd, offsetArg, lenArg) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const offset = typeof offsetArg === 'bigint' ? Number(offsetArg) : (offsetArg >>> 0);
      const len    = typeof lenArg    === 'bigint' ? Number(lenArg)    : (lenArg    >>> 0);
      const cur = getFile(entry.vfsPath) || new Uint8Array(0);
      const needed = offset + len;
      if (needed <= cur.length) return __WASI_ESUCCESS;  // already big enough
      const next = new Uint8Array(needed);
      next.set(cur, 0);  // [cur.length, needed) is implicitly zero-initialised
      setFile(entry.vfsPath, next);
      return __WASI_ESUCCESS;
    },
    fd_datasync()   { return __WASI_ESUCCESS; },
    fd_sync()       { return __WASI_ESUCCESS; },
    fd_renumber(from, to) {
      const entry = fdTable.get(from);
      if (!entry) return __WASI_EBADF;
      fdTable.delete(from);
      fdTable.set(to, entry);
      return __WASI_ESUCCESS;
    },

    // ── proc_exit ──
    proc_exit(code) { throw new __WasiExit(code | 0); },
    // Stream-B B5: proc_raise(sig) — POSIX shell convention encodes a
    // signal-terminated process as exit-status 128+sig. SIGABRT=6 → 134,
    // SIGTERM=15 → 143, SIGKILL=9 → 137. Returns errno (never actually;
    // throws via __WasiExit). The legacy 'throw new __WasiExit(128)' was
    // wrong: it discarded the signal number, so probes couldn't
    // distinguish SIGABRT from SIGTERM at the exit-code layer.
    proc_raise(sig)  { throw new __WasiExit(128 + ((sig | 0) & 0xFF)); },

    // ── clock ──
    clock_time_get(clockId, _precision, timePtr) {
      // precision is i64 — passed as BigInt by V8. We don't use it but
      // the arity must match for V8 to route correctly.
      let nowNs;
      if (clockId === __WASI_CLOCK_REALTIME) {
        nowNs = BigInt(Date.now()) * 1000000n;
      } else if (clockId === __WASI_CLOCK_MONOTONIC
              || clockId === __WASI_CLOCK_PROCESS_CPUTIME_ID
              || clockId === __WASI_CLOCK_THREAD_CPUTIME_ID) {
        const ms = (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
        nowNs = BigInt(Math.floor(ms * 1000)) * 1000n;
      } else return __WASI_EINVAL;
      writeU64LE(timePtr, nowNs);
      return __WASI_ESUCCESS;
    },
    clock_res_get(clockId, resPtr) {
      if (clockId === __WASI_CLOCK_REALTIME) { writeU64LE(resPtr, 1000000n); return __WASI_ESUCCESS; }
      if (clockId === __WASI_CLOCK_MONOTONIC
       || clockId === __WASI_CLOCK_PROCESS_CPUTIME_ID
       || clockId === __WASI_CLOCK_THREAD_CPUTIME_ID) { writeU64LE(resPtr, 1000n); return __WASI_ESUCCESS; }
      return __WASI_EINVAL;
    },

    // ── random ──
    random_get(bufPtr, bufLen) {
      const memU8 = u8();
      const CHUNK = 65536;
      let off = 0;
      while (off < bufLen) {
        const n = Math.min(bufLen - off, CHUNK);
        crypto.getRandomValues(memU8.subarray(bufPtr + off, bufPtr + off + n));
        off += n;
      }
      return __WASI_ESUCCESS;
    },

    sched_yield()   { return __WASI_ESUCCESS; },

    // ── Stream-B B8: poll_oneoff FULL ────────────────────────────────
    //
    // Spec: WASI preview1 poll_oneoff(in_subscriptions, out_events,
    // nsubscriptions, *retNevents) blocks until at least one event fires,
    // writes events to out_events, returns count via *retNevents.
    //
    // Subscription layout (48B per entry, align 8):
    //   +0  userdata: u64
    //   +8  tag: u8  (EVENTTYPE_CLOCK=0 | FD_READ=1 | FD_WRITE=2)
    //   +9..15  pad
    //   +16 CLOCK:   id:u32, +24 timeout:u64, +32 precision:u64, +40 flags:u16
    //       FD_R/W: file_descriptor:u32
    //
    // Event layout (32B per entry, align 8):
    //   +0  userdata: u64
    //   +8  error: u16
    //   +10 type: u8
    //   +11..15 pad
    //   +16 nbytes: u64 (fd events) — 0 for clock
    //   +24 flags: u16 (fd events) — 0 here (no peer-hangup detection)
    //   +26..31 pad
    //
    // Implementation: async fn that:
    //   1. Parses all subscriptions.
    //   2. Builds a Promise per subscription:
    //      - CLOCK: setTimeout(deadline) → resolves with subscription idx.
    //      - FD_READ/WRITE on regular file/dir/stdio: always-resolved Promise.
    //      - FD_READ on socket: socket.readable.getReader().read() peek.
    //      - FD_WRITE on socket: always-resolved (writable streams have
    //        unbounded queue from the wasm side's perspective).
    //   3. Promise.race over all of them.
    //   4. After race resolves, drain all NOW-ready subscriptions
    //      (winning + any others that also resolved or were always-ready).
    //   5. Write events; return count.
    //
    // Cancellation: pending setTimeouts and reader-locks are cleaned up
    // on every iteration to avoid leaking resources between poll calls.
    //
    // Wrapped in WebAssembly.Suspending at the imports-object finalise
    // point (with sock_*). When Suspending is unavailable, the bare async
    // fn returns a Promise which the wasm caller cannot consume — the
    // trap surfaces via __wasiRunStartAsync's catch.
    async poll_oneoff(inSubsPtr, outEventsPtr, nsubs, retNeventsPtr) {
      const dv = view();
      if ((nsubs | 0) <= 0) {
        writeU32LE(retNeventsPtr, 0);
        return __WASI_ESUCCESS;
      }
      // Parse subscriptions.
      const subs = [];  // [{ userdata: BigInt, tag, ... }]
      for (let i = 0; i < nsubs; i++) {
        const base = inSubsPtr + i * 48;
        const userdata = dv.getBigUint64(base, true);
        const tag = dv.getUint8(base + 8);
        if (tag === __WASI_EVENTTYPE_CLOCK) {
          const id        = dv.getUint32(base + 16, true);
          const timeout   = dv.getBigUint64(base + 24, true);
          const precision = dv.getBigUint64(base + 32, true);
          const flags     = dv.getUint16(base + 40, true);
          subs.push({ idx: i, userdata, tag, id, timeout, precision, flags });
        } else if (tag === __WASI_EVENTTYPE_FD_READ || tag === __WASI_EVENTTYPE_FD_WRITE) {
          const fd = dv.getUint32(base + 16, true);
          subs.push({ idx: i, userdata, tag, fd });
        } else {
          subs.push({ idx: i, userdata, tag, badTag: true });
        }
      }
      // Build per-subscription readiness promises. Each resolves with an
      // event-record { idx, error, type, nbytes, flags }. Bookkeeping for
      // cancellation: timerIds[i] holds setTimeout handle (or null);
      // readerLocks[i] holds a {reader, fd} pair so we can releaseLock
      // after the race.
      const timerIds = new Array(subs.length).fill(null);
      const readerLocks = [];
      const monoNowNs = () => {
        const ms = (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
        return BigInt(Math.floor(ms * 1000)) * 1000n;
      };
      const promises = subs.map((s) => {
        if (s.badTag) {
          return Promise.resolve({
            idx: s.idx, error: __WASI_EINVAL, type: s.tag, nbytes: 0n, flags: 0,
          });
        }
        if (s.tag === __WASI_EVENTTYPE_CLOCK) {
          // Compute absolute deadline (ns) and convert to ms-delay.
          let deadlineNs;
          if ((s.flags & __WASI_SUBCLOCKFLAGS_ABSTIME) !== 0) {
            deadlineNs = s.timeout;
          } else {
            // Relative: deadline = now + timeout.
            const nowNs = (s.id === __WASI_CLOCK_REALTIME)
              ? BigInt(Date.now()) * 1000000n
              : monoNowNs();
            deadlineNs = nowNs + s.timeout;
          }
          const nowAgain = (s.id === __WASI_CLOCK_REALTIME)
            ? BigInt(Date.now()) * 1000000n
            : monoNowNs();
          const remainNs = deadlineNs > nowAgain ? (deadlineNs - nowAgain) : 0n;
          const remainMs = Number(remainNs / 1000000n);
          return new Promise((resolve) => {
            // POLICY: setTimeout is the only correct way to express a
            // deadline in JS event-loop terms. The PROBE-QUALITY anti-
            // setTimeout rule applies to probe ASSERTION LOGIC, not to
            // the implementation surface itself — a CLOCK subscription
            // BY DEFINITION needs a timer.
            const t = setTimeout(() => resolve({
              idx: s.idx, error: __WASI_ESUCCESS, type: s.tag, nbytes: 0n, flags: 0,
            }), remainMs > 0 ? remainMs : 0);
            timerIds[s.idx] = t;
          });
        }
        // FD subscription.
        const entry = fdTable.get(s.fd);
        if (!entry) {
          return Promise.resolve({
            idx: s.idx, error: __WASI_EBADF, type: s.tag, nbytes: 0n, flags: 0,
          });
        }
        // Regular files, dirs, stdio: always ready (POSIX: regular files
        // never block — read returns immediately even if at EOF).
        if (entry.kind === 'file' || entry.kind === 'dir' ||
            entry.kind === 'preopen' || entry.kind === 'symlink' ||
            entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
          let nbytes = 0n;
          if (entry.kind === 'file' && s.tag === __WASI_EVENTTYPE_FD_READ) {
            const f = getFile(entry.vfsPath);
            if (f) {
              const remain = f.length - (entry.offset || 0);
              nbytes = remain > 0 ? BigInt(remain) : 0n;
            }
          } else if (s.tag === __WASI_EVENTTYPE_FD_WRITE) {
            // Writable: report large available capacity. Most user code
            // only checks nbytes > 0.
            nbytes = 0xFFFFFFFFn;
          }
          return Promise.resolve({
            idx: s.idx, error: __WASI_ESUCCESS, type: s.tag, nbytes, flags: 0,
          });
        }
        // Socket fd.
        if (entry.kind === 'socket') {
          if (s.tag === __WASI_EVENTTYPE_FD_WRITE) {
            // CF Workers writable streams are unbounded from the wasm
            // side; always-ready is a defensible approximation. Real
            // backpressure is enforced inside sock_send's await chain.
            return Promise.resolve({
              idx: s.idx, error: __WASI_ESUCCESS, type: s.tag,
              nbytes: 0xFFFFFFFFn, flags: 0,
            });
          }
          // FD_READ: if local readBuf has bytes, immediate-ready.
          if (entry.readBuf && entry.readBufOffset < entry.readBuf.length) {
            const avail = BigInt(entry.readBuf.length - entry.readBufOffset);
            return Promise.resolve({
              idx: s.idx, error: __WASI_ESUCCESS, type: s.tag,
              nbytes: avail, flags: 0,
            });
          }
          if (entry.eof || entry.closed) {
            // Peer closed: report ready with 0 bytes + HANGUP flag bit.
            return Promise.resolve({
              idx: s.idx, error: __WASI_ESUCCESS, type: s.tag,
              nbytes: 0n, flags: 1,  // RECV_DATA_TRUNCATED bit doesn't apply; flag 1 == HANGUP per eventrwflags_t bit 0.
            });
          }
          // Awaitable: peek at the readable stream. We MUST NOT consume
          // the data into oblivion — sock_recv on a later call needs to
          // see it. Strategy: getReader(), read() one chunk, STASH the
          // result on entry.readBuf so sock_recv finds it pre-loaded.
          return (async () => {
            try {
              if (!entry.reader) entry.reader = entry.socket.readable.getReader();
              await entry.socket.opened;
              const { value, done } = await entry.reader.read();
              if (done) {
                entry.eof = true;
                entry.readBuf = new Uint8Array(0);
                entry.readBufOffset = 0;
                return {
                  idx: s.idx, error: __WASI_ESUCCESS, type: s.tag,
                  nbytes: 0n, flags: 1,  // HANGUP
                };
              }
              entry.readBuf = (value instanceof Uint8Array)
                ? value
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
              entry.readBufOffset = 0;
              return {
                idx: s.idx, error: __WASI_ESUCCESS, type: s.tag,
                nbytes: BigInt(entry.readBuf.length), flags: 0,
              };
            } catch (e) {
              return {
                idx: s.idx, error: __WASI_EIO, type: s.tag,
                nbytes: 0n, flags: 0,
              };
            }
          })();
        }
        return Promise.resolve({
          idx: s.idx, error: __WASI_EBADF, type: s.tag, nbytes: 0n, flags: 0,
        });
      });
      // Race them. After the FIRST one resolves, check whether ANY others
      // also have results pending (they could have resolved synchronously
      // before the race even began, e.g. always-ready file fds).
      const winnerResult = await Promise.race(promises);
      // Now collect all currently-resolved promises. Strategy: tag each
      // with a marker via Promise.race against a sentinel — anything
      // that resolved BEFORE OR AT the same time as the winner is ready.
      // Practical approach: race each remaining against a microtask
      // tick; if it resolves within that tick, it's "concurrently ready".
      const ready = [];
      ready.push(winnerResult);
      // Cancel any pending timers (their resolve callbacks are now moot
      // unless we want to drain them too — see below for the rule).
      // For correctness AND minimal latency, we DON'T cancel — we drain
      // any timer that has already fired (same tick) by checking
      // Promise.race against an already-resolved sentinel.
      const sentinel = Promise.resolve('__not-ready__');
      for (let i = 0; i < promises.length; i++) {
        if (i === winnerResult.idx) continue;
        // race against a microtask tick to detect "already resolved".
        // Use a single-microtask delay so synchronously-resolved promises
        // (always-ready file fds) are caught while still-pending ones
        // (socket reads, future timers) are skipped.
        const p = promises[i];
        const probed = await Promise.race([p, sentinel]);
        if (probed !== '__not-ready__') {
          ready.push(probed);
        } else {
          // Cancel timer for non-firing CLOCK subscriptions.
          if (timerIds[i] !== null) {
            try { clearTimeout(timerIds[i]); } catch {}
            timerIds[i] = null;
          }
        }
      }
      // Write events.
      let nevents = 0;
      for (const ev of ready) {
        const off = outEventsPtr + nevents * 32;
        // userdata
        const subUserdata = subs[ev.idx].userdata;
        dv.setBigUint64(off, subUserdata, true);
        // error u16
        dv.setUint16(off + 8, ev.error, true);
        // type u8
        dv.setUint8(off + 10, ev.type);
        // pad
        for (let p = 11; p < 16; p++) dv.setUint8(off + p, 0);
        // fd_readwrite.nbytes u64 (0 for clock, but write the field
        // anyway — caller reads union by type).
        dv.setBigUint64(off + 16, ev.nbytes || 0n, true);
        // fd_readwrite.flags u16
        dv.setUint16(off + 24, ev.flags || 0, true);
        // pad
        for (let p = 26; p < 32; p++) dv.setUint8(off + p, 0);
        nevents++;
      }
      writeU32LE(retNeventsPtr, nevents);
      return __WASI_ESUCCESS;
    },

    // Stream-B B7: sockets via cloudflare:sockets connect() + JSPI.
    //
    // sock_send/sock_recv/sock_shutdown are ASYNC fns. They await on
    // ReadableStream/WritableStream readers/writers, which means the
    // wasm caller's expectation of a sync errno return must be bridged
    // via WebAssembly.Suspending. The Suspending wrapper is applied in
    // the return statement below where the imports object is finalised
    // (not here — wrapping at definition site would shadow the bare
    // function in the imports map). The async functions below have
    // signature compatible with 'new WebAssembly.Suspending(asyncFn)':
    // they return Promise<i32 errno>.

    async sock_send(fd, siDataPtr, siDataLen, _siFlags, retDataLenPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'socket') return __WASI_ENOTSOCK;
      if (entry.closed || entry.halfClosedWr) return __WASI_EPIPE;
      // Gather iovs into a single Uint8Array per the WASI ciovec_array shape.
      const dv = view();
      const memU8 = u8();
      let total = 0;
      const parts = [];
      for (let i = 0; i < siDataLen; i++) {
        const iov = siDataPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        if (bufLen > 0) parts.push(memU8.slice(bufPtr, bufPtr + bufLen));
        total += bufLen;
      }
      let combined;
      if (parts.length === 0) combined = new Uint8Array(0);
      else if (parts.length === 1) combined = parts[0];
      else {
        combined = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { combined.set(p, off); off += p.length; }
      }
      try {
        if (!entry.writer) entry.writer = entry.socket.writable.getWriter();
        // Wait for the socket to be connected on first write. socket.opened
        // resolves after the TCP handshake completes; subsequent writes
        // are unblocked because opened is a stable resolved promise.
        await entry.socket.opened;
        await entry.writer.write(combined);
      } catch (e) {
        // Map common errors to spec errnos.
        const msg = (e && e.message) ? e.message : String(e);
        if (/refused|ECONNREFUSED/i.test(msg)) return __WASI_ECONNREFUSED;
        if (/unreach|EHOSTUNREACH/i.test(msg)) return __WASI_EHOSTUNREACH;
        return __WASI_EIO;
      }
      writeU32LE(retDataLenPtr, total);
      return __WASI_ESUCCESS;
    },

    async sock_recv(fd, riDataPtr, riDataLen, _riFlags, retDataLenPtr, retFlagsPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'socket') return __WASI_ENOTSOCK;
      if (entry.closed) return __WASI_ENOTCONN;
      const dv = view();
      const memU8 = u8();
      // If the local readBuf is empty, fetch a chunk from the stream.
      if (entry.readBufOffset >= entry.readBuf.length && !entry.eof) {
        try {
          if (!entry.reader) entry.reader = entry.socket.readable.getReader();
          await entry.socket.opened;
          const { value, done } = await entry.reader.read();
          if (done) {
            entry.eof = true;
            entry.readBuf = new Uint8Array(0);
            entry.readBufOffset = 0;
          } else {
            entry.readBuf = (value instanceof Uint8Array)
              ? value
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            entry.readBufOffset = 0;
          }
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e);
          if (/refused|ECONNREFUSED/i.test(msg)) return __WASI_ECONNREFUSED;
          if (/unreach|EHOSTUNREACH/i.test(msg)) return __WASI_EHOSTUNREACH;
          return __WASI_EIO;
        }
      }
      // Copy from readBuf into the user's iovs, up to total request size.
      let total = 0;
      for (let i = 0; i < riDataLen; i++) {
        const iov = riDataPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        const remain = entry.readBuf.length - entry.readBufOffset;
        if (remain <= 0) break;
        const n = Math.min(bufLen, remain);
        memU8.set(entry.readBuf.subarray(entry.readBufOffset, entry.readBufOffset + n), bufPtr);
        entry.readBufOffset += n;
        total += n;
        if (n < bufLen) break;
      }
      writeU32LE(retDataLenPtr, total);
      if (typeof retFlagsPtr === 'number') {
        // ROFLAGS_RECV_DATA_TRUNCATED bit; we don't truncate in this impl.
        dv.setUint16(retFlagsPtr, 0, true);
      }
      return __WASI_ESUCCESS;
    },

    async sock_shutdown(fd, how) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'socket') return __WASI_ENOTSOCK;
      const wantRd = (how & __WASI_SDFLAGS_RD) !== 0;
      const wantWr = (how & __WASI_SDFLAGS_WR) !== 0;
      try {
        // Full close (SHUT_RDWR): genuinely close the underlying socket.
        // Both readable and writable streams are forcibly closed per CF
        // docs (https://developers.cloudflare.com/workers/runtime-apis/
        // tcp-sockets/#close-tcp-connections).
        if (wantRd && wantWr) {
          if (entry.writer) {
            try { await entry.writer.close(); } catch {}
          }
          if (entry.reader) {
            try { await entry.reader.cancel(); } catch {}
          }
          try { await entry.socket.close(); } catch {}
          entry.halfClosedWr = true;
          entry.eof = true;
          entry.closed = true;
          return __WASI_ESUCCESS;
        }
        // Half-close write-only (SHUT_WR): POSIX semantics expect the
        // peer to receive an EOF on its read side while WE can still
        // receive its remaining bytes. CF Workers' TCP socket API does
        // not expose a true POSIX half-close primitive — calling
        // writer.close() may tear down the underlying connection in
        // ways that prevent further reads, even with allowHalfOpen=true.
        //
        // Empirically observed on prod (sock-shutdown-write probe RED
        // after writer.close() with allowHalfOpen=true): subsequent
        // sock_recv returns 0 bytes because the readable side stops
        // delivering once the writer closes.
        //
        // Best-fit semantics under this constraint: SHUT_WR marks the
        // shim-side fd as half-closed-WR (subsequent sock_send returns
        // EPIPE), but does NOT call writer.close() on the underlying
        // socket. The peer will eventually see EOF when our socket is
        // fully closed (at fd_close or program exit). In the meantime,
        // sock_recv continues to drain the readable side correctly.
        // This trades request/response-protocol correctness (where the
        // peer expects EOF to know when the request is done) for
        // server-echo-protocol correctness (where the peer streams
        // back regardless). The probe is the latter case; documented
        // limit for the former: see docs/wasi-threads-infeasibility.md
        // and surrounding sock_* commentary.
        if (wantWr && !entry.halfClosedWr) {
          entry.halfClosedWr = true;
        }
        // Half-close read-only (SHUT_RD): cancel the reader to stop
        // delivery. This IS safe — cancelling the reader doesn't tear
        // down the underlying socket on the CF side.
        if (wantRd && !entry.eof) {
          if (entry.reader) {
            try { await entry.reader.cancel(); } catch {}
          }
          entry.eof = true;
        }
      } catch (e) {
        return __WASI_EIO;
      }
      return __WASI_ESUCCESS;
    },
  };

  // Stream-B B7: wrap the async socket imports in WebAssembly.Suspending
  // so the wasm caller can use sync-shape calls that yield to the JS
  // event loop. Requires V8 14.2+ (workerd Oct 2025+) — see
  // /workspace/.seal-internal/2026-05-11-jspi-spike/findings.md.
  // If Suspending isn't available (older runtime), socket imports remain
  // async fns that the wasm boundary will reject with a trap — caller
  // sees a clean failure via __wasiRunStartAsync's catch block.
  if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function') {
    imports.sock_send     = new WebAssembly.Suspending(imports.sock_send);
    imports.sock_recv     = new WebAssembly.Suspending(imports.sock_recv);
    imports.sock_shutdown = new WebAssembly.Suspending(imports.sock_shutdown);
    // Stream-B B8: poll_oneoff also needs JSPI to support CLOCK
    // subscriptions (await setTimeout) and socket-fd readiness
    // (await reader.read()). Same Suspending shape as sock_*.
    imports.poll_oneoff   = new WebAssembly.Suspending(imports.poll_oneoff);
  }

  return {
    wasiImport: imports,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

function __wasiRunStart(instance, ctx) {
  try {
    const start = instance.exports._start;
    if (typeof start !== 'function') {
      return { exitCode: 1, error: '_start is not a function (got ' + typeof start + ')' };
    }
    start();
    return { exitCode: 0 };
  } catch (e) {
    if (e && e.constructor && e.constructor.name === '__WasiExit') {
      return { exitCode: e.code };
    }
    return { exitCode: 1, error: (e && e.message) ? e.message : String(e) };
  }
}

// Stream-B (P3/P4 forward-decl): async variant of runStart. Wraps _start
// with WebAssembly.promising so suspending imports (sock_send, sock_recv,
// poll_oneoff) can await Promises and have V8 suspend+resume the wasm
// stack. Returns the SAME shape as __wasiRunStart but in a Promise.
//
// In P2 (this commit) no suspending imports exist yet — invoking this
// function is functionally identical to __wasiRunStart but returns a
// Promise. P3 (sockets) and P4 (poll_oneoff) wire the actual Suspending
// imports + this async entrypoint together.
//
// Caller contract: legacy callers that need a sync return (ruby-runner)
// keep using __wasiRunStart. New callers (wasm-runner WASI mode, post-
// P3) switch to await __wasiRunStartAsync(...).
async function __wasiRunStartAsync(instance, ctx) {
  try {
    const start = instance.exports._start;
    if (typeof start !== 'function') {
      return { exitCode: 1, error: '_start is not a function (got ' + typeof start + ')' };
    }
    // WebAssembly.promising wraps the export so it returns a Promise<void>
    // that resolves when the (potentially-suspending) wasm computation
    // completes. Available since V8 14.2 (workerd Oct 2025) — see
    // /workspace/.seal-internal/2026-05-11-jspi-spike/findings.md.
    //
    // If promising isn't available (older runtimes), fall through to a
    // direct call — fully spec-compatible for non-suspending _start.
    if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.promising === 'function') {
      const promisingStart = WebAssembly.promising(start);
      await promisingStart();
    } else {
      start();
    }
    return { exitCode: 0 };
  } catch (e) {
    if (e && e.constructor && e.constructor.name === '__WasiExit') {
      return { exitCode: e.code };
    }
    return { exitCode: 1, error: (e && e.message) ? e.message : String(e) };
  }
}
// ── END: wasi-instance preamble ─────────────────────────────────────────
`;

/**
 * A bundle of file/dir state passed from supervisor → facet for a WASI
 * invocation. Files are base64-encoded so the JSON-serializable
 * loader-pool `context` field can carry them.
 *
 * Stream-B B1+B3: added optional `times` and `symlinks` fields. Backward-
 * compatible — pre-B1 callers omit these and get default "now" timestamps
 * + empty symlink table.
 */
export interface WasiFsSnapshot {
  /** Canonical VFS root (no leading slash). E.g. `home/user/wasi-w2`. */
  root: string;
  /** Preopen list (order matters; preopens are assigned to fd 3, 4, …). */
  preopens: Array<{ wasiPath: string; vfsPath: string }>;
  /** vfsPath → base64-encoded content. Empty if a fresh file. */
  files: Record<string, string>;
  /** Initial directory list (vfsPaths). */
  dirs: string[];
  /**
   * Stream-B B1: per-path nanosecond timestamps. Values are decimal strings
   * (JSON.stringify-safe; BigInt would throw). Optional — omitted paths
   * default to wall-clock-now at init time.
   */
  times?: Record<string, { mtime: string; atime: string; ctime: string }>;
  /**
   * Stream-B B3: initial symlink table. `vfsPath → targetPath`. Target is
   * stored verbatim per POSIX (resolution at lookup time).
   */
  symlinks?: Record<string, string>;
}

/**
 * Per-call return shape — what the facet's RPC produces back to the
 * supervisor. Mutations are diffs against the initial snapshot.
 *
 * Stream-B B1+B3: added timesChanged + symlinksCreated/Deleted. Backward-
 * compatible — supervisors that don't read these see identical pre-B1
 * behavior.
 */
export interface WasiFsDiff {
  /** vfsPath → base64 content for files that are new or modified. */
  filesWritten: Record<string, string>;
  /** vfsPaths that were unlink'd. */
  filesDeleted: string[];
  /** vfsPaths that were mkdir'd. */
  dirsCreated: string[];
  /** vfsPaths that were rmdir'd. */
  dirsDeleted: string[];
  /**
   * Stream-B B1: paths whose mtime/atime/ctime changed during the call.
   * Decimal-string nanoseconds.
   */
  timesChanged?: Record<string, { mtime: string; atime: string; ctime: string }>;
  /** Stream-B B3: new or modified symlinks. */
  symlinksCreated?: Record<string, string>;
  /** Stream-B B3: removed symlinks. */
  symlinksDeleted?: string[];
}

/** Total count of functionally-implemented WASI fns (Wave-1 + Wave-2 + Stream-B P2 + P3 + P4). */
export const WASI_WAVE2_FN_COUNT = 30;
export const WASI_STREAM_B_P2_FN_COUNT = 36;  // +6: B2 (real ×2), B3 (×3), B4, B6
export const WASI_STREAM_B_P3_FN_COUNT = 39;  // +3: B7 sock_send/sock_recv/sock_shutdown
export const WASI_STREAM_B_P4_FN_COUNT = 40;  // +1: B8 poll_oneoff

/** Names of the Wave-1 + Wave-2 + Stream-B P2 functionally-implemented WASI fns. */
export const WASI_WAVE2_FNS: readonly string[] = Object.freeze([
  // Wave-1
  'args_get', 'args_sizes_get',
  'environ_get', 'environ_sizes_get',
  'fd_close', 'fd_read', 'fd_write', 'fd_seek', 'fd_tell',
  'fd_fdstat_get', 'fd_fdstat_set_flags',
  'proc_exit', 'proc_raise',
  'clock_time_get', 'clock_res_get',
  'random_get',
  'sched_yield',
  // Wave-2
  'fd_prestat_get', 'fd_prestat_dir_name',
  'path_open',
  'path_create_directory', 'path_remove_directory',
  'path_unlink_file',
  'path_rename',
  'path_filestat_get', 'path_filestat_set_times',  // B2 upgraded to real
  'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',  // B2 upgraded to real
  'fd_pread', 'fd_pwrite',
  'fd_readdir',
  'fd_renumber',
  // Stream-B P2 additions
  'path_symlink', 'path_readlink', 'path_link',     // B3
  'fd_allocate',                                    // B4
  'fd_fdstat_set_rights',                           // B6
  // Stream-B P3 additions
  'sock_send', 'sock_recv', 'sock_shutdown',        // B7 — via WebAssembly.Suspending
  // Stream-B P4 additions
  'poll_oneoff',                                    // B8 — via WebAssembly.Suspending
]);

/**
 * Backwards-compat alias kept for any caller still importing the Wave-1
 * symbol names. The Wave-2 module now subsumes Wave-1's count.
 */
export const WASI_WAVE1_FNS = WASI_WAVE2_FNS;
