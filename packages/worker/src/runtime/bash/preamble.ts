/**
 * bash/preamble.ts — the facet-side bash scheduler, as real TypeScript.
 *
 * This file IS the runner. scripts/bundle-facet-workers.mjs esbuilds it into
 * bash-runner.generated.ts as a self-contained IIFE, and bash-runner.ts re-exports
 * that string as BASH_RUNNER_PREAMBLE — the loader-pool preamble every bash facet
 * evaluates. The same pattern wasi/preamble.ts and virtual-socket-kernel.ts use.
 *
 * Until this move the scheduler lived inside a String.raw template literal, so no
 * type checker had ever read it.
 *
 * Constraints the build imposes on this file:
 *   - It is evaluated as a FUNCTION body (new Function(...) in tests, a loader-pool
 *     preamble in production), so the emitted string may contain no import, no
 *     export and no top-level await. Bundling to an IIFE is what guarantees that.
 *   - Nothing may be imported for its value. Type-only imports are erased and are
 *     the only kind permitted.
 *   - globalThis.__bashBoot and globalThis.__bashFeed are the entry points; every
 *     other declaration is reachable only from them, which is why the bundle runs
 *     with tree shaking off.
 */
import type {
  BashBlockTarget,
  BashBootArgs,
  BashByteQueue,
  BashErrno,
  BashFdEntry,
  BashFdReadiness,
  BashFeedArgs,
  BashFileEntry,
  BashFsSeed,
  BashFsState,
  BashInstance,
  BashIo,
  BashIovs,
  BashPathResolution,
  BashPipe,
  BashPollSub,
  BashProc,
  BashProcImports,
  BashReadWaiter,
  BashSession,
  BashSlice,
  BashUnsupportedImports,
  BashWasiFsImports,
  BashWasiImports,
} from './types.js';
import type { WasiFsDiff } from '../vfs-snapshot.js';

const PAGE = 65536, te = new TextEncoder(), td = new TextDecoder();
// Sizing is measurement-grounded (local pre-gate stats): bash's deepest
// observed asyncify capture is ~25 KiB (full control suite), so 8 MiB
// main / 256 KiB slots carry 300×/10× margin while keeping a full
// instance ~17 MiB — several forks fit the ~180-200 MiB facet ceiling.
const MAIN_SIZE = 8 << 20, SLOT_SIZE = 256 << 10, NSLOT = 32;
const E = { ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, LOOP: 32, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, SPIPE: 70 } satisfies Record<string, BashErrno>;
// WASI clock ids. MONOTONIC and the two CPUTIME clocks are answered from a
// monotonic source; an id outside this set is EINVAL, never a silent realtime
// reading — a guest that asks for monotonic and receives wall time computes
// negative durations the first time the wall clock steps backwards.
const CLOCK_REALTIME = 0, CLOCK_MONOTONIC = 1, CLOCK_PROCESS_CPUTIME = 2, CLOCK_THREAD_CPUTIME = 3;
function realtimeNs() { return BigInt(Date.now()) * 1000000n; }
function monotonicNs() {
  const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return BigInt(Math.floor(ms * 1000)) * 1000n;
}
// null for an unknown id, so callers answer EINVAL rather than inventing a time.
function clockNs(id: number | undefined): bigint | null {
  if (id === CLOCK_REALTIME) return realtimeNs();
  if (id === CLOCK_MONOTONIC || id === CLOCK_PROCESS_CPUTIME || id === CLOCK_THREAD_CPUTIME) return monotonicNs();
  return null;
}
class Exit { declare code: number; constructor(c: number) { this.code = c; } }

let S: BashSession | null = null;  // active session state; persists across submits on the warm isolate

function norm(p: string): string {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return btoa(bin);
}

function newSession(args: BashBootArgs): BashSession {
  const wasmTable = globalThis.__NIMBUS_WASM || {};
  const mod = wasmTable['bash.async.wasm'];
  if (!mod) throw new Error('bash.async.wasm missing from __NIMBUS_WASM');
  const coreutils = new Map();
  for (const key of Object.keys(wasmTable)) {
    if (key.startsWith('cu_') && key.endsWith('.wasm')) coreutils.set(key.slice(3, -5), wasmTable[key]);
  }
  // Applet aliasing: ONE staged busybox module answers to every applet
  // name (busybox dispatches on argv[0]), so bash's PATH lookup finds
  // ls/cat/grep/... as executables in /bin.
  const busybox = wasmTable['cu_busybox.wasm'];
  if (busybox) for (const name of args.busyboxApplets || []) coreutils.set(name, busybox);

  const fs: BashFsState = {
    files: new Map(), dirs: new Set(), modes: new Map(),
    written: new Set(), deleted: new Set(),
    dirsCreated: new Set(), dirsDeleted: new Set(), modesChanged: new Map(),
    // vfsPath → mtime ns. The snapshot carries no times, so an inode the
    // session did not touch reports sessionNs: older than anything written
    // here, which is what makes 'is the target newer than its source' — the
    // question make(1) and every incremental build asks — answerable.
    times: new Map(), sessionNs: realtimeNs(),
    // vfsPath → target string, stored verbatim per POSIX: a symlink is a dumb
    // string resolved at lookup time, not a pointer to an inode.
    symlinks: new Map(), symlinksCreated: new Map(),
  };
  const snap: BashFsSeed = args.fsSnapshot || { files: {}, dirs: [], modes: {} };
  for (const [path, b64] of Object.entries(snap.files || {})) fs.files.set(norm(path), { bytes: b64ToBytes(b64) });
  for (const d of snap.dirs || []) fs.dirs.add(norm(d));
  // The snapshot's modes are the S2a projection: effective rwx per path
  // for the invoking credential. Enforced by the WASI layer below.
  for (const [path, m] of Object.entries(snap.modes || {})) fs.modes.set(norm(path), Number(m) & 7);
  for (const seed of ['etc', 'dev', 'bin', 'usr', 'usr/bin']) {
    fs.dirs.add(seed);
    if (!fs.modes.has(seed)) fs.modes.set(seed, 5);
  }
  // Startup rc: chdir to the session cwd (wasi-libc cwd starts at '/').
  // BASH_ENV points here for non-interactive shells; interactive shells
  // read ~/.bashrc, which is seeded to source this file when absent.
  if (!fs.files.has('etc/nimbus.bashrc')) {
    fs.files.set('etc/nimbus.bashrc', { bytes: te.encode('command cd "$' + '{NIMBUS_PWD:-/}" 2>/dev/null\n') });
    fs.modes.set('etc/nimbus.bashrc', 4);
  }
  const home = norm((args.environ.find((e) => e.startsWith('HOME=')) || 'HOME=/home/user').slice(5));
  if (args.stdinTty && home && !fs.files.has(home + '/.bashrc')) {
    fs.files.set(home + '/.bashrc', { bytes: te.encode('. /etc/nimbus.bashrc\n') });
    if (!fs.modes.has(home + '/.bashrc')) fs.modes.set(home + '/.bashrc', 6);
  }

  const cwd = norm((args.environ.find((e) => e.startsWith('NIMBUS_PWD=')) || 'NIMBUS_PWD=/').slice(11));
  return {
    mod, coreutils, fs, cwd,
    argv: args.argv, environ: args.environ,
    stdinTty: !!args.stdinTty,
    stdin: { chunks: args.stdinData ? [te.encode(args.stdinData)] : [], queued: 0, closed: !!args.stdinClosed, waiters: [] },
    procs: new Map(), pipes: new Map(), runnable: [], exitStatus: new Map(), waiters: [],
    pidNext: 100, pipeNext: 1, rootPid: 0, rootExit: null, steps: 0,
    out: '', err: '',
    missingWasi: new Set(),
    stats: { instances: 0, memPeak: 0, mainHi: 0, slotHi: 0 },
    error: null,
  };
}
function initStdinQueued(s: BashSession): void { s.stdin.queued = s.stdin.chunks.reduce((a, c) => a + c.length, 0); }

function newPipe(s: BashSession): number { const id = s.pipeNext++; s.pipes.set(id, { chunks: [], queued: 0, readers: 1, writers: 1, readW: [] }); return id; }
// fd 3 is the wasi-libc '/' preopen. It lives in the fd table as a
// real 'preopen' entry: wasi-libc's path ops fd_fdstat_get the dirfd
// to compute inherited rights, so it must answer (not EBADF), and
// lowestFd must never re-issue it for a regular file.
function lowestFd(proc: BashProc): number { let fd = 0; while (proc.fds.has(fd) || fd === 3) fd++; return fd; }
function bumpPipe(s: BashSession, e: { pipeId: number; end: 'r' | 'w' }, d: number): void { const pp = s.pipes.get(e.pipeId) as BashPipe; if (e.end === 'r') pp.readers += d; else pp.writers += d; }
function closeFd(s: BashSession, proc: BashProc, fd: number): void {
  const e = proc.fds.get(fd);
  if (!e) return;
  proc.fds.delete(fd);
  if (e.kind === 'pipe') { bumpPipe(s, e, -1); wakePipe(s, s.pipes.get(e.pipeId) as BashPipe); }
}
function takeUpTo(src: BashByteQueue, max: number): Uint8Array {
  let need = max; const parts = [];
  while (need > 0 && src.chunks.length) {
    const ch = src.chunks[0];
    if (ch.length <= need) { parts.push(ch); need -= ch.length; src.chunks.shift(); }
    else { parts.push(ch.subarray(0, need)); src.chunks[0] = ch.subarray(need); need = 0; }
  }
  const total = max - need; src.queued -= total;
  const o = new Uint8Array(total); let x = 0;
  for (const p of parts) { o.set(p, x); x += p.length; }
  return o;
}
// POSIX readv is ONE read of up to the summed length, scattered across the
// buffers in order — not a read of the first buffer. Zero-length entries are
// dropped so they never terminate the scatter early.
// A poll park has no destination buffer — it resumes into a fresh poll call.
const EMPTY_IOV: BashIovs = { list: [], total: 0 };
function readIovs(dv: DataView, iovs: number, n: number): BashIovs {
  const list = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const ptr = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
    if (len > 0) { list.push({ ptr, len }); total += len; }
  }
  return { list, total };
}
function scatter(u8: Uint8Array, iov: BashIovs, bytes: Uint8Array): number {
  let off = 0;
  for (const b of iov.list) {
    if (off >= bytes.length) break;
    const n = Math.min(b.len, bytes.length - off);
    u8.set(bytes.subarray(off, off + n), b.ptr);
    off += n;
  }
  return off;
}
function wakePipe(s: BashSession, pp: BashPipe): void {
  while (pp.readW.length && (pp.queued > 0 || pp.writers === 0)) {
    const w = pp.readW.shift() as BashReadWaiter; const proc = w.proc; const req = proc.ctx.pipeReq;
    const bytes = pp.queued > 0 ? takeUpTo(pp, req.iov.total) : new Uint8Array(0);
    proc.pendingRead = { iov: req.iov, bytes, nreadPtr: req.nreadPtr, pollUserdata: req.pollUserdata };
    resumeProc(proc);
  }
}
function wakeStdin(s: BashSession): void {
  const st = s.stdin;
  while (st.waiters.length && (st.queued > 0 || st.closed)) {
    const w = st.waiters.shift() as BashReadWaiter; const proc = w.proc; const req = proc.ctx.pipeReq;
    const bytes = st.queued > 0 ? takeUpTo(st, req.iov.total) : new Uint8Array(0);
    proc.pendingRead = { iov: req.iov, bytes, nreadPtr: req.nreadPtr, pollUserdata: req.pollUserdata };
    resumeProc(proc);
  }
}

// ── file layer ────────────────────────────────────────────────────────
function fileLookup(s: BashSession, path: string): BashFileEntry | null { return s.fs.files.get(path) || null; }
function isDir(s: BashSession, path: string): boolean { return path === '' || s.fs.dirs.has(path); }
function isCoreutil(s: BashSession, path: string): boolean {
  if (!path.startsWith('bin/') && !path.startsWith('usr/bin/')) return false;
  return s.coreutils.has(path.split('/').pop() as string);
}
// A modes-only inode is a file the snapshot could not read (S2a): it
// exists, its bytes are absent, and access answers with the real bits.
function fileExists(s: BashSession, path: string): boolean {
  return s.fs.files.has(path) || (s.fs.modes.has(path) && !s.fs.dirs.has(path));
}
function inodeExists(s: BashSession, path: string): boolean {
  return s.fs.files.has(path) || s.fs.dirs.has(path) || s.fs.modes.has(path);
}
// S2a effective-mode policy (mirrors the JSPI shim): a mapped mode wins;
// an inode that exists without one is denied; an absent path is free to
// create (the durable flush re-checks as the credential).
function effMode(s: BashSession, path: string): number {
  if (path === '') return 7;
  const m = s.fs.modes.get(path);
  if (m !== undefined) return m;
  if (isCoreutil(s, path)) return 5;
  return inodeExists(s, path) ? 0 : 7;
}
function parentOf(path: string): string { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
// Rewrite the leftmost symlink on the path and repeat, so both intermediate
// components and a terminal link resolve. A target starting with '/' is
// root-anchored; anything else is relative to the link's own directory.
// SYMLOOP_MAX bounds it — a cycle answers ELOOP rather than hanging.
function followPath(s: BashSession, path: string): BashPathResolution {
  let cur = path;
  for (let hops = 0; hops < 32; hops++) {
    if (!s.fs.symlinks.size) return { path: cur, errno: 0 };
    const parts = cur.split('/');
    let prefix = '';
    let rewrote = false;
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? prefix + '/' + parts[i] : parts[i];
      const target = s.fs.symlinks.get(prefix);
      if (target === undefined) continue;
      const base = target.startsWith('/') ? norm(target) : norm(parentOf(prefix) + '/' + target);
      const rest = parts.slice(i + 1).join('/');
      cur = rest ? norm(base + '/' + rest) : base;
      rewrote = true;
      break;
    }
    if (!rewrote) return { path: cur, errno: 0 };
  }
  return { path: cur, errno: E.LOOP };
}
// Resolve only the directories leading to the final component. This is what
// the mutating ops want: rm dir/link must delete the link, not its target,
// while dir itself may still be reached through a link.
function followParents(s: BashSession, path: string): BashPathResolution {
  const parent = parentOf(path);
  if (!parent) return { path, errno: 0 };
  const r = followPath(s, parent);
  if (r.errno) return r;
  const name = path.slice(parent.length + 1);
  return { path: r.path ? r.path + '/' + name : name, errno: 0 };
}
// Every ancestor dir on the way to the target needs the search (x) bit.
function checkTraversal(s: BashSession, path: string): BashErrno {
  const parts = path.split('/');
  let anc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    anc = anc ? anc + '/' + parts[i] : parts[i];
    if (!isDir(s, anc)) return inodeExists(s, anc) ? E.NOTDIR : E.NOENT;
    if ((effMode(s, anc) & 1) === 0) return E.ACCES;
  }
  return 0;
}
function checkParentWritable(s: BashSession, path: string): BashErrno {
  const parent = parentOf(path);
  if (parent && (effMode(s, parent) & 3) !== 3) return E.ACCES;
  return 0;
}
function recordDirAdded(s: BashSession, path: string): void {
  s.fs.dirs.add(path); s.fs.dirsDeleted.delete(path); s.fs.dirsCreated.add(path);
  if (!s.fs.modes.has(path)) s.fs.modes.set(path, 7);
  touchPath(s, path);
}
function recordDirRemoved(s: BashSession, path: string): void {
  s.fs.dirs.delete(path); s.fs.modes.delete(path); s.fs.times.delete(path);
  if (s.fs.dirsCreated.has(path)) s.fs.dirsCreated.delete(path);
  else s.fs.dirsDeleted.add(path);
}
function recordFileRemoved(s: BashSession, path: string): void {
  s.fs.files.delete(path); s.fs.written.delete(path); s.fs.modes.delete(path);
  s.fs.times.delete(path); s.fs.symlinks.delete(path); s.fs.symlinksCreated.delete(path);
  s.fs.deleted.add(path);
}
function markWritten(s: BashSession, path: string): void {
  s.fs.written.add(path); s.fs.deleted.delete(path);
  if (!s.fs.modes.has(path)) s.fs.modes.set(path, 6);
  touchPath(s, path);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!s.fs.dirs.has(dir)) recordDirAdded(s, dir);
  }
}
function fileWrite(s: BashSession, entry: BashFileEntry, path: string, pos: number, bytes: Uint8Array): void {
  const need = pos + bytes.length;
  if (need > entry.bytes.length) {
    const grown = new Uint8Array(need);
    grown.set(entry.bytes); entry.bytes = grown;
  }
  entry.bytes.set(bytes, pos);
  markWritten(s, path);
}
function mtimeNs(s: BashSession, path: string): bigint {
  const t = s.fs.times.get(path);
  return t === undefined ? s.fs.sessionNs : t;
}
function touchPath(s: BashSession, path: string): void { s.fs.times.set(path, realtimeNs()); }
function statBuf(dv: DataView, u8: Uint8Array, buf: number, filetype: number, size: number, timeNs: bigint): void {
  u8.fill(0, buf, buf + 64);
  dv.setUint8(buf + 16, filetype);
  dv.setBigUint64(buf + 24, 1n, true);
  dv.setBigUint64(buf + 32, BigInt(size), true);
  dv.setBigUint64(buf + 40, timeNs, true);
  dv.setBigUint64(buf + 48, timeNs, true);
  dv.setBigUint64(buf + 56, timeNs, true);
}

// Shared WASI surface over the process fd table + file layer. The io
// argument abstracts the blocking discipline: bash instances
// asyncify-park, exec'd plain-WASI tools synchronously pump the scheduler.
//
// pathBase (exec'd coreutils only) emulates the child's inherited cwd. An
// exec'd tool's wasi-libc has cwd '/', so it absolutizes BOTH its own
// relative args and absolute args against '/' — they reach path_open
// IDENTICALLY un-prefixed (e.g. 'ls tmp' and 'ls /tmp' both arrive 'tmp';
// 'ls' and 'ls /' both arrive ''). The lost absolute-vs-relative bit is
// recovered from absRoots: the normalized set of absolute argv paths bash
// passed the tool. A path that IS (or descends from) one of those is
// absolute-origin — the arriving string is already the correct
// root-relative target, so it is NEVER re-anchored. Everything else is
// relative-origin (a relative arg, or a child name synthesized while
// listing a directory): re-anchor against the inherited cwd, preferring
// the cwd-joined path, then the bare one, then whichever parent dir
// exists (touch newfile in the session cwd vs a '/'-listing's children).
function isUnderAbsRoot(p: string, absRoots: Set<string> | undefined): boolean {
  if (!absRoots) return false;
  for (const a of absRoots) {
    if (p === a) return true;
    if (a !== '' && p.startsWith(a + '/')) return true;
  }
  return false;
}
function makeResolve(s: BashSession, pathBase?: string, absRoots?: Set<string>): (raw: string) => string {
  return (raw) => {
    const p = norm(raw);
    if (!pathBase) return p;
    if (isUnderAbsRoot(p, absRoots)) return p;
    const joined = norm(pathBase + '/' + p);
    if (inodeExists(s, joined)) return joined;
    if (inodeExists(s, p)) return p;
    if (isDir(s, parentOf(joined))) return joined;
    if (isDir(s, parentOf(p))) return p;
    return joined;
  };
}
// The rest of the preview1 surface. These are NOT stubs that claim success:
// each one either is genuinely a no-op on an in-memory filesystem, or answers
// ENOSYS. The old blanket fallback returned ESUCCESS for all of them without
// writing their out-params, so a guest read uninitialised memory and believed
// the call had worked — silent wrong data, the worst failure available.
function makeUnsupported(s: BashSession): BashUnsupportedImports {
  const nosys = (name: string) => (): BashErrno => { s.missingWasi.add(name); return E.NOSYS; };
  return {
    // Every write is already durable in the session's own heap, so there is
    // nothing to flush and success is the honest answer.
    fd_sync: () => 0,
    fd_datasync: () => 0,
    fd_advise: () => 0,
    // One process runs at a time under this scheduler; a yield has nothing to
    // yield to that the caller has not already reached.
    sched_yield: () => 0,
    fd_pread: nosys('fd_pread'),
    fd_pwrite: nosys('fd_pwrite'),
    fd_allocate: nosys('fd_allocate'),
    fd_filestat_set_size: nosys('fd_filestat_set_size'),
    fd_filestat_set_times: nosys('fd_filestat_set_times'),
    fd_fdstat_set_rights: nosys('fd_fdstat_set_rights'),
    proc_raise: nosys('proc_raise'),
    sock_send: nosys('sock_send'),
    sock_recv: nosys('sock_recv'),
    sock_shutdown: nosys('sock_shutdown'),
  };
}
function makeWasiFs(
  s: BashSession, proc: BashProc, DV: () => DataView, U8: () => Uint8Array,
  io: BashIo, pathBase?: string, absRoots?: Set<string>,
): BashWasiFsImports {
  const resolve = makeResolve(s, pathBase, absRoots);
  return {
    ...makeUnsupported(s),
    fd_prestat_get: (fd, buf) => { if (fd === 3) { DV().setUint8(buf, 0); DV().setUint32(buf + 4, 1, true); return 0; } return E.BADF; },
    fd_prestat_dir_name: (fd, path, _plen) => { if (fd === 3) { U8()[path] = 0x2f; return 0; } return E.BADF; },
    path_open: (dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, _ri, fdflags, retPtr) => {
      const raw = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      // SYMLINK_FOLLOW (lookupflags bit 0). Without it only the leading
      // directories resolve, so O_NOFOLLOW opens the link itself.
      const r = (dirflags & 1) !== 0 ? followPath(s, raw) : followParents(s, raw);
      if (r.errno) return r.errno;
      const path = r.path;
      const dv = DV();
      if (path === 'dev/null' || path === 'dev/tty') {
        const fd = lowestFd(proc); proc.fds.set(fd, { kind: path === 'dev/tty' ? 'tty' : 'null' });
        dv.setUint32(retPtr, fd, true); return 0;
      }
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      const wantDir = (oflags & 2) !== 0;
      if (isDir(s, path)) {
        if ((effMode(s, path) & 1) === 0) return E.ACCES;
        const fd = lowestFd(proc); proc.fds.set(fd, { kind: 'dir', path });
        dv.setUint32(retPtr, fd, true); return 0;
      }
      if (wantDir) return fileExists(s, path) ? E.NOTDIR : E.NOENT;
      // wasi-libc encodes the open intent in the rights: fd_read is bit 1,
      // fd_write bit 6. Enforce the S2a effective mode accordingly.
      const rights = typeof rightsBase === 'bigint' ? rightsBase : BigInt(rightsBase >>> 0);
      let need = 0;
      if ((rights & 2n) !== 0n) need |= 4;
      if ((rights & 64n) !== 0n) need |= 2;
      if ((oflags & 8) !== 0) need |= 2;                    // O_TRUNC implies write
      let entry = fileLookup(s, path);
      const exists = entry !== null || fileExists(s, path);
      if (exists && (oflags & 4)) return E.EXIST;           // O_EXCL
      if (!exists) {
        if (!(oflags & 1)) return E.NOENT;                  // no O_CREAT
        const denied = checkParentWritable(s, path);
        if (denied) return denied;
        entry = { bytes: new Uint8Array(0) };
        s.fs.files.set(path, entry); markWritten(s, path);
      } else {
        if (need && (effMode(s, path) & need) !== need) return E.ACCES;
        if (!entry) {
          // Exists per the mode map but bytes were not snapshotted
          // (write-only). Start from empty content.
          entry = { bytes: new Uint8Array(0) };
          s.fs.files.set(path, entry);
        }
        if (oflags & 8) {                                   // O_TRUNC
          entry.bytes = new Uint8Array(0); markWritten(s, path);
        }
      }
      const fd = lowestFd(proc);
      proc.fds.set(fd, { kind: 'file', path, pos: 0, append: (fdflags & 1) !== 0 });
      dv.setUint32(retPtr, fd, true);
      return 0;
    },
    fd_filestat_get: (fd, buf) => {
      const e = proc.fds.get(fd);
      if (!e) return E.BADF;
      if (e.kind === 'file') { const f = fileLookup(s, e.path); statBuf(DV(), U8(), buf, 4, f ? f.bytes.length : 0, mtimeNs(s, e.path)); return 0; }
      if (e && (e.kind === 'dir' || e.kind === 'preopen')) { statBuf(DV(), U8(), buf, 3, 0, mtimeNs(s, e.kind === 'preopen' ? '' : e.path)); return 0; }
      statBuf(DV(), U8(), buf, e && (e.kind === 'stdin' || e.kind === 'stdout' || e.kind === 'stderr' || e.kind === 'tty') ? 2 : 0, 0, realtimeNs());
      return 0;
    },
    path_filestat_get: (dirfd, flags, pathPtr, pathLen, buf) => {
      const raw = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      if (raw === 'dev/null' || raw === 'dev/tty') { statBuf(DV(), U8(), buf, 2, 0, realtimeNs()); return 0; }
      // SYMLINK_FOLLOW (bit 0) distinguishes stat from lstat: without it the
      // link itself is the subject, which is how 'test -L' and 'ls -l' tell a
      // symlink apart from what it points at.
      const follow = (flags & 1) !== 0;
      if (!follow && s.fs.symlinks.has(raw)) {
        statBuf(DV(), U8(), buf, 7, te.encode(s.fs.symlinks.get(raw) as string).length, mtimeNs(s, raw));
        return 0;
      }
      const r = followPath(s, raw);
      if (r.errno) return r.errno;
      const path = r.path;
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      const f = fileLookup(s, path);
      if (f) { statBuf(DV(), U8(), buf, 4, f.bytes.length, mtimeNs(s, path)); return 0; }
      if (isCoreutil(s, path)) { statBuf(DV(), U8(), buf, 4, 1024, mtimeNs(s, path)); return 0; }
      if (isDir(s, path)) { statBuf(DV(), U8(), buf, 3, 0, mtimeNs(s, path)); return 0; }
      if (fileExists(s, path)) { statBuf(DV(), U8(), buf, 4, 0, mtimeNs(s, path)); return 0; }  // unreadable: size unknown
      return E.NOENT;
    },
    // fstflags: ATIM=1, ATIM_NOW=2, MTIM=4, MTIM_NOW=8. Only the mtime half is
    // recorded — this layer keeps one timestamp per inode, and mtime is the
    // one every build tool reads.
    path_filestat_set_times: (dirfd, _flags, pathPtr, pathLen, _atim, mtim, fstflags) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      if (!inodeExists(s, path) && !s.fs.symlinks.has(path)) return E.NOENT;
      if (fstflags & 8) s.fs.times.set(path, realtimeNs());
      else if (fstflags & 4) s.fs.times.set(path, typeof mtim === 'bigint' ? mtim : BigInt(mtim >>> 0));
      return 0;
    },
    path_unlink_file: (dirfd, pathPtr, pathLen) => {
      // unlink removes the link, never what it points at.
      const r = followParents(s, resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen))));
      if (r.errno) return r.errno;
      const path = r.path;
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      if (isDir(s, path)) return E.ISDIR;
      if (!fileExists(s, path) && !s.fs.symlinks.has(path)) return E.NOENT;
      const denied = checkParentWritable(s, path);
      if (denied) return denied;
      recordFileRemoved(s, path);
      return 0;
    },
    path_rename: (fd1, oldPtr, oldLen, fd2, newPtr, newLen) => {
      const from = resolve(td.decode(U8().subarray(oldPtr, oldPtr + oldLen)));
      const to = resolve(td.decode(U8().subarray(newPtr, newPtr + newLen)));
      let trav = checkTraversal(s, from);
      if (trav) return trav;
      trav = checkTraversal(s, to);
      if (trav) return trav;
      const fromIsDir = from !== '' && isDir(s, from);
      const f = fileLookup(s, from);
      if (!fromIsDir && !f && !fileExists(s, from)) return E.NOENT;
      if (from === to) return 0;
      let denied = checkParentWritable(s, from);
      if (!denied) denied = checkParentWritable(s, to);
      if (denied) return denied;
      const moveMode = (a: string, b: string) => {
        const m = s.fs.modes.get(a); s.fs.modes.delete(a);
        if (m !== undefined) s.fs.modes.set(b, m);
      };
      // Atomic-overwrite destination of the matching kind.
      if (isDir(s, to)) {
        if (!fromIsDir) return E.ISDIR;
        const prefix = to + '/';
        for (const p of s.fs.files.keys()) if (p.startsWith(prefix)) return E.NOTEMPTY;
        for (const p of s.fs.dirs) if (p.startsWith(prefix)) return E.NOTEMPTY;
        recordDirRemoved(s, to);
      } else if (fileExists(s, to)) {
        if (fromIsDir) return E.NOTDIR;
        recordFileRemoved(s, to);
      }
      if (fromIsDir) {
        const mode = s.fs.modes.get(from);
        recordDirRemoved(s, from);
        recordDirAdded(s, to);
        if (mode !== undefined) s.fs.modes.set(to, mode);
        const prefix = from + '/';
        const rebase = (key: string) => to + '/' + key.slice(prefix.length);
        for (const key of [...s.fs.files.keys()]) {
          if (!key.startsWith(prefix)) continue;
          const nk = rebase(key);
          const entry = s.fs.files.get(key) as BashFileEntry;
          recordFileRemoved(s, key);
          moveMode(key, nk);
          s.fs.files.set(nk, entry);
          s.fs.written.add(nk); s.fs.deleted.delete(nk);
          if (!s.fs.modes.has(nk)) s.fs.modes.set(nk, 6);
        }
        for (const key of [...s.fs.dirs]) {
          if (!key.startsWith(prefix)) continue;
          const nk = rebase(key);
          const mode2 = s.fs.modes.get(key);
          recordDirRemoved(s, key);
          recordDirAdded(s, nk);
          if (mode2 !== undefined) s.fs.modes.set(nk, mode2);
        }
        return 0;
      }
      const entry = f || { bytes: new Uint8Array(0) };
      const mode = s.fs.modes.get(from);
      recordFileRemoved(s, from);
      s.fs.files.set(to, entry); markWritten(s, to);
      if (mode !== undefined) s.fs.modes.set(to, mode);
      return 0;
    },
    path_create_directory: (dirfd, pathPtr, pathLen) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      if (isDir(s, path) || fileExists(s, path)) return E.EXIST;
      const denied = checkParentWritable(s, path);
      if (denied) return denied;
      recordDirAdded(s, path);
      return 0;
    },
    // path_readlink(fd, path, path_len, buf, buf_len, *bufused). Never follows
    // the last component — reading a link is the one op that is about the link.
    path_readlink: (dirfd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr) => {
      const r = followParents(s, resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen))));
      if (r.errno) return r.errno;
      const target = s.fs.symlinks.get(r.path);
      if (target === undefined) return inodeExists(s, r.path) ? E.INVAL : E.NOENT;
      const bytes = te.encode(target);
      const n = Math.min(bytes.length, bufLen);
      U8().set(bytes.subarray(0, n), bufPtr);
      DV().setUint32(bufUsedPtr, n, true);
      return 0;
    },
    // path_symlink(old_path, old_path_len, fd, new_path, new_path_len) — the
    // target comes FIRST and is not a path in this filesystem: it is stored
    // verbatim and may dangle, exactly as ln -s allows.
    path_symlink: (oldPtr, oldLen, newFd, newPtr, newLen) => {
      const target = td.decode(U8().subarray(oldPtr, oldPtr + oldLen));
      const r = followParents(s, resolve(td.decode(U8().subarray(newPtr, newPtr + newLen))));
      if (r.errno) return r.errno;
      const link = r.path;
      const trav = checkTraversal(s, link);
      if (trav) return trav;
      if (inodeExists(s, link) || s.fs.symlinks.has(link)) return E.EXIST;
      const denied = checkParentWritable(s, link);
      if (denied) return denied;
      s.fs.symlinks.set(link, target);
      s.fs.symlinksCreated.set(link, target);
      s.fs.modes.set(link, 7);
      s.fs.deleted.delete(link);
      touchPath(s, link);
      return 0;
    },
    path_link: (fd1, _lookupFlags, oldPtr, oldLen, fd2, newPtr, newLen) => {
      const from = resolve(td.decode(U8().subarray(oldPtr, oldPtr + oldLen)));
      const to = resolve(td.decode(U8().subarray(newPtr, newPtr + newLen)));
      let trav = checkTraversal(s, from);
      if (trav) return trav;
      trav = checkTraversal(s, to);
      if (trav) return trav;
      if (isDir(s, from)) return E.PERM;
      const f = fileLookup(s, from);
      if (!f) return fileExists(s, from) ? E.ACCES : E.NOENT;
      if (fileExists(s, to) || isDir(s, to)) return E.EXIST;
      const denied = checkParentWritable(s, to);
      if (denied) return denied;
      // Both names share ONE entry object — writes through either alias
      // mutate the same bytes, which is real hard-link semantics here.
      s.fs.files.set(to, f); markWritten(s, to);
      s.fs.modes.set(to, effMode(s, from));
      return 0;
    },
    path_remove_directory: (dirfd, pathPtr, pathLen) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      if (path === '' || path === 'etc' || path === 'dev' || path === 'bin' || path === 'usr' || path === 'usr/bin') return E.ACCES;
      if (!isDir(s, path)) return fileExists(s, path) ? E.NOTDIR : E.NOENT;
      const denied = checkParentWritable(s, path);
      if (denied) return denied;
      const prefix = path + '/';
      for (const p of s.fs.files.keys()) if (p.startsWith(prefix)) return E.NOTEMPTY;
      for (const p of s.fs.dirs) if (p.startsWith(prefix)) return E.NOTEMPTY;
      for (const p of s.fs.modes.keys()) if (p.startsWith(prefix)) return E.NOTEMPTY;
      recordDirRemoved(s, path);
      return 0;
    },
    fd_renumber: (from, to) => {
      const e = proc.fds.get(from);
      if (!e) return E.BADF;
      if (from !== to) {
        closeFd(s, proc, to);
        proc.fds.set(to, e);
        proc.fds.delete(from);
      }
      return 0;
    },
    fd_readdir: (fd, buf, bufLen, cookie, retPtr) => {
      const e = proc.fds.get(fd);
      if (!e || (e.kind !== 'dir' && e.kind !== 'preopen')) return E.BADF;
      const dir = e.kind === 'preopen' ? '' : e.path;
      if ((effMode(s, dir) & 4) === 0) return E.ACCES;
      const prefix = dir ? dir + '/' : '';
      const seen = new Set(['.', '..']);
      const children: Array<{ name: string; type: number }> = [];
      const push = (name: string, type: number) => { if (!seen.has(name)) { seen.add(name); children.push({ name, type }); } };
      for (const p of s.fs.dirs) {
        if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) push(p.slice(prefix.length), 3);
      }
      for (const p of s.fs.files.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) push(p.slice(prefix.length), 4);
      }
      for (const p of s.fs.symlinks.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) push(p.slice(prefix.length), 7);
      }
      for (const p of s.fs.modes.keys()) {  // modes-only inodes (unreadable files)
        if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && !s.fs.dirs.has(p)) push(p.slice(prefix.length), 4);
      }
      if (dir === 'bin' || dir === 'usr/bin') for (const name of s.coreutils.keys()) push(name, 4);
      children.sort((a, b) => (a.name < b.name ? -1 : 1));
      const entries = [{ name: '.', type: 3 }, { name: '..', type: 3 }, ...children];
      const dv = DV(), u8 = U8();
      let off = 0;
      for (let i = Number(cookie); i < entries.length; i++) {
        const nb = te.encode(entries[i].name);
        const need = 24 + nb.length;
        const record = new Uint8Array(need);
        const rdv = new DataView(record.buffer);
        rdv.setBigUint64(0, BigInt(i + 1), true);   // d_next: cookie of the next entry
        rdv.setBigUint64(8, 1n, true);              // d_ino
        rdv.setUint32(16, nb.length, true);         // d_namlen
        record[20] = entries[i].type;               // d_type
        record.set(nb, 24);
        const room = bufLen - off;
        if (need > room) {                          // truncated tail: "more remain"
          u8.set(record.subarray(0, room), buf + off);
          off = bufLen;
          break;
        }
        u8.set(record, buf + off);
        off += need;
      }
      dv.setUint32(retPtr, off, true);
      return 0;
    },
    // An fd that was never opened is EBADF everywhere below. It used to be
    // ESPIPE from fd_seek and plain SUCCESS from fd_tell and fd_filestat_get,
    // while fd_close, fd_fdstat_get and fd_write in this same table already
    // answered EBADF — one descriptor table, five different opinions about what
    // a closed descriptor is. ESPIPE in particular is a yes: it means "open, and
    // not seekable", so a caller using lseek to test validity read it as valid.
    fd_seek: (fd, offset, whence, retPtr) => {
      const e = proc.fds.get(fd);
      if (!e) return E.BADF;
      if (e.kind === 'file') {
        const f = fileLookup(s, e.path); const len = f ? f.bytes.length : 0;
        const off = Number(offset);
        const next = whence === 0 ? off : whence === 1 ? e.pos + off : len + off;
        if (next < 0) return E.INVAL;
        e.pos = next;
        DV().setBigUint64(retPtr, BigInt(next), true);
        return 0;
      }
      DV().setBigUint64(retPtr, 0n, true);
      return E.SPIPE;
    },
    fd_tell: (fd, retPtr) => {
      const e = proc.fds.get(fd);
      if (!e) return E.BADF;
      DV().setBigUint64(retPtr, BigInt(e.kind === 'file' ? e.pos : 0), true);
      return 0;
    },
    fd_close: (fd) => {
      if (!proc.fds.has(fd)) return E.BADF;
      closeFd(s, proc, fd);
      return 0;
    },
    fd_fdstat_get: (fd, st) => {
      const dv = DV(); const e = proc.fds.get(fd);
      let ft = 4;
      if (e && e.kind === 'pipe') ft = 0;
      else if (e && (e.kind === 'stdin' || e.kind === 'stdout' || e.kind === 'stderr')) ft = s.stdinTty || fd !== 0 ? 2 : 0;
      else if (e && e.kind === 'tty') ft = 2;
      else if (e && (e.kind === 'dir' || e.kind === 'preopen')) ft = 3;
      else if (!e) return E.BADF;
      dv.setUint8(st, ft);
      dv.setUint16(st + 2, 0, true);
      dv.setBigUint64(st + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(st + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_read: (fd, iovs, n, nread) => io.read(fd, readIovs(DV(), iovs, n), nread),
    fd_write: (fd, iovs, n, nw) => {
      if (!proc.fds.has(fd)) return E.BADF;
      const dv = DV(), u8 = U8(); let w = 0;
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(iovs + i * 8, true), l = dv.getUint32(iovs + i * 8 + 4, true);
        const n2 = io.write(fd, u8.subarray(p, p + l));
        if (n2 === null) return E.BADF;
        w += n2;
      }
      dv.setUint32(nw, w, true);
      return 0;
    },
    poll_oneoff: (inPtr, outPtr, nsubs, retPtr) => io.poll(inPtr, outPtr, nsubs, retPtr),
    clock_time_get: (id, _pr, t) => {
      const ns = clockNs(id);
      if (ns === null) return E.INVAL;
      DV().setBigUint64(t, ns, true);
      return 0;
    },
    clock_res_get: (id, r) => {
      if (clockNs(id) === null) return E.INVAL;
      DV().setBigUint64(r, id === CLOCK_REALTIME ? 1000000n : 1000n, true);
      return 0;
    },
    // getRandomValues caps at 65536 bytes per call; a guest asking for more
    // gets the same CSPRNG, chunked, never a weaker one.
    random_get: (b, l) => {
      const u = U8();
      for (let off = 0; off < l; off += 65536) {
        crypto.getRandomValues(u.subarray(b + off, b + off + Math.min(l - off, 65536)));
      }
      return 0;
    },
    proc_exit: (code) => { throw new Exit(code); },
  };
}

// Route a write through the process fd table. The caller has already rejected
// an fd the table does not hold, so every branch here answers a real entry —
// an unknown fd must never land in the user's terminal.
function writeThroughFd(s: BashSession, proc: BashProc, fd: number, bytes: Uint8Array): number | null {
  const e = proc.fds.get(fd);
  if (e && e.kind === 'pipe') {
    // A pipe descriptor has a direction, and it was recorded and never read.
    // Writing to the READ end used to push bytes into the pipe and report them
    // written, so `exec 3< …; echo x >&3` fed the reader its own output — data
    // appearing from nowhere, attributed to the wrong writer, with no error
    // anywhere. POSIX makes the direction part of the descriptor: EBADF.
    if (e.end === 'r') return null;
    const pp = s.pipes.get(e.pipeId) as BashPipe;
    pp.chunks.push(bytes.slice()); pp.queued += bytes.length;
    wakePipe(s, pp);
    return bytes.length;
  }
  if (e && e.kind === 'file') {
    const f = fileLookup(s, e.path) || { bytes: new Uint8Array(0) };
    if (!s.fs.files.has(e.path)) s.fs.files.set(e.path, f);
    const pos = e.append ? f.bytes.length : e.pos;
    fileWrite(s, f, e.path, pos, bytes);
    e.pos = pos + bytes.length;
    return bytes.length;
  }
  if (e && (e.kind === 'null' || e.kind === 'tty')) return bytes.length;
  const text = td.decode(bytes);
  if ((e as BashFdEntry).kind === 'stderr') s.err += text;
  else s.out += text;
  return bytes.length;
}

// Synchronous read for non-parking consumers (files, buffered pipes).
// Returns {errno} or null when the source would block.
function tryReadFd(
  s: BashSession, proc: BashProc, fd: number, dv: DataView, u8: Uint8Array,
  iov: BashIovs, nreadPtr: number,
): { errno: BashErrno } | null {
  const e = proc.fds.get(fd);
  const deliver = (bytes: Uint8Array): { errno: BashErrno } => { dv.setUint32(nreadPtr, scatter(u8, iov, bytes), true); return { errno: 0 }; };
  if (e && e.kind === 'file') {
    const f = fileLookup(s, e.path);
    const bytes = f ? f.bytes.subarray(e.pos, e.pos + iov.total) : new Uint8Array(0);
    e.pos += bytes.length;
    return deliver(bytes);
  }
  if (e && (e.kind === 'null' || e.kind === 'tty')) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
  if (e && e.kind === 'pipe') {
    const pp = s.pipes.get(e.pipeId) as BashPipe;
    if (pp.queued > 0) return deliver(takeUpTo(pp, iov.total));
    if (pp.writers === 0) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
    return null;
  }
  if (e && e.kind === 'stdin') {
    const st = s.stdin;
    if (st.queued > 0) return deliver(takeUpTo(st, iov.total));
    if (st.closed) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
    return null;
  }
  if (e) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
  return { errno: E.BADF };
}

// Subscription record: 48B, userdata u64 at +0, tag u8 at +8. A CLOCK carries
// id u32 at +16, timeout u64 at +24, flags u16 at +40 (bit 0 = ABSTIME); an
// FD_READ/FD_WRITE carries the fd u32 at +16.
function readSubs(dv: DataView, inPtr: number, nsubs: number): BashPollSub[] {
  const subs: BashPollSub[] = [];
  for (let i = 0; i < nsubs; i++) {
    const base = inPtr + i * 48;
    const userdata = dv.getBigUint64(base, true);
    const tag = dv.getUint8(base + 8);
    if (tag === 0) {
      const id = dv.getUint32(base + 16, true);
      const timeout = dv.getBigUint64(base + 24, true);
      const abs = (dv.getUint16(base + 40, true) & 1) !== 0;
      const now = clockNs(id);
      // An unknown clock id cannot produce a deadline; the event reports
      // EINVAL rather than firing.
      subs.push(now === null
        ? { tag, userdata, id, bad: true }
        : { tag, userdata, id, deadline: abs ? timeout : now + timeout });
    } else {
      subs.push({ tag, userdata, fd: dv.getUint32(base + 16, true) });
    }
  }
  return subs;
}
function clockExpired(sub: BashPollSub): boolean {
  const now = clockNs(sub.id);
  return now !== null && now >= (sub.deadline as bigint);
}
function writeEvent(dv: DataView, outPtr: number, slot: number, sub: BashPollSub, errno: BashErrno, nbytes: number): void {
  const ev = outPtr + slot * 32;
  dv.setBigUint64(ev, sub.userdata, true);
  dv.setUint16(ev + 8, errno, true);
  dv.setUint8(ev + 10, sub.tag);
  dv.setBigUint64(ev + 16, BigInt(nbytes), true);
  dv.setUint16(ev + 24, 0, true);
}
// Readiness of an FD_READ subscription. FD_WRITE and anything on an fd this
// table does not hold are handled by the caller.
function fdReadReady(s: BashSession, proc: BashProc, fd: number | undefined): BashFdReadiness | null {
  const e = proc.fds.get(fd as number);
  if (!e) return null;
  if (e.kind === 'pipe') { const pp = s.pipes.get(e.pipeId) as BashPipe; return { ready: pp.queued > 0 || pp.writers === 0, avail: pp.queued }; }
  if (e.kind === 'stdin') return { ready: s.stdin.queued > 0 || s.stdin.closed, avail: s.stdin.queued };
  return { ready: true, avail: 0 };
}
// Emit every subscription that is ready right now. Returns the event count.
function emitReady(s: BashSession, proc: BashProc, dv: DataView, outPtr: number, subs: BashPollSub[]): number {
  let n = 0;
  for (const sub of subs) {
    if (sub.tag === 0) {
      if (sub.bad) { writeEvent(dv, outPtr, n++, sub, E.INVAL, 0); continue; }
      if (clockExpired(sub)) writeEvent(dv, outPtr, n++, sub, 0, 0);
      continue;
    }
    const st = fdReadReady(s, proc, sub.fd);
    if (!st) { writeEvent(dv, outPtr, n++, sub, E.BADF, 0); continue; }
    // FD_WRITE (tag 2) never blocks here: pipes and the output buffers accept
    // whatever is handed to them.
    if (sub.tag === 2 || st.ready) writeEvent(dv, outPtr, n++, sub, 0, st.avail);
  }
  return n;
}
// Spend a clock subscription's interval by running whatever else is runnable.
//
// It cannot be spent waiting. This facet's clock does not advance during
// synchronous execution — 50M spin iterations move both Date.now() and
// performance.now() by exactly 0ms, which is the platform's timing-attack
// mitigation rather than a quirk. A busy-wait therefore never terminates, and
// a poll that returns no events leaves the guest spinning on the same frozen
// clock. Running the scheduler is the only progress available; past that the
// deadline is reported as reached. A host whose clock does advance gets a real
// wait, and honouring one in-facet needs poll_oneoff to become async — that is
// the migration onto runtime/wasi-instance.ts, not something a synchronous
// implementation can express.
// FROZEN_PROBE is a measurement, not a timeout: if the clock has not moved by
// a single nanosecond after this many iterations, it is not going to.
const FROZEN_PROBE = 200000;
function waitForDeadline(s: BashSession, proc: BashProc, subs: BashPollSub[]): void {
  const clocks = subs.filter((x) => x.tag === 0 && !x.bad);
  if (!clocks.length) return;
  const startedNs = realtimeNs();
  let spins = 0;
  while (!clocks.some(clockExpired)) {
    if (s.rootExit !== null) return;
    if (subs.some((x) => x.tag === 1 && (fdReadReady(s, proc, x.fd) || { ready: true }).ready)) return;
    if (s.runnable.length) { pumpOne(s); continue; }
    if (++spins > FROZEN_PROBE && realtimeNs() === startedNs) return;
  }
}
// Report every live clock subscription as fired. Reached only once the wait
// above can make no further progress: the alternative is an eventless success,
// which poll_oneoff may not return and which a guest cannot act on.
function emitClocks(dv: DataView, outPtr: number, subs: BashPollSub[]): number {
  let n = 0;
  for (const sub of subs) if (sub.tag === 0 && !sub.bad) writeEvent(dv, outPtr, n++, sub, 0, 0);
  return n;
}

function blockTarget(s: BashSession, proc: BashProc, fd: number | undefined): BashBlockTarget | null {
  const e = proc.fds.get(fd as number);
  if (e && e.kind === 'pipe') return { list: (s.pipes.get(e.pipeId) as BashPipe).readW, wake: () => wakePipe(s, s.pipes.get(e.pipeId) as BashPipe) };
  if (e && e.kind === 'stdin') return { list: s.stdin.waiters, wake: () => wakeStdin(s) };
  return null;
}

// ── per-process bash instance ─────────────────────────────────────────
function makeProc(s: BashSession, pid: number, ppid: number, fds: Map<number, BashFdEntry>): BashProc {
  const proc = {
    pid, ppid, fds, inst: null, __s: s,
    ctx: { reason: null, rewinding: false, captureEnv: 0, ljEnv: 0, ljVal: 0, nextSlot: 0, resume: 0 },
    MAIN_BUF: 0, SLOT0: 0, pendingRead: null,
    slotByEnv: new Map(), freeSlots: [],
  } as unknown as BashProc;
  const DV = () => new DataView(proc.inst.exports.memory.buffer);
  const U8 = () => new Uint8Array(proc.inst.exports.memory.buffer);
  proc.DV = DV; proc.U8 = U8;
  const slotAddr = (i: number) => proc.SLOT0 + i * SLOT_SIZE;
  proc.slotAddr = slotAddr;
  const initHdr = (a: number, sz: number) => { const dv = DV(); dv.setUint32(a, a + 8, true); dv.setUint32(a + 4, a + sz, true); };
  proc.initHdr = initHdr;
  const wstr = (p: number, str: string) => { const b = te.encode(str); U8().set(b, p); return b.length; };
  const c = proc.ctx;

  const io: BashIo = {
    read: (fd, iov, nread) => {
      if (proc.pendingRead) {
        proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false;
        const pr = proc.pendingRead; proc.pendingRead = null;
        DV().setUint32(pr.nreadPtr, scatter(U8(), pr.iov, pr.bytes), true);
        return 0;
      }
      const dv = DV();
      const sync = tryReadFd(s, proc, fd, dv, U8(), iov, nread);
      if (sync) return sync.errno;
      // would block: asyncify-park until bytes/EOF arrive
      dv.setUint32(nread, 0, true);
      c.reason = 'blockread';
      c.pipeReq = { fd, iov, nreadPtr: nread };
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    write: (fd, bytes) => writeThroughFd(s, proc, fd, bytes),
    poll: (inPtr, outPtr, nsubs, retPtr) => {
      if (proc.pendingRead) {  // poll resume: report the fd readable
        proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false;
        const pr = proc.pendingRead; proc.pendingRead = null;
        const dv = DV();
        dv.setBigUint64(outPtr, pr.pollUserdata ?? 0n, true);
        dv.setUint16(outPtr + 8, 0, true);
        dv.setUint8(outPtr + 10, 1);  // eventtype fd_read
        dv.setBigUint64(outPtr + 16, BigInt(pr.bytes.length), true);
        dv.setUint16(outPtr + 24, 0, true);
        dv.setUint32(retPtr, 1, true);
        return 0;
      }
      const dv = DV();
      const subs = readSubs(dv, inPtr, nsubs);
      let emitted = emitReady(s, proc, dv, outPtr, subs);
      if (emitted > 0) { dv.setUint32(retPtr, emitted, true); return 0; }
      // Nothing ready. A blockable fd-read subscription parks the process so
      // the host can supply input; a clock-only wait has no such source and is
      // spent in-facet.
      const blockSub = subs.find((x) => x.tag === 1 && blockTarget(s, proc, x.fd));
      if (!blockSub) {
        waitForDeadline(s, proc, subs);
        emitted = emitReady(s, proc, dv, outPtr, subs) || emitClocks(dv, outPtr, subs);
        dv.setUint32(retPtr, emitted, true);
        return 0;
      }
      dv.setUint32(retPtr, 0, true);
      c.reason = 'blockread';
      c.pipeReq = { fd: blockSub.fd as number, iov: EMPTY_IOV, nreadPtr: 0, pollUserdata: blockSub.userdata };
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
  };

  const wasiBase = makeWasiFs(s, proc, DV, U8, io);
  const wasi: BashWasiImports = {
    ...wasiBase,
    args_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, s.argv.length, true); dv.setUint32(b, s.argv.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    args_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const a of s.argv) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, a); U8()[p++] = 0; } return 0; },
    environ_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, s.environ.length, true); dv.setUint32(b, s.environ.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    environ_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const v of s.environ) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, v); U8()[p++] = 0; } return 0; },
  };

  // Slot allocator. Each setjmp captures into a FRESH physical slot
  // (overwriting a slot in place while its snapshot is still a live
  // longjmp target corrupts the asyncify rewind — the exit-builtin's
  // jump_to_top_level recursion proved this). Correct recycling: a
  // re-setjmp of the SAME jmp_buf makes that buf's previous slot a dead
  // target (POSIX: only the most recent setjmp per buf is live), so we
  // return it to a FIFO free-list — reused only after other allocations
  // cycle through, never the just-freed address. This bounds slot use
  // for long interactive sessions (bash re-setjmps top_level per
  // command) without the in-place-overwrite hazard.
  const allocSlot = (env: number): number => {
    const prev = proc.slotByEnv.get(env);
    if (prev !== undefined) { proc.slotByEnv.delete(env); proc.freeSlots.push(prev); }
    let idx: number | undefined;
    if (proc.freeSlots.length > 1) idx = proc.freeSlots.shift();
    else if (c.nextSlot < NSLOT) idx = c.nextSlot++;
    else idx = proc.freeSlots.shift();
    if (idx === undefined) throw new Error('bash-runner: setjmp slot budget exceeded (' + NSLOT + ')');
    proc.slotByEnv.set(env, idx);
    return idx;
  };

  const nimbus_proc: BashProcImports = {
    setjmp: (env) => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return; }
      c.reason = 'capture'; c.captureEnv = env;
      const idx = allocSlot(env);
      const dv = DV(); dv.setInt32(env, idx, true); dv.setInt32(env + 4, 0, true);
      initHdr(slotAddr(idx), SLOT_SIZE);
      proc.inst.exports.asyncify_start_unwind(slotAddr(idx));
    },
    longjmp: (env, val) => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return; }
      c.reason = 'longjmp'; c.ljEnv = env; c.ljVal = val;
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
    },
    fork: () => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return c.resume; }
      c.reason = 'fork';
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    vfork: () => nimbus_proc.fork(),
    waitpid: (pid, statusPtr, _opt) => {
      if (c.rewinding) {
        proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false;
        if (c.waitStatusPtr != null) DV().setInt32(c.waitStatusPtr, c.resumeStatus, true);
        return c.resume;
      }
      c.reason = 'waitpid'; c.waitTarget = pid; c.waitStatusPtr = statusPtr;
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    execve: (pathPtr, argvFlatPtr, argvLen, envFlatPtr, envLen) => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return c.resume; }
      const u8 = U8();
      let e = pathPtr; while (u8[e]) e++;
      c.reason = 'exec';
      c.execPath = td.decode(u8.subarray(pathPtr, e));
      c.execArgv = td.decode(u8.subarray(argvFlatPtr, argvFlatPtr + argvLen)).split('\0').filter((x) => x.length);
      // The child's REAL environment (bash's export set at exec time —
      // PWD tracks the shell's cd, unlike the boot-time s.environ).
      c.execEnv = td.decode(u8.subarray(envFlatPtr, envFlatPtr + envLen)).split('\0').filter((x) => x.length);
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    pipe: (fdsPtr) => {
      const id = newPipe(s);
      const rfd = lowestFd(proc); proc.fds.set(rfd, { kind: 'pipe', pipeId: id, end: 'r' });
      const wfd = lowestFd(proc); proc.fds.set(wfd, { kind: 'pipe', pipeId: id, end: 'w' });
      const dv = DV(); dv.setInt32(fdsPtr, rfd, true); dv.setInt32(fdsPtr + 4, wfd, true);
      return 0;
    },
    dup: (o) => {
      const e = proc.fds.get(o); if (!e) return -E.BADF;
      const nf = lowestFd(proc); proc.fds.set(nf, { ...e });
      if (e.kind === 'pipe') bumpPipe(s, e, 1);
      return nf;
    },
    dup2: (o, n) => {
      const e = proc.fds.get(o); if (!e) return -E.BADF;
      if (o === n) return n;
      if (proc.fds.has(n)) closeFd(s, proc, n);
      proc.fds.set(n, { ...e });
      if (e.kind === 'pipe') bumpPipe(s, e, 1);
      return n;
    },
    kill: () => 0, setpgid: () => 0, getpgid: () => proc.pid, getppid: () => proc.ppid,
    tcsetpgrp: () => 0, tcgetpgrp: () => proc.pid, tcgetattr: () => -1, tcsetattr: () => 0,
  };
  const envImports = {
    getpid: () => proc.pid, getuid: () => 0, geteuid: () => 0, getgid: () => 0, getegid: () => 0,
    setuid: () => 0, setgid: () => 0, umask: () => 0o22,
    gethostname: (p: number, _l: number) => { U8().set(te.encode('nimbus'), p); return 0; },
    dlopen: () => 0, dlsym: () => 0, dlclose: () => 0, dlerror: () => 0,
  };
  proc.inst = new WebAssembly.Instance(s.mod, { wasi_snapshot_preview1: wasi, nimbus_proc, env: envImports }) as BashInstance;
  s.stats.instances++;
  s.procs.set(pid, proc);
  return proc;
}

function setupArena(proc: BashProc): void {
  const base = proc.inst.exports.memory.buffer.byteLength;
  const need = MAIN_SIZE + NSLOT * SLOT_SIZE;
  proc.inst.exports.memory.grow(Math.ceil(need / PAGE));
  proc.MAIN_BUF = base;
  proc.SLOT0 = proc.MAIN_BUF + MAIN_SIZE;
}

// ── scheduler ─────────────────────────────────────────────────────────
function resumeProc(proc: BashProc): void {
  proc.ctx.rewinding = true;
  proc.inst.exports.asyncify_start_rewind(proc.MAIN_BUF);
  proc.__s.runnable.push(proc);
}

function trackArena(s: BashSession, proc: BashProc, bufAddr: number, size: number, isSlot: boolean): void {
  const used = proc.DV().getUint32(bufAddr, true) - (bufAddr + 8);
  if (isSlot) { if (used > s.stats.slotHi) s.stats.slotHi = used; }
  else if (used > s.stats.mainHi) s.stats.mainHi = used;
}

function step(s: BashSession, proc: BashProc): void {
  const c = proc.ctx, ex = proc.inst.exports;
  try { ex._start(); }
  catch (e) {
    if (e instanceof Exit) { finishProc(s, proc, e.code); return; }
    throw e;
  }
  if (c.reason === null) { finishProc(s, proc, 0); return; }
  ex.asyncify_stop_unwind();
  const r = c.reason; c.reason = null;
  const dv = proc.DV();
  const mem = proc.inst.exports.memory.buffer.byteLength;
  if (mem > s.stats.memPeak) s.stats.memPeak = mem;
  if (r === 'capture') {
    const idx = dv.getInt32(c.captureEnv, true);
    trackArena(s, proc, proc.slotAddr(idx), SLOT_SIZE, true);
    dv.setUint32(c.captureEnv + 8, dv.getUint32(proc.slotAddr(idx), true), true);
    c.rewinding = true;
    ex.asyncify_start_rewind(proc.slotAddr(idx));
    s.runnable.push(proc);
  } else if (r === 'longjmp') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    const idx = dv.getInt32(c.ljEnv, true), hw = dv.getUint32(c.ljEnv + 8, true);
    dv.setInt32(c.ljEnv + 4, c.ljVal, true);
    dv.setUint32(proc.slotAddr(idx), hw, true);
    c.rewinding = true;
    ex.asyncify_start_rewind(proc.slotAddr(idx));
    s.runnable.push(proc);
  } else if (r === 'fork') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    doFork(s, proc);
  } else if (r === 'waitpid') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    doWait(s, proc);
  } else if (r === 'blockread') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    const target = blockTarget(s, proc, c.pipeReq.fd);
    if (!target) {  // fd closed under us: deliver EOF
      proc.pendingRead = { iov: c.pipeReq.iov, bytes: new Uint8Array(0), nreadPtr: c.pipeReq.nreadPtr, pollUserdata: c.pipeReq.pollUserdata };
      resumeProc(proc);
    } else {
      target.list.push({ proc });
      target.wake();
    }
  } else if (r === 'exec') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    doExec(s, proc);
  } else {
    throw new Error('bash-runner: unknown unwind reason ' + r);
  }
}

function pumpOne(s: BashSession): boolean {
  if (!s.runnable.length) return false;
  step(s, s.runnable.shift() as BashProc);
  return true;
}

// exec re-homes the forked child onto a staged plain-WASI coreutil
// bound to the process fd table (M2 exec-into-runner, in-facet). The
// tool's blocking pipe reads synchronously pump the writer procs.
function doExec(s: BashSession, proc: BashProc): void {
  const name = proc.ctx.execPath.split('/').pop() as string;
  // The child inherits bash's LIVE cwd: bash keeps the exported PWD
  // current across cd, and the execve import threads the child env.
  const env = proc.ctx.execEnv && proc.ctx.execEnv.length ? proc.ctx.execEnv : s.environ;
  const pwdVar = env.find((x) => x.startsWith('PWD='));
  const childCwd = pwdVar ? norm(pwdVar.slice(4)) : s.cwd;
  const path = makeResolve(s, childCwd)(proc.ctx.execPath);
  // Applets dispatch only from the PATH dirs they are staged in — a user
  // file that happens to share an applet's name (./ls) is NOT the applet.
  const viaPath = path.startsWith('bin/') || path.startsWith('usr/bin/');
  const m = viaPath ? s.coreutils.get(name) : null;
  if (!m) {
    // wasi-libc errno numbering: EACCES=2, ENOENT=44, ENOEXEC=45. An
    // existing non-wasm file gets ENOEXEC so bash falls back to running
    // it as a shell script (execute_disk_command's ENOEXEC path); an
    // unreadable one gets EACCES.
    proc.ctx.resume = fileLookup(s, path) ? -45 : (fileExists(s, path) ? -2 : -44);
    proc.ctx.rewinding = true;
    proc.inst.exports.asyncify_start_rewind(proc.MAIN_BUF);
    s.runnable.push(proc);
    return;
  }
  let inst2: BashInstance;
  const DV = () => new DataView(inst2.exports.memory.buffer);
  const U8 = () => new Uint8Array(inst2.exports.memory.buffer);
  const tv = proc.ctx.execArgv;
  // Absolute argv paths (leading '/'), normalized to root-relative keys.
  // These recover the absolute-vs-relative bit the tool's wasi-libc drops
  // (see makeResolve): a path under one of these is never re-anchored.
  const absRoots = new Set<string>();
  for (let i = 1; i < tv.length; i++) if (tv[i].startsWith('/')) absRoots.add(norm(tv[i]));
  const wstr = (p: number, str: string) => { const b = te.encode(str); U8().set(b, p); return b.length; };
  let code = 0;
  const io: BashIo = {
    read: (fd, iov, nread) => {
      const dv = DV();
      for (;;) {
        const sync = tryReadFd(s, proc, fd, dv, U8(), iov, nread);
        if (sync) return sync.errno;
        // Would block: pump the scheduler so writer procs make progress.
        // When nothing is runnable the source can't produce more
        // synchronously (interactive stdin mid-exec) — deliver EOF.
        if (!pumpOne(s)) { dv.setUint32(nread, 0, true); return 0; }
      }
    },
    write: (fd, bytes) => writeThroughFd(s, proc, fd, bytes),
    // An exec'd tool cannot park, so a wait it cannot satisfy locally is spent
    // pumping the scheduler — the same discipline its blocking reads use.
    poll: (inPtr, outPtr, nsubs, retPtr) => {
      const dv = DV();
      const subs = readSubs(dv, inPtr, nsubs);
      let emitted = emitReady(s, proc, dv, outPtr, subs);
      if (emitted === 0) {
        waitForDeadline(s, proc, subs);
        emitted = emitReady(s, proc, dv, outPtr, subs) || emitClocks(dv, outPtr, subs);
      }
      dv.setUint32(retPtr, emitted, true);
      return 0;
    },
  };
  const base = makeWasiFs(s, proc, DV, U8, io, childCwd, absRoots);
  const w: BashWasiImports = {
    ...base,
    args_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, tv.length, true); dv.setUint32(b, tv.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    args_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const a of tv) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, a); U8()[p++] = 0; } return 0; },
    // POSIX environment inheritance: the child env bash passed to execve.
    environ_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, env.length, true); dv.setUint32(b, env.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    environ_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const v of env) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, v); U8()[p++] = 0; } return 0; },
    proc_exit: (ec) => { code = ec; throw new Exit(ec); },
  };
  // nimbus_proc.chmod: WASI preview1 has no mode syscall, so busybox's
  // chmod threads through this import. In-facet the effective-mode table
  // updates immediately (chmod +x → ./script runs); the durable, S2a
  // ownership-checked chmod happens at fsDiff flush.
  const chmodResolve = makeResolve(s, childCwd, absRoots);
  const nimbus_proc = {
    chmod: (pathPtr: number, pathLen: number, mode: number) => {
      const p = chmodResolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, p);
      if (trav) return trav;
      if (!inodeExists(s, p) && !(p !== '' && isDir(s, p))) return E.NOENT;
      const bits = mode & 0o777;
      s.fs.modes.set(p, (bits >> 6) & 7);
      s.fs.modesChanged.set(p, bits);
      return 0;
    },
  };
  inst2 = new WebAssembly.Instance(m, { wasi_snapshot_preview1: w, nimbus_proc }) as BashInstance;
  s.stats.instances++;
  const mem2 = inst2.exports.memory.buffer.byteLength;
  if (mem2 > s.stats.memPeak) s.stats.memPeak = mem2;
  try { inst2.exports._start(); }
  catch (e) { if (e instanceof Exit) code = e.code; else throw e; }
  finishProc(s, proc, code);
}

function doFork(s: BashSession, parent: BashProc): void {
  const childPid = s.pidNext++;
  const childFds = new Map();
  for (const [fd, e] of parent.fds) { childFds.set(fd, { ...e }); if (e.kind === 'pipe') bumpPipe(s, e, 1); }
  const child = makeProc(s, childPid, parent.pid, childFds);
  const pmem = parent.inst.exports.memory, cmem = child.inst.exports.memory;
  if (cmem.buffer.byteLength < pmem.buffer.byteLength) cmem.grow((pmem.buffer.byteLength - cmem.buffer.byteLength) / PAGE);
  new Uint8Array(cmem.buffer).set(new Uint8Array(pmem.buffer));
  for (const [k, v] of Object.entries(parent.inst.exports)) if (v instanceof WebAssembly.Global) (child.inst.exports[k] as WebAssembly.Global).value = v.value;
  child.MAIN_BUF = parent.MAIN_BUF; child.SLOT0 = parent.SLOT0;
  child.ctx.nextSlot = parent.ctx.nextSlot;
  child.slotByEnv = new Map(parent.slotByEnv);
  child.freeSlots = parent.freeSlots.slice();
  const total = s.procs.size;
  if (total * cmem.buffer.byteLength > s.stats.memPeak) s.stats.memPeak = total * cmem.buffer.byteLength;
  child.ctx.resume = 0; child.ctx.rewinding = true;
  child.inst.exports.asyncify_start_rewind(child.MAIN_BUF);
  s.runnable.push(child);
  parent.ctx.resume = childPid; parent.ctx.rewinding = true;
  parent.inst.exports.asyncify_start_rewind(parent.MAIN_BUF);
  s.runnable.push(parent);
}

function doWait(s: BashSession, proc: BashProc): void {
  const t = proc.ctx.waitTarget;
  let pid: number | null = null;
  if (t > 0) { if (s.exitStatus.has(t)) pid = t; }
  else { for (const [p] of s.exitStatus) { pid = p; break; } }
  if (pid != null) {
    const st = s.exitStatus.get(pid) as number; s.exitStatus.delete(pid);
    proc.ctx.resume = pid; proc.ctx.resumeStatus = st;
    resumeProc(proc);
  } else {
    s.waiters.push({ proc, targetPid: t });
  }
}

function finishProc(s: BashSession, proc: BashProc, code: number): void {
  const st = (code & 0xff) << 8;
  s.procs.delete(proc.pid);
  for (const fd of [...proc.fds.keys()]) closeFd(s, proc, fd);
  if (proc.ppid === 0) s.rootExit = code;
  s.exitStatus.set(proc.pid, st);
  for (let i = 0; i < s.waiters.length; i++) {
    const w = s.waiters[i];
    if (w.targetPid === proc.pid || w.targetPid <= 0) {
      s.waiters.splice(i, 1);
      w.proc.ctx.resume = proc.pid; w.proc.ctx.resumeStatus = st;
      s.exitStatus.delete(proc.pid);
      resumeProc(w.proc);
      break;
    }
  }
}

function composeFsDiff(s: BashSession): WasiFsDiff {
  const filesWritten: Record<string, string> = {};
  for (const path of s.fs.written) {
    if (path.startsWith('etc/nimbus.bashrc')) continue;
    const f = s.fs.files.get(path);
    if (f) filesWritten[path] = bytesToB64(f.bytes);
  }
  return {
    filesWritten,
    filesDeleted: [...s.fs.deleted],
    dirsCreated: [...s.fs.dirsCreated],
    // Deepest-first so the flush rmdirs children before their parents.
    dirsDeleted: [...s.fs.dirsDeleted].sort((a, b) => b.length - a.length),
    modesChanged: Object.fromEntries(s.fs.modesChanged),
    symlinksCreated: Object.fromEntries(s.fs.symlinksCreated),
  };
}

function pump(s: BashSession): BashSlice {
  try {
    while (s.runnable.length) {
      if (++s.steps > 5_000_000) throw new Error('bash-runner: runaway scheduler (>5M steps)');
      step(s, s.runnable.shift() as BashProc);
      if (s.rootExit !== null) break;
    }
  } catch (e) {
    s.error = String(e && (e as Error).stack || e && (e as Error).message || e);
  }
  const out = s.out, err = s.err;
  s.out = ''; s.err = '';
  const stats = { ...s.stats, steps: s.steps, missingWasi: [...s.missingWasi] };
  if (s.error) {
    S = null;
    return { state: 'error', exitCode: 1, stdout: out, stderr: err, error: s.error, stats };
  }
  if (s.rootExit !== null || s.procs.size === 0) {
    const code = s.rootExit === null ? 0 : s.rootExit;
    const fsDiff = composeFsDiff(s);
    S = null;
    return { state: 'exited', exitCode: code, stdout: out, stderr: err, fsDiff, stats };
  }
  if (s.stdin.waiters.length > 0) {
    return { state: 'need-input', exitCode: 0, stdout: out, stderr: err, stats };
  }
  S = null;
  return { state: 'error', exitCode: 1, stdout: out, stderr: err, error: 'bash-runner: deadlock — live procs with empty run queue', stats };
}

globalThis.__bashBoot = function __bashBoot(args: BashBootArgs): BashSlice {
  try {
    S = newSession(args);
    initStdinQueued(S);
    const root = makeProc(S, S.pidNext++, 0, new Map([
      [0, { kind: 'stdin' }], [1, { kind: 'stdout' }], [2, { kind: 'stderr' }],
      [3, { kind: 'preopen' }],
    ]));
    S.rootPid = root.pid;
    setupArena(root);
    S.runnable.push(root);
    return pump(S);
  } catch (e) {
    S = null;
    return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'boot failed: ' + String(e && (e as Error).message || e) };
  }
};

globalThis.__bashFeed = function __bashFeed(args: BashFeedArgs): BashSlice {
  if (!S) {
    return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash facet has no active session (warm isolate recycled?)' };
  }
  try {
    if (args.data) { const b = te.encode(args.data); S.stdin.chunks.push(b); S.stdin.queued += b.length; }
    if (args.eof) S.stdin.closed = true;
    wakeStdin(S);
    return pump(S);
  } catch (e) {
    const s = S; S = null;
    return { state: 'error', exitCode: 1, stdout: s ? s.out : '', stderr: s ? s.err : '', error: 'feed failed: ' + String(e && (e as Error).message || e) };
  }
};
