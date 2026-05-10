/**
 * wasi-instance.ts — WASI snapshot_preview1 shim for Nimbus (Wave-1 + Wave-2).
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
 * Wave-2 additions (10 fns flipped from ENOSYS to real impls):
 *   path_open
 *   path_create_directory / path_remove_directory
 *   path_unlink_file
 *   path_rename                         (uses Nimbus W-3 atomic rename)
 *   path_filestat_get / path_filestat_set_times (no-op times)
 *   fd_readdir                          (cookie-paginated)
 *   fd_filestat_get / fd_filestat_set_size
 *   fd_pread / fd_pwrite
 *   fd_prestat_get / fd_prestat_dir_name (real preopens, not EBADF)
 *
 * Wave-2 explicitly DEFERS to Wave-3:
 *   path_readlink / path_symlink / path_link  (POSIX symlink semantics)
 *   poll_oneoff (no I/O multiplexing on workerd)
 *   sock_*      (no userspace TCP in WASI)
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
 *   ENOTEMPTY = 55   ENOTCAPABLE = 76
 *
 * Clock IDs
 * ─────────
 *   CLOCK_REALTIME = 0  / MONOTONIC = 1  / PROCESS_CPUTIME = 2  / THREAD = 3
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
const __WASI_ESUCCESS    = 0;
const __WASI_EBADF       = 8;
const __WASI_EEXIST      = 20;
const __WASI_EINVAL      = 28;
const __WASI_EISDIR      = 31;
const __WASI_ENOENT      = 44;
const __WASI_ENOSYS      = 52;
const __WASI_ENOTDIR     = 54;
const __WASI_ENOTEMPTY   = 55;
const __WASI_ENOTCAPABLE = 76;
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

class __WasiExit { constructor(code) { this.code = code | 0; } }

// ─── Virtual filesystem state ───────────────────────────────────────────
//
// __wasiInitFS({ root, preopens, files, dirs }) — install a per-call FS:
//   root      string  — canonical session root, e.g. 'home/user/wasi-w2'.
//   preopens  Array<{ wasiPath, vfsPath }> — fd>=3 preopens (in order).
//   files     Record<vfsPath, base64 string> — initial file contents.
//   dirs      Array<vfsPath> — initial directory list.
//
// After _start returns, __wasiSnapshotFS() extracts:
//   {
//     filesWritten: Record<vfsPath, base64 string>,  // new + modified
//     filesDeleted: string[],                         // unlinked
//     dirsCreated:  string[],                         // mkdir'd
//     dirsDeleted:  string[],                         // rmdir'd
//   }

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

function __wasiInitFS(opts) {
  const files = new Map();   // canonicalVfsPath → Uint8Array
  const dirs  = new Set();   // canonicalVfsPath
  // mirror originals for diff at flush time
  const origFiles = new Map();
  const origDirs  = new Set();
  for (const [path, b64] of Object.entries(opts.files || {})) {
    const canon = __wasiCanonicalize(path);
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    files.set(canon, u8);
    origFiles.set(canon, u8.slice());  // copy so subsequent mutations detect change
  }
  for (const path of opts.dirs || []) {
    const canon = __wasiCanonicalize(path);
    dirs.add(canon);
    origDirs.add(canon);
  }
  __wasiFS = {
    root: __wasiCanonicalize(opts.root || ''),
    files, dirs,
    origFiles, origDirs,
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
  }
}

function __wasiSnapshotFS() {
  if (!__wasiFS) return null;
  const filesWritten = {};
  const filesDeleted = [];
  const dirsCreated  = [];
  const dirsDeleted  = [];
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
  return { filesWritten, filesDeleted, dirsCreated, dirsDeleted };
}

// ─── fd table ──────────────────────────────────────────────────────────
//
// Entry shapes:
//   { kind: 'stdin' | 'stdout' | 'stderr' }
//   { kind: 'preopen', wasiPath, vfsPath }
//   { kind: 'file', vfsPath, offset, oflags, fdflags }
//   { kind: 'dir',  vfsPath, readdirEntries: null | Array, cookie }
const fdTable = new Map();
let nextFd = 3;

function __wasiResolvePath(baseFd, pathStr) {
  // Resolve a WASI path against a preopen fd. Returns canonical VFS path.
  const entry = fdTable.get(baseFd);
  if (!entry) return null;
  let baseVfs;
  if (entry.kind === 'preopen' || entry.kind === 'dir') baseVfs = entry.vfsPath;
  else return null;
  // pathStr may be 'foo', './foo', '/foo'. Treat all as relative to baseVfs.
  const trimmed = pathStr.replace(/^\\.?\\/+/, '').replace(/^\\/+/, '');
  return __wasiCanonicalize(baseVfs + '/' + trimmed);
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
  }
  function unsetFile(vfsPath) {
    __wasiFS.files.delete(vfsPath);
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

    fd_seek(fd, offsetLo, offsetHi, whence, newOffsetPtr) {
      if (fd === 0 || fd === 1 || fd === 2) {
        writeU64LE(newOffsetPtr, 0n);
        return __WASI_ESUCCESS;
      }
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      // 64-bit offset reconstruction. WASI passes i64 as (lo, hi) on i32 platforms.
      let delta;
      if (typeof offsetLo === 'bigint') delta = offsetLo;
      else delta = BigInt(offsetLo | 0) | (BigInt(offsetHi | 0) << 32n);
      const cur = BigInt(entry.offset);
      const file = getFile(entry.vfsPath);
      const fileLen = file ? BigInt(file.length) : 0n;
      let next;
      // whence: 0=SET, 1=CUR, 2=END
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
      }
      dv.setUint8(statPtr, ftype);
      dv.setUint8(statPtr + 1, 0);
      dv.setUint16(statPtr + 2, 0, true);
      dv.setUint32(statPtr + 4, 0, true);
      writeU64LE(statPtr + 8,  0x3FFFFFFFn);  // rights_base = wide-open
      writeU64LE(statPtr + 16, 0x3FFFFFFFn);  // rights_inheriting
      return __WASI_ESUCCESS;
    },

    fd_fdstat_set_flags(fd, flags) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      if (entry.kind === 'file') entry.fdflags = flags;
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
    path_open(baseFd, dirflags, pathPtr, pathLen, oflags, rbLo, rbHi, riLo, riHi, fdflags, fdOutPtr) {
      const path = readPath(pathPtr, pathLen);
      const resolved = __wasiResolvePath(baseFd, path);
      if (resolved === null) return __WASI_EBADF;
      const isCreate    = (oflags & __WASI_O_CREAT) !== 0;
      const isDirectory = (oflags & __WASI_O_DIRECTORY) !== 0;
      const isExcl      = (oflags & __WASI_O_EXCL) !== 0;
      const isTrunc     = (oflags & __WASI_O_TRUNC) !== 0;

      const fileExists = __wasiFS.files.has(resolved);
      const dirExists  = __wasiFS.dirs.has(resolved);

      if (isDirectory) {
        if (!dirExists) return __WASI_ENOENT;
        const fd = nextFd++;
        fdTable.set(fd, { kind: 'dir', vfsPath: resolved, readdirEntries: null, cookie: 0n });
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
      const resolved = __wasiResolvePath(baseFd, path);
      if (resolved === null) return __WASI_EBADF;
      let ftype, size;
      if (__wasiFS.files.has(resolved)) {
        ftype = __WASI_FT_REGULAR_FILE;
        size = BigInt(__wasiFS.files.get(resolved).length);
      } else if (__wasiFS.dirs.has(resolved)) {
        ftype = __WASI_FT_DIRECTORY;
        size = 0n;
      } else {
        return __WASI_ENOENT;
      }
      const dv = view();
      // filestat_t: dev,ino: 0; filetype @16; nlink @24=1; size @32; times @40/48/56=0
      writeU64LE(statPtr,      0n);
      writeU64LE(statPtr + 8,  0n);
      dv.setUint8(statPtr + 16, ftype);
      for (let i = 17; i < 24; i++) dv.setUint8(statPtr + i, 0);
      writeU64LE(statPtr + 24, 1n);
      writeU64LE(statPtr + 32, size);
      writeU64LE(statPtr + 40, 0n);
      writeU64LE(statPtr + 48, 0n);
      writeU64LE(statPtr + 56, 0n);
      return __WASI_ESUCCESS;
    },

    path_filestat_set_times() { return __WASI_ESUCCESS; },
    path_readlink()  { return __WASI_ENOSYS; },
    path_symlink()   { return __WASI_ENOSYS; },
    path_link()      { return __WASI_ENOSYS; },

    // ── fd_filestat_get / fd_filestat_set_size ──
    fd_filestat_get(fd, statPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      const dv = view();
      let ftype = __WASI_FT_UNKNOWN;
      let size = 0n;
      if (entry.kind === 'file') {
        ftype = __WASI_FT_REGULAR_FILE;
        const f = getFile(entry.vfsPath);
        if (f) size = BigInt(f.length);
      } else if (entry.kind === 'dir' || entry.kind === 'preopen') {
        ftype = __WASI_FT_DIRECTORY;
      } else if (entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
        ftype = __WASI_FT_CHARACTER_DEVICE;
      }
      writeU64LE(statPtr,      0n);
      writeU64LE(statPtr + 8,  0n);
      dv.setUint8(statPtr + 16, ftype);
      for (let i = 17; i < 24; i++) dv.setUint8(statPtr + i, 0);
      writeU64LE(statPtr + 24, 1n);
      writeU64LE(statPtr + 32, size);
      writeU64LE(statPtr + 40, 0n);
      writeU64LE(statPtr + 48, 0n);
      writeU64LE(statPtr + 56, 0n);
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
    fd_filestat_set_times() { return __WASI_ESUCCESS; },

    // ── fd_pread / fd_pwrite (offset-explicit) ──
    fd_pread(fd, iovsPtr, iovsLen, offsetLo, offsetHi, nreadPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      const file = getFile(entry.vfsPath);
      if (!file) return __WASI_ENOENT;
      let offset = typeof offsetLo === 'bigint'
        ? Number(offsetLo)
        : (offsetLo >>> 0) + (offsetHi >>> 0) * 4294967296;
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

    fd_pwrite(fd, iovsPtr, iovsLen, offsetLo, offsetHi, nwrittenPtr) {
      const entry = fdTable.get(fd);
      if (!entry || entry.kind !== 'file') return __WASI_EBADF;
      let offset = typeof offsetLo === 'bigint'
        ? Number(offsetLo)
        : (offsetLo >>> 0) + (offsetHi >>> 0) * 4294967296;
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
    fd_readdir(fd, bufPtr, bufLen, cookieLo, cookieHi, bufusedPtr) {
      const entry = fdTable.get(fd);
      if (!entry || (entry.kind !== 'dir' && entry.kind !== 'preopen')) return __WASI_EBADF;
      // Materialise the entry list once, lazily.
      if (!entry.readdirEntries) {
        const kids = readdirChildren(entry.vfsPath);
        // Per WASI / POSIX, prepend "." and ".." synthetic entries so an
        // empty directory still has a non-zero bufused.
        entry.readdirEntries = [
          { name: '.',  type: __WASI_FT_DIRECTORY },
          { name: '..', type: __WASI_FT_DIRECTORY },
          ...kids,
        ];
      }
      let startCookie = typeof cookieLo === 'bigint'
        ? Number(cookieLo)
        : (cookieLo >>> 0) + (cookieHi >>> 0) * 4294967296;
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
    fd_allocate()   { return __WASI_ENOSYS; },
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
    proc_raise()    { throw new __WasiExit(128); },

    // ── clock ──
    clock_time_get(clockId, _precLo, _precHi, timePtr) {
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

    // ── DEFERRED to future waves ──
    poll_oneoff()   { return __WASI_ENOSYS; },
    sock_recv()     { return __WASI_ENOSYS; },
    sock_send()     { return __WASI_ENOSYS; },
    sock_shutdown() { return __WASI_ENOSYS; },
  };

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
// ── END: wasi-instance preamble ─────────────────────────────────────────
`;

/**
 * A bundle of file/dir state passed from supervisor → facet for a WASI
 * invocation. Files are base64-encoded so the JSON-serializable
 * loader-pool `context` field can carry them.
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
}

/**
 * Per-call return shape — what the facet's RPC produces back to the
 * supervisor. Mutations are diffs against the initial snapshot.
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
}

/** Total count of functionally-implemented WASI fns (Wave-1 + Wave-2). */
export const WASI_WAVE2_FN_COUNT = 30;

/** Names of the Wave-1 + Wave-2 functionally-implemented WASI fns. */
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
  'path_filestat_get', 'path_filestat_set_times',
  'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
  'fd_pread', 'fd_pwrite',
  'fd_readdir',
  'fd_renumber',
]);

/**
 * Backwards-compat alias kept for any caller still importing the Wave-1
 * symbol names. The Wave-2 module now subsumes Wave-1's count.
 */
export const WASI_WAVE1_FNS = WASI_WAVE2_FNS;
