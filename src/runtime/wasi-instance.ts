/**
 * wasi-instance.ts — minimal WASI snapshot_preview1 shim for Nimbus.
 *
 * Wave-1 surface (~14 fns):
 *   args_get / args_sizes_get / environ_get / environ_sizes_get
 *   fd_close / fd_write / fd_read (fd 0 EOF only) / fd_seek / fd_tell
 *   fd_fdstat_get
 *   proc_exit
 *   clock_time_get / clock_res_get
 *   random_get
 *   sched_yield
 *
 * Wave-1 explicitly DEFERS to Wave-2:
 *   path_*  (path_open / path_filestat_get / path_create_directory / ...)
 *   fd_readdir / fd_filestat_*
 *   fd_pread / fd_pwrite
 *   poll_oneoff
 *   sock_*
 *
 * Architectural notes
 * ───────────────────
 *
 * 1. This module is invoked INSIDE the facet isolate. The wasm-runner
 *    supervisor ships `WASI_INSTANCE_PREAMBLE_SRC` (a string carrying
 *    everything between the BEGIN / END markers below) as the loader
 *    pool's `preamble`. The string installs `makeWasiImports(opts)` in
 *    the facet's module-init scope, and the user fn (also serialised
 *    into the facet body) calls it per-invocation with the per-call
 *    config.
 *
 * 2. We do NOT use this module at request time in the SUPERVISOR. The
 *    supervisor only emits the source string. All execution happens
 *    inside the facet — fd 0/1/2 ops are buffered into per-call
 *    stdout/stderr strings that the supervisor harvests via the
 *    pool's RPC return value, then appends to ProcessLogStore from
 *    OUTSIDE the facet boundary. This avoids needing
 *    SupervisorRPC bindings inside the wasm-runner pool.
 *
 * 3. fd 0/1/2 are NOT real file descriptors at the supervisor's
 *    ProcessLogStore. They are facet-local buffered streams. The
 *    string content returned in `RunWasiResult.stdout / stderr` is
 *    what the supervisor side then appends to ProcessLogStore. This
 *    is the Wave-1 strategy A from the plan §11(a) — no SqliteFS
 *    integration, no per-fd cache spill.
 *
 * 4. proc_exit is implemented via a throw of a tagged `WasiExit`
 *    sentinel object so unwind goes back to `WasiInstance.runStart()`
 *    which catches and converts to `{ exitCode }`. Mirrors how Node's
 *    own node:wasi handles it.
 *
 * Errno values (subset)
 * ─────────────────────
 *   ESUCCESS = 0
 *   EBADF    = 8
 *   EINVAL   = 28
 *   ENOSYS   = 52
 *
 * Conditions
 * ──────────
 *   CLOCK_REALTIME      = 0
 *   CLOCK_MONOTONIC     = 1
 *   CLOCK_PROCESS_CPUTIME_ID = 2
 *   CLOCK_THREAD_CPUTIME_ID  = 3
 */

/**
 * Source string injected as the loader-pool `preamble`. The facet's
 * module init evaluates this verbatim so `makeWasiImports` is in
 * scope when the user fn (also serialised into the facet body) runs.
 *
 * The source MUST be self-contained — no closure captures, no
 * imports. Reference: src/loaders/vendor/serialize.ts.
 */
export const WASI_INSTANCE_PREAMBLE_SRC = `
// ── BEGIN: wasi-instance preamble ───────────────────────────────────────
// Hand-written WASI snapshot_preview1 shim for Nimbus Wave-1.
// Source mirror: src/runtime/wasi-instance.ts (kept in sync by hand).
// DO NOT minify or otherwise mangle — this string is parsed at module
// init time inside a workerd isolate; identifier renames break the
// fd table contract with the user fn.

// errno constants
const __WASI_ESUCCESS = 0;
const __WASI_EBADF    = 8;
const __WASI_EINVAL   = 28;
const __WASI_ENOSYS   = 52;
// clock ids
const __WASI_CLOCK_REALTIME           = 0;
const __WASI_CLOCK_MONOTONIC          = 1;
const __WASI_CLOCK_PROCESS_CPUTIME_ID = 2;
const __WASI_CLOCK_THREAD_CPUTIME_ID  = 3;

class __WasiExit { constructor(code) { this.code = code | 0; } }

function __wasiMakeImports(opts) {
  // opts: { argv: string[], env: Record<string,string>, getMemory: () => WebAssembly.Memory,
  //         stdoutWrite: (s: string) => void, stderrWrite: (s: string) => void }
  const argv = opts.argv || [];
  const envArr = [];
  if (opts.env) {
    for (const k of Object.keys(opts.env)) envArr.push(k + '=' + opts.env[k]);
  }
  const utf8enc = new TextEncoder();
  const utf8dec = new TextDecoder();

  // ── fd table — Wave-1 supports only fd 0/1/2. Other fds → EBADF. ──
  // Each entry: { kind: 'stdin' | 'stdout' | 'stderr', offset, fdflags, rights }
  const fdTable = new Map();
  fdTable.set(0, { kind: 'stdin',  offset: 0, fdflags: 0, rights: 0n });
  fdTable.set(1, { kind: 'stdout', offset: 0, fdflags: 0, rights: 0n });
  fdTable.set(2, { kind: 'stderr', offset: 0, fdflags: 0, rights: 0n });

  // Helpers operating against the wasm memory. getMemory() is called
  // lazily on every access — the Memory object is sometimes resized
  // after instantiate, so we re-read .buffer each time.
  function view() {
    return new DataView(opts.getMemory().buffer);
  }
  function u8() {
    return new Uint8Array(opts.getMemory().buffer);
  }
  function writeU32LE(off, v) { view().setUint32(off, v >>> 0, true); }
  function writeU64LE(off, v) {
    // v may be a bigint (preferred) or a number under 2^53.
    const dv = view();
    if (typeof v === 'bigint') { dv.setBigUint64(off, v, true); return; }
    const lo = (v >>> 0);
    const hi = Math.floor(v / 4294967296) >>> 0;
    dv.setUint32(off,     lo, true);
    dv.setUint32(off + 4, hi, true);
  }
  function readU32LE(off) { return view().getUint32(off, true); }

  // String stdout/stderr buffers — drained when proc_exit fires or when
  // the runner reaches the end of _start. The supervisor side reads
  // these from runStart()'s return value and forwards to ProcessLogStore.
  let stdoutBuf = '';
  let stderrBuf = '';
  function appendStream(streamKind, bytes) {
    const s = utf8dec.decode(bytes);
    if (streamKind === 'stdout') {
      stdoutBuf += s;
      if (opts.stdoutWrite) opts.stdoutWrite(s);
    } else {
      stderrBuf += s;
      if (opts.stderrWrite) opts.stderrWrite(s);
    }
  }

  const imports = {
    // ── args_get(argv: usize, argv_buf: usize) -> errno ──
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

    // ── args_sizes_get(*argc, *argv_buf_size) -> errno ──
    args_sizes_get(argcPtr, argvBufSizePtr) {
      let totalSize = 0;
      for (let i = 0; i < argv.length; i++) {
        totalSize += utf8enc.encode(argv[i]).length + 1;
      }
      writeU32LE(argcPtr, argv.length);
      writeU32LE(argvBufSizePtr, totalSize);
      return __WASI_ESUCCESS;
    },

    // ── environ_get / environ_sizes_get ──
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
    environ_sizes_get(envcPtr, envBufSizePtr) {
      let totalSize = 0;
      for (let i = 0; i < envArr.length; i++) {
        totalSize += utf8enc.encode(envArr[i]).length + 1;
      }
      writeU32LE(envcPtr, envArr.length);
      writeU32LE(envBufSizePtr, totalSize);
      return __WASI_ESUCCESS;
    },

    // ── fd_close ──
    fd_close(fd) {
      if (fd === 0 || fd === 1 || fd === 2) {
        // fd 0/1/2 closes are allowed (no-op semantically — keep entries
        // so post-close writes still error cleanly).
        return __WASI_ESUCCESS;
      }
      if (!fdTable.has(fd)) return __WASI_EBADF;
      fdTable.delete(fd);
      return __WASI_ESUCCESS;
    },

    // ── fd_read(fd, iovs_ptr, iovs_len, *nread) -> errno ──
    // Wave-1: fd 0 returns EOF (nread=0) immediately. Other fds → EBADF.
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      if (fd !== 0) return __WASI_EBADF;
      writeU32LE(nreadPtr, 0); // EOF
      return __WASI_ESUCCESS;
    },

    // ── fd_write(fd, iovs_ptr, iovs_len, *nwritten) -> errno ──
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      if (fd !== 1 && fd !== 2) return __WASI_EBADF;
      const memU8 = u8();
      const dv = view();
      let total = 0;
      const parts = [];
      for (let i = 0; i < iovsLen; i++) {
        const iov = iovsPtr + i * 8;
        const bufPtr = dv.getUint32(iov, true);
        const bufLen = dv.getUint32(iov + 4, true);
        if (bufLen > 0) {
          // memU8.subarray would alias the underlying ArrayBuffer; we
          // copy via slice so subsequent memory growth doesn't shift
          // the decoded bytes underneath us.
          parts.push(memU8.slice(bufPtr, bufPtr + bufLen));
        }
        total += bufLen;
      }
      // Concatenate parts then dispatch as ONE write to the stream
      // (preserves UTF-8 sequences split across iovecs).
      let combined;
      if (parts.length === 0) combined = new Uint8Array(0);
      else if (parts.length === 1) combined = parts[0];
      else {
        combined = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { combined.set(p, off); off += p.length; }
      }
      appendStream(fd === 1 ? 'stdout' : 'stderr', combined);
      writeU32LE(nwrittenPtr, total);
      return __WASI_ESUCCESS;
    },

    // ── fd_seek(fd, offset:i64, whence:u8, *new_offset:i64) ──
    fd_seek(fd, offsetLo, offsetHi, whence, newOffsetPtr) {
      // Wave-1: fd 0/1/2 don't seek. Other fds → EBADF.
      if (fd === 0 || fd === 1 || fd === 2) {
        writeU64LE(newOffsetPtr, 0n);
        return __WASI_ESUCCESS;
      }
      return __WASI_EBADF;
    },

    // ── fd_tell(fd, *offset:i64) ──
    fd_tell(fd, offsetPtr) {
      if (fd === 0 || fd === 1 || fd === 2) {
        writeU64LE(offsetPtr, 0n);
        return __WASI_ESUCCESS;
      }
      return __WASI_EBADF;
    },

    // ── fd_fdstat_get(fd, *fdstat) ──
    // Layout of fdstat (24 bytes):
    //   u8  fs_filetype
    //   u8  pad
    //   u16 fs_flags
    //   u32 pad
    //   u64 fs_rights_base
    //   u64 fs_rights_inheriting
    fd_fdstat_get(fd, statPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      const dv = view();
      // filetype: 2 = character_device (stdin/stdout/stderr)
      dv.setUint8(statPtr, 2);
      dv.setUint8(statPtr + 1, 0);
      dv.setUint16(statPtr + 2, entry.fdflags || 0, true);
      dv.setUint32(statPtr + 4, 0, true);
      // rights: 0 (Wave-1 doesn't track per-fd rights for std streams)
      writeU64LE(statPtr + 8, 0n);
      writeU64LE(statPtr + 16, 0n);
      return __WASI_ESUCCESS;
    },

    fd_fdstat_set_flags(fd, flags) {
      // Wave-1: accept but no-op. clang doesn't currently exercise this
      // before printf; libc fall-through is permissive.
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      entry.fdflags = flags;
      return __WASI_ESUCCESS;
    },

    // ── proc_exit(rval:u32) ──
    proc_exit(code) {
      throw new __WasiExit(code | 0);
    },

    // ── clock_time_get(clock_id, precision:i64, *time:i64) ──
    clock_time_get(clockId, _precLo, _precHi, timePtr) {
      // CLOCK_REALTIME: Date.now() ms → ns
      // CLOCK_MONOTONIC: performance.now() ms → ns
      let nowNs;
      if (clockId === __WASI_CLOCK_REALTIME) {
        nowNs = BigInt(Date.now()) * 1000000n;
      } else if (clockId === __WASI_CLOCK_MONOTONIC) {
        const ms = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        nowNs = BigInt(Math.floor(ms * 1000)) * 1000n;
      } else if (clockId === __WASI_CLOCK_PROCESS_CPUTIME_ID
              || clockId === __WASI_CLOCK_THREAD_CPUTIME_ID) {
        // No CPU-time clock available; approximate with monotonic.
        const ms = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        nowNs = BigInt(Math.floor(ms * 1000)) * 1000n;
      } else {
        return __WASI_EINVAL;
      }
      writeU64LE(timePtr, nowNs);
      return __WASI_ESUCCESS;
    },
    clock_res_get(clockId, resPtr) {
      if (clockId === __WASI_CLOCK_REALTIME) {
        // Date.now() resolution ≈ 1 ms = 1_000_000 ns. Workerd may
        // coarsen for security; clients shouldn't depend on it.
        writeU64LE(resPtr, 1000000n);
        return __WASI_ESUCCESS;
      }
      if (clockId === __WASI_CLOCK_MONOTONIC
       || clockId === __WASI_CLOCK_PROCESS_CPUTIME_ID
       || clockId === __WASI_CLOCK_THREAD_CPUTIME_ID) {
        writeU64LE(resPtr, 1000n);
        return __WASI_ESUCCESS;
      }
      return __WASI_EINVAL;
    },

    // ── random_get(buf, buf_len) ──
    random_get(bufPtr, bufLen) {
      const memU8 = u8();
      // crypto.getRandomValues caps at 64 KiB per call. Loop for larger.
      const CHUNK = 65536;
      let off = 0;
      while (off < bufLen) {
        const n = Math.min(bufLen - off, CHUNK);
        const view = memU8.subarray(bufPtr + off, bufPtr + off + n);
        crypto.getRandomValues(view);
        off += n;
      }
      return __WASI_ESUCCESS;
    },

    // ── sched_yield ──
    sched_yield() {
      return __WASI_ESUCCESS;
    },

    // ── poll_oneoff / sock_* / path_* — DEFERRED to Wave-2 ──
    // Provided as ENOSYS stubs so a stray import doesn't crash
    // instantiate with a missing-import error. The caller's libc
    // typically falls through to its own no-op for these.
    poll_oneoff() { return __WASI_ENOSYS; },
    sock_recv()   { return __WASI_ENOSYS; },
    sock_send()   { return __WASI_ENOSYS; },
    sock_shutdown() { return __WASI_ENOSYS; },

    // path_* — Wave-2. ENOSYS for now so modules importing them
    // can still link; calls just fail at runtime.
    path_open()              { return __WASI_ENOSYS; },
    path_filestat_get()      { return __WASI_ENOSYS; },
    path_create_directory()  { return __WASI_ENOSYS; },
    path_remove_directory()  { return __WASI_ENOSYS; },
    path_unlink_file()       { return __WASI_ENOSYS; },
    path_rename()            { return __WASI_ENOSYS; },
    path_filestat_set_times(){ return __WASI_ENOSYS; },
    path_readlink()          { return __WASI_ENOSYS; },
    path_symlink()           { return __WASI_ENOSYS; },
    path_link()              { return __WASI_ENOSYS; },

    fd_readdir()             { return __WASI_ENOSYS; },
    fd_filestat_get()        { return __WASI_ENOSYS; },
    fd_filestat_set_size()   { return __WASI_ENOSYS; },
    fd_filestat_set_times()  { return __WASI_ENOSYS; },
    fd_pread()               { return __WASI_ENOSYS; },
    fd_pwrite()              { return __WASI_ENOSYS; },
    fd_advise()              { return __WASI_ESUCCESS; },
    fd_allocate()            { return __WASI_ENOSYS; },
    fd_datasync()            { return __WASI_ESUCCESS; },
    fd_sync()                { return __WASI_ESUCCESS; },
    fd_renumber()            { return __WASI_ENOSYS; },
    fd_prestat_get()         { return __WASI_EBADF; },  // tells libc "no preopens"
    fd_prestat_dir_name()    { return __WASI_EBADF; },

    proc_raise(_sig) {
      // Map raise(sig) to exit(128+sig). Matches libc's typical fallthrough.
      throw new __WasiExit(128);
    },
  };

  return {
    wasiImport: imports,
    // The supervisor reads these AFTER runStart returns.
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

// runStart: instantiate + invoke _start, catching __WasiExit. Returns
// the exit code (0 on natural fall-through, N on proc_exit(N)).
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
// ── END: wasi-instance preamble ─────────────────────────────────────────
`;

/**
 * Sanity-checked exit value union; exposed so wasm-runner can type
 * the result it gets back from the facet.
 */
export interface WasiRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the wasm trapped or _start was missing. Empty on clean exit. */
  error?: string;
}

/**
 * Compile-time count of WASI fns implemented in the preamble above.
 * Surfaced for the runtime's `wasm-runner --wasi-info` diagnostic and
 * the cross-wave verification probe. If you add a new fn, bump this.
 *
 * Fn list (Wave-1 implemented, not ENOSYS-stub):
 *   args_get, args_sizes_get,
 *   environ_get, environ_sizes_get,
 *   fd_close, fd_read, fd_write, fd_seek, fd_tell, fd_fdstat_get,
 *   fd_fdstat_set_flags,
 *   proc_exit,
 *   clock_time_get, clock_res_get,
 *   random_get,
 *   sched_yield
 * Plus benign no-op success returns: fd_advise, fd_datasync, fd_sync.
 *
 * Total functionally-implemented: 16; total stubbed-ENOSYS for graceful
 * fall-through: 14.
 */
export const WASI_WAVE1_FN_COUNT = 16;

/** Names of the Wave-1 functionally-implemented WASI fns. */
export const WASI_WAVE1_FNS: readonly string[] = Object.freeze([
  'args_get', 'args_sizes_get',
  'environ_get', 'environ_sizes_get',
  'fd_close', 'fd_read', 'fd_write', 'fd_seek', 'fd_tell',
  'fd_fdstat_get', 'fd_fdstat_set_flags',
  'proc_exit',
  'clock_time_get', 'clock_res_get',
  'random_get',
  'sched_yield',
]);
