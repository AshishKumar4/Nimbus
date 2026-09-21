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
  BashExitStatus,
  BashFdEntry,
  BashFdReadiness,
  BashFeedArgs,
  BashIo,
  BashIovs,
  BashInstance,
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
import { after, filesystemErrno, installAuthorityFilesystem } from '../wasi/filesystem.js';
import { supervisorFilesystem } from '../vfs-supervisor.js';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../constants.js';
import type { RuntimeFsBridge, RuntimeFsPath, RuntimeSynchronousFs } from '../os-contracts.js';
import type { SyscallResult, WasiSupervisorStub } from '../wasi/types.js';

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

let S: BashSession | null = null;
let filesystem: RuntimeFsBridge | null = null;

function norm(p: string): string {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
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

  if (!filesystem) throw new Error('bash requires a process filesystem capability');
  const cwd = args.cwd;
  return {
    mod, coreutils, coreutilsRoot: norm(args.coreutilsRoot), fs: filesystem, cwd, cred: args.cred, parking: args.parking, pending: new Set(),
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
  // The entry is gone either way: a release that fails has still released
  // this process's claim on it, and letting the rejection reach s.error
  // would report the whole slice as failed instead of its exit code.
  if (e.kind === 'authority') queueSessionTask(s, Promise.resolve(s.fs.close(e.handle.id)).catch(() => {}));
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
    const w = pp.readW.shift();
    if (!w) break;
    if ('complete' in w) { w.complete(); continue; }
    const proc = w.proc; const req = proc.ctx.pipeReq;
    const bytes = pp.queued > 0 ? takeUpTo(pp, req.iov.total) : new Uint8Array(0);
    proc.pendingRead = { iov: req.iov, bytes, nreadPtr: req.nreadPtr, pollUserdata: req.pollUserdata };
    resumeProc(proc);
  }
}
function wakeStdin(s: BashSession): void {
  const st = s.stdin;
  while (st.waiters.length && (st.queued > 0 || st.closed)) {
    const w = st.waiters.shift();
    if (!w) break;
    if ('complete' in w) { w.complete(); continue; }
    const proc = w.proc; const req = proc.ctx.pipeReq;
    const bytes = st.queued > 0 ? takeUpTo(st, req.iov.total) : new Uint8Array(0);
    proc.pendingRead = { iov: req.iov, bytes, nreadPtr: req.nreadPtr, pollUserdata: req.pollUserdata };
    resumeProc(proc);
  }
}

function makeUnsupported(s: BashSession): BashUnsupportedImports {
  const nosys = (name: string) => (): BashErrno => { s.missingWasi.add(name); return E.NOSYS; };
  return {
    fd_sync: nosys('fd_sync'),
    fd_datasync: nosys('fd_datasync'),
    fd_advise: nosys('fd_advise'),
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
// wasi-libc resolves every relative path against the preopen descriptor it
// cached at startup, and `exec 3>file` lets bash claim that number. dup2
// re-homes the capability rather than destroying it, so a dirfd naming a
// displaced preopen is redirected to wherever it went — otherwise every later
// lookup answers ENOTDIR against the file bash put there.
function installPreopenRehoming(proc: BashProc, imports: BashWasiFsImports): void {
  const dirfd = (fd: number): number => proc.preopenMoved.get(fd) ?? fd;
  const prestat = imports.fd_prestat_get, prestatName = imports.fd_prestat_dir_name, fdstat = imports.fd_fdstat_get;
  imports.fd_prestat_get = (fd, out) => prestat(dirfd(fd), out);
  imports.fd_prestat_dir_name = (fd, out, cap) => prestatName(dirfd(fd), out, cap);
  imports.fd_fdstat_get = (fd, out) => fdstat(dirfd(fd), out);
  const open = imports.path_open, mkdir = imports.path_create_directory;
  const filestat = imports.path_filestat_get, times = imports.path_filestat_set_times;
  const unlink = imports.path_unlink_file, rename = imports.path_rename;
  const readlink = imports.path_readlink, symlink = imports.path_symlink;
  const link = imports.path_link, rmdir = imports.path_remove_directory;
  imports.path_open = (fd, lookup, ptr, length, flags, rights, inherit, status, out) => open(dirfd(fd), lookup, ptr, length, flags, rights, inherit, status, out);
  imports.path_create_directory = (fd, ptr, length) => mkdir(dirfd(fd), ptr, length);
  imports.path_filestat_get = (fd, flags, ptr, length, out) => filestat(dirfd(fd), flags, ptr, length, out);
  imports.path_filestat_set_times = (fd, flags, ptr, length, atim, mtim, fstflags) => times(dirfd(fd), flags, ptr, length, atim, mtim, fstflags);
  imports.path_unlink_file = (fd, ptr, length) => unlink(dirfd(fd), ptr, length);
  imports.path_rename = (fd, oldPtr, oldLen, to, newPtr, newLen) => rename(dirfd(fd), oldPtr, oldLen, dirfd(to), newPtr, newLen);
  imports.path_readlink = (fd, ptr, length, buf, bufLen, used) => readlink(dirfd(fd), ptr, length, buf, bufLen, used);
  imports.path_symlink = (oldPtr, oldLen, fd, newPtr, newLen) => symlink(oldPtr, oldLen, dirfd(fd), newPtr, newLen);
  imports.path_link = (fd, lookup, oldPtr, oldLen, to, newPtr, newLen) => link(dirfd(fd), lookup, oldPtr, oldLen, dirfd(to), newPtr, newLen);
  imports.path_remove_directory = (fd, ptr, length) => rmdir(dirfd(fd), ptr, length);
}

function makeWasiFs(s: BashSession, proc: BashProc, DV: () => DataView, U8: () => Uint8Array, io: BashIo, memory: () => WebAssembly.Memory, synchronous = false): BashWasiFsImports {
  const imports = {
    ...makeUnsupported(s),
    fd_prestat_get(fd: number, out: number) { const e = proc.fds.get(fd); if (e?.kind !== 'preopen') return E.BADF; DV().setUint8(out, 0); DV().setUint32(out + 4, te.encode(e.wasiPath).length, true); return 0; },
    fd_prestat_dir_name(fd: number, out: number, cap: number) { const e = proc.fds.get(fd); if (e?.kind !== 'preopen') return E.BADF; const bytes = te.encode(e.wasiPath); if (cap < bytes.length) return E.INVAL; U8().set(bytes, out); return 0; },
    fd_close(fd: number) { if (!proc.fds.has(fd)) return E.BADF; closeFd(s, proc, fd); return 0; },
    fd_renumber(from: number, to: number): BashErrno {
      const value = proc.fds.get(from);
      if (!value) return E.BADF;
      if (from === to) return 0;
      closeFd(s, proc, to);
      proc.fds.delete(from); proc.fds.set(to, value); return 0;
    },
    fd_seek(fd: number) { return proc.fds.has(fd) ? E.SPIPE : E.BADF; },
    fd_tell(fd: number) { return proc.fds.has(fd) ? E.SPIPE : E.BADF; },
    fd_filestat_get(fd: number, out: number) { const e = proc.fds.get(fd); if (!e) return E.BADF; U8().fill(0, out, out + 64); DV().setUint8(out + 16, e.kind === 'pipe' ? 0 : 2); DV().setBigUint64(out + 24, 1n, true); return 0; },
    fd_fdstat_get(fd: number, out: number) { const e = proc.fds.get(fd); if (!e) return E.BADF; U8().fill(0,out,out+24); DV().setUint8(out, e.kind === 'pipe' ? 0 : 2); DV().setBigUint64(out+8, 0x1fffffffn, true); DV().setBigUint64(out+16, 0x1fffffffn, true); return 0; },
    fd_fdstat_set_flags(fd: number, flags: number) { return !proc.fds.has(fd) ? E.BADF : flags === 0 ? 0 : E.NOSYS; },
    fd_read: (fd: number, p: number, n: number, out: number) => io.read(fd, readIovs(DV(),p,n),out),
    fd_write(fd: number, p: number, n: number, out: number) { if (!proc.fds.has(fd)) return E.BADF; let written = 0; for (const v of readIovs(DV(),p,n).list) { const count=io.write(fd,U8().subarray(v.ptr,v.ptr+v.len)); if (count === null) return E.BADF; written+=count; } DV().setUint32(out,written,true); return 0; },
    poll_oneoff: (p: number,q: number,n: number,out: number) => io.poll(p,q,n,out),
    clock_time_get(id: number,_precision: bigint,out: number) { const ns=clockNs(id); if(ns===null)return E.INVAL; DV().setBigUint64(out,ns,true);return 0; },
    clock_res_get(id: number,out: number) { if(clockNs(id)===null)return E.INVAL;DV().setBigUint64(out,id===CLOCK_REALTIME?1000000n:1000n,true);return 0; },
    random_get(p: number,n: number): BashErrno { for(let i=0;i<n;i+=65536)crypto.getRandomValues(U8().subarray(p+i,p+Math.min(i+65536,n)));return 0; },
    proc_exit(code: number) { throw new Exit(code); },
  };
  installAuthorityFilesystem(imports, { fs: () => s.fs, memory, fds: proc.fds, allocateFd: () => lowestFd(proc), synchronous, umask: () => s.cred.umask, residentBytes: WASI_RESIDENT_FILE_CAP_BYTES });
  installPreopenRehoming(proc, imports);
  return imports;
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
    pid, ppid, fds, preopenMoved: new Map(), cwd: s.cwd, inst: null, __s: s,
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
  function suspend<A extends (number | bigint)[]>(name: string, call: (...args: A) => number | Promise<number>): (...args: A) => number {
    return (...args) => {
      if (c.rewinding && proc.pendingFs?.name === name) {
        proc.inst.exports.asyncify_stop_rewind();
        c.rewinding = false;
        const value = proc.pendingFs.value;
        proc.pendingFs = undefined;
        if (value === undefined) throw new Error('Filesystem resumed before completion');
        return value;
      }
      const result = call(...args);
      if (!(result instanceof Promise)) return result;
      const pending = { name, settled: false, value: 0, promise: Promise.resolve() };
      pending.promise = result.then(value => { pending.value = value; pending.settled = true; }, error => { pending.value = filesystemErrno(error); pending.settled = true; });
      proc.pendingFs = pending;
      c.reason = 'filesystem';
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    };
  }

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

  const wasiBase = makeWasiFs(s, proc, DV, U8, io, () => proc.inst.exports.memory);
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

  const nimbus_proc: BashProcImports & {
    startup_cwd(ptr: number, capacity: number): number;
    capture_cwd(ptr: number, length: number): number;
  } = {
    startup_cwd: (ptr: number, capacity: number) => {
      const bytes = te.encode(proc.cwd);
      if (!capacity) return bytes.length;
      if (capacity <= bytes.length) return -37;
      U8().set(bytes, ptr); U8()[ptr + bytes.length] = 0; return bytes.length;
    },
    capture_cwd: (ptr: number, length: number) => { proc.cwd = td.decode(U8().subarray(ptr, ptr + length)); return 0; },
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
    // nimbus-proc.c reads these two as `errno = -r` on a negative return, so a
    // failure has to arrive negated; filesystemErrno's positive value would be
    // handed back to bash as a live descriptor.
    dup: suspend('dup', async (o: number) => {
      const e = proc.fds.get(o); if (!e) return -E.BADF;
      try {
        const nf = lowestFd(proc);
        proc.fds.set(nf, e.kind === 'authority' ? { ...e, handle: await s.fs.dup(e.handle.id) } : { ...e });
        if (e.kind === 'pipe') bumpPipe(s, e, 1);
        return nf;
      } catch (error) { return -filesystemErrno(error); }
    }),
    dup2: suspend('dup2', async (o: number, n: number) => {
      const e = proc.fds.get(o); if (!e) return -E.BADF;
      if (o === n) return n;
      try {
        // The old descriptor is released only once the duplicate exists, so a
        // failed dup2 leaves the target fd exactly as POSIX requires: untouched.
        const copy = e.kind === 'authority' ? { ...e, handle: await s.fs.dup(e.handle.id) } : { ...e };
        const displaced = proc.fds.get(n);
        if (displaced?.kind === 'preopen') {
          // `exec 3>file` claims the descriptor wasi-libc cached as its
          // namespace root. The number is bash's to take; the capability is
          // not, so it moves and every dirfd naming it follows.
          proc.fds.delete(n);
          const moved = lowestFd(proc);
          proc.fds.set(moved, displaced);
          for (const [from, to] of proc.preopenMoved) if (to === n) proc.preopenMoved.set(from, moved);
          proc.preopenMoved.set(n, moved);
        } else closeFd(s, proc, n);
        proc.fds.set(n, copy);
        if (e.kind === 'pipe') bumpPipe(s, e, 1);
        return n;
      } catch (error) { return -filesystemErrno(error); }
    }),
    kill: () => 0, setpgid: () => 0, getpgid: () => proc.pid, getppid: () => proc.ppid,
    tcsetpgrp: () => 0, tcgetpgrp: () => proc.pid, tcgetattr: () => -1, tcsetattr: () => 0,
  };
  const envImports = {
    getpid: () => proc.pid, getuid: () => s.cred.uid, geteuid: () => s.cred.uid, getgid: () => s.cred.gid, getegid: () => s.cred.gid,
    setuid: (uid: number) => uid === s.cred.uid ? 0 : -E.PERM,
    setgid: (gid: number) => gid === s.cred.gid ? 0 : -E.PERM,
    umask: (mode: number) => { const previous = s.cred.umask; s.cred = { ...s.cred, umask: mode & 0o777 }; return previous; },
    gethostname: (p: number, _l: number) => { U8().set(te.encode('nimbus'), p); return 0; },
    dlopen: () => 0, dlsym: () => 0, dlclose: () => 0, dlerror: () => 0,
  };
  const suspendedWasi = { ...wasi,
    fd_prestat_get: suspend('fd_prestat_get', wasi.fd_prestat_get),
    fd_prestat_dir_name: suspend('fd_prestat_dir_name', wasi.fd_prestat_dir_name),
    path_open: suspend('path_open', wasi.path_open),
    fd_filestat_get: suspend('fd_filestat_get', wasi.fd_filestat_get),
    path_filestat_get: suspend('path_filestat_get', wasi.path_filestat_get),
    path_filestat_set_times: suspend('path_filestat_set_times', wasi.path_filestat_set_times),
    path_unlink_file: suspend('path_unlink_file', wasi.path_unlink_file),
    path_rename: suspend('path_rename', wasi.path_rename),
    path_create_directory: suspend('path_create_directory', wasi.path_create_directory),
    path_readlink: suspend('path_readlink', wasi.path_readlink),
    path_symlink: suspend('path_symlink', wasi.path_symlink),
    path_link: suspend('path_link', wasi.path_link),
    path_remove_directory: suspend('path_remove_directory', wasi.path_remove_directory),
    fd_renumber: suspend('fd_renumber', wasi.fd_renumber),
    fd_readdir: suspend('fd_readdir', wasi.fd_readdir),
    fd_seek: suspend('fd_seek', wasi.fd_seek),
    fd_tell: suspend('fd_tell', wasi.fd_tell),
    fd_close: suspend('fd_close', wasi.fd_close),
    fd_fdstat_get: suspend('fd_fdstat_get', wasi.fd_fdstat_get),
    fd_fdstat_set_flags: suspend('fd_fdstat_set_flags', wasi.fd_fdstat_set_flags),
    fd_read: suspend('fd_read', wasi.fd_read),
    fd_write: suspend('fd_write', wasi.fd_write),
    poll_oneoff: suspend('poll_oneoff', wasi.poll_oneoff),
    clock_time_get: suspend('clock_time_get', wasi.clock_time_get),
    clock_res_get: suspend('clock_res_get', wasi.clock_res_get),
    random_get: suspend('random_get', wasi.random_get),
    fd_sync: suspend('fd_sync', wasi.fd_sync),
    fd_datasync: suspend('fd_datasync', wasi.fd_datasync),
    fd_advise: suspend('fd_advise', wasi.fd_advise),
    sched_yield: suspend('sched_yield', wasi.sched_yield),
    fd_pread: suspend('fd_pread', wasi.fd_pread),
    fd_pwrite: suspend('fd_pwrite', wasi.fd_pwrite),
    fd_allocate: suspend('fd_allocate', wasi.fd_allocate),
    fd_filestat_set_size: suspend('fd_filestat_set_size', wasi.fd_filestat_set_size),
    fd_filestat_set_times: suspend('fd_filestat_set_times', wasi.fd_filestat_set_times),
    fd_fdstat_set_rights: suspend('fd_fdstat_set_rights', wasi.fd_fdstat_set_rights),
    proc_raise: suspend('proc_raise', wasi.proc_raise),
    sock_send: suspend('sock_send', wasi.sock_send),
    sock_recv: suspend('sock_recv', wasi.sock_recv),
    sock_shutdown: suspend('sock_shutdown', wasi.sock_shutdown),
  };
  proc.inst = new WebAssembly.Instance(s.mod, { wasi_snapshot_preview1: suspendedWasi, nimbus_proc, env: envImports }) as BashInstance;
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
    queueSessionTask(s, doFork(s, proc));
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
    queueSessionTask(s, doExec(s, proc));
  } else if (r === 'filesystem') {
    const pending = proc.pendingFs;
    if (!pending) throw new Error('Missing suspended filesystem operation');
    queueSessionTask(s, pending.promise.then(() => { if (s.procs.has(proc.pid)) resumeProc(proc); }));
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
async function doExec(s: BashSession, proc: BashProc): Promise<void> {
  const path = proc.ctx.execPath.startsWith('/') ? proc.ctx.execPath : proc.cwd + '/' + proc.ctx.execPath;
  const key = norm(path);
  const name = key.split('/').pop() ?? '';
  const module = key.startsWith(s.coreutilsRoot + '/') ? s.coreutils.get(name) : undefined;
  if (!module) {
    try { await s.fs.access(path, 1); proc.ctx.resume = -45; }
    catch (error) { proc.ctx.resume = -filesystemErrno(error); }
    resumeProc(proc);
    return;
  }
  const canPark = s.parking === 'jspi';
  if (!canPark && !s.fs.synchronous) throw new Error('Plain WASI child requires JSPI for an asynchronous filesystem');
  let instance: WebAssembly.Instance | undefined;
  function memory(): WebAssembly.Memory {
    const value = instance?.exports.memory;
    if (!(value instanceof WebAssembly.Memory)) throw new Error('Child memory is unavailable');
    return value;
  }
  const DV = () => new DataView(memory().buffer);
  const U8 = () => new Uint8Array(memory().buffer);
  // A source that would block with nothing left to run is at end of input, not
  // an unimplemented syscall: without a parking transport no further bytes can
  // ever arrive, and POSIX spells that a zero-byte read, not an error.
  const waitInput = async (fd: number, iov: BashIovs, out: number): Promise<BashErrno> => {
    for (;;) {
      const ready = tryReadFd(s, proc, fd, DV(), U8(), iov, out);
      if (ready) return ready.errno;
      if (!canPark) {
        if (pumpOne(s)) continue;
        DV().setUint32(out, 0, true);
        return 0;
      }
      const target = blockTarget(s, proc, fd);
      if (!target) return E.BADF;
      await new Promise<void>(complete => { target.list.push({ complete }); target.wake(); });
    }
  };
  const io: BashIo = {
    read: (fd, iov, out) => {
      for (;;) {
        const ready = tryReadFd(s, proc, fd, DV(), U8(), iov, out);
        if (ready) return ready.errno;
        if (canPark) return waitInput(fd, iov, out);
        if (!pumpOne(s)) { DV().setUint32(out, 0, true); return 0; }
      }
    },
    write: (fd, bytes) => writeThroughFd(s, proc, fd, bytes),
    poll: (input, output, count, used) => {
      const subscriptions = readSubs(DV(), input, count);
      const ready = emitReady(s, proc, DV(), output, subscriptions);
      if (ready) { DV().setUint32(used, ready, true); return 0; }
      if (!canPark) {
        waitForDeadline(s, proc, subscriptions);
        DV().setUint32(used, emitReady(s, proc, DV(), output, subscriptions), true);
        return 0;
      }
      return (async (): Promise<BashErrno> => {
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 1));
          const count = emitReady(s, proc, DV(), output, subscriptions);
          if (count) { DV().setUint32(used, count, true); return 0; }
        }
      })();
    },
  };
  const argv = proc.ctx.execArgv;
  const env = proc.ctx.execEnv.length ? proc.ctx.execEnv : s.environ;
  const writeStrings = (values: string[], pointers: number, buffer: number) => {
    for (const value of values) { const bytes = te.encode(value); DV().setUint32(pointers, buffer, true); pointers += 4; U8().set(bytes, buffer); buffer += bytes.length; U8()[buffer++] = 0; }
    return 0;
  };
  const wasi = {
    ...makeWasiFs(s, proc, DV, U8, io, memory, !canPark),
    args_sizes_get: (a: number, b: number) => { DV().setUint32(a, argv.length, true); DV().setUint32(b, argv.reduce((n, v) => n + te.encode(v).length + 1, 0), true); return 0; },
    args_get: (a: number, b: number) => writeStrings(argv, a, b),
    environ_sizes_get: (a: number, b: number) => { DV().setUint32(a, env.length, true); DV().setUint32(b, env.reduce((n, v) => n + te.encode(v).length + 1, 0), true); return 0; },
    environ_get: (a: number, b: number) => writeStrings(env, a, b),
    proc_exit: (code: number): never => { throw new Exit(code); },
  };
  const fs = canPark ? s.fs : s.fs.synchronous;
  if (!fs) throw new Error('Synchronous authority is unavailable');
  const readPath = (ptr: number, length: number) => td.decode(U8().subarray(ptr, ptr + length));
  const at = (fd: number, path: string): RuntimeFsPath => {
    if (path.startsWith('/')) return path;
    if (fd === -1) return proc.cwd + '/' + path;
    // Same redirection the preview1 path imports apply: a dirfd the shell
    // claimed still names the root wasi-libc resolved it against.
    const entry = proc.fds.get(proc.preopenMoved.get(fd) ?? fd);
    if (entry?.kind === 'preopen') return entry.vfsPath + '/' + path;
    if (entry?.kind !== 'authority') throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    return { directory: entry.handle.id, path };
  };
  const descriptor = (fd: number) => { const entry = proc.fds.get(fd); if (entry?.kind !== 'authority') throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); return entry.handle.id; };
  // The call is produced inside the guard, not handed to it: resolving the fd
  // is itself a syscall step that can fail, and an EBADF raised while building
  // the arguments has to answer the guest as an errno rather than escape the
  // import and fail the whole session.
  const result = <T>(produce: () => T | Promise<T>, finish: (value: T) => number) => {
    try { const next = after(produce(), finish); return next instanceof Promise ? next.catch(filesystemErrno) : next; }
    catch (error) { return filesystemErrno(error); }
  };
  const native = {
    startup_cwd: (ptr: number, capacity: number) => { const bytes = te.encode(proc.cwd); if (!capacity) return bytes.length; if (capacity <= bytes.length) return -37; U8().set(bytes, ptr); U8()[ptr + bytes.length] = 0; return bytes.length; },
    identity: (field: number) => { if ((field & 7) === 4) { const previous = s.cred.umask; s.cred = { ...s.cred, umask: field >>> 3 }; return previous; } return [s.cred.uid, s.cred.gid, proc.pid, proc.ppid][field] ?? 0; },
    stat_metadata: (fd: number, ptr: number, length: number, follow: number, out: number) => result(() => ptr ? fs.stat(at(fd, readPath(ptr, length)), { followSymlinks: !!follow }) : fs.fstat(descriptor(fd)), stat => {
      if (!stat) return E.NOENT;
      DV().setUint32(out, stat.mode, true); DV().setUint32(out + 4, stat.uid, true); DV().setUint32(out + 8, stat.gid, true); return 0;
    }),
    chmod: (ptr: number, length: number, mode: number) => result(() => fs.chmod(at(-1, readPath(ptr, length)), mode), () => 0),
    fchmod: (fd: number, mode: number) => result(() => fs.fchmod(descriptor(fd), mode), () => 0),
    chown: (fd: number, ptr: number, length: number, uid: number, gid: number, follow: number) => result(() => ptr ? fs.chown(at(fd, readPath(ptr, length)), uid, gid, { followSymlinks: !!follow }) : fs.fchown(descriptor(fd), uid, gid), () => 0),
  };
  const imports = canPark ? {
    fd_prestat_get: new WebAssembly.Suspending(wasi.fd_prestat_get),
    fd_prestat_dir_name: new WebAssembly.Suspending(wasi.fd_prestat_dir_name),
    path_open: new WebAssembly.Suspending(wasi.path_open),
    fd_filestat_get: new WebAssembly.Suspending(wasi.fd_filestat_get),
    path_filestat_get: new WebAssembly.Suspending(wasi.path_filestat_get),
    path_filestat_set_times: new WebAssembly.Suspending(wasi.path_filestat_set_times),
    path_unlink_file: new WebAssembly.Suspending(wasi.path_unlink_file),
    path_rename: new WebAssembly.Suspending(wasi.path_rename),
    path_create_directory: new WebAssembly.Suspending(wasi.path_create_directory),
    path_readlink: new WebAssembly.Suspending(wasi.path_readlink),
    path_symlink: new WebAssembly.Suspending(wasi.path_symlink),
    path_link: new WebAssembly.Suspending(wasi.path_link),
    path_remove_directory: new WebAssembly.Suspending(wasi.path_remove_directory),
    fd_renumber: new WebAssembly.Suspending(wasi.fd_renumber),
    fd_readdir: new WebAssembly.Suspending(wasi.fd_readdir),
    fd_seek: new WebAssembly.Suspending(wasi.fd_seek),
    fd_tell: new WebAssembly.Suspending(wasi.fd_tell),
    fd_close: new WebAssembly.Suspending(wasi.fd_close),
    fd_fdstat_get: new WebAssembly.Suspending(wasi.fd_fdstat_get),
    fd_fdstat_set_flags: new WebAssembly.Suspending(wasi.fd_fdstat_set_flags),
    fd_read: new WebAssembly.Suspending(wasi.fd_read),
    fd_write: new WebAssembly.Suspending(wasi.fd_write),
    poll_oneoff: new WebAssembly.Suspending(wasi.poll_oneoff),
    clock_time_get: new WebAssembly.Suspending(wasi.clock_time_get),
    clock_res_get: new WebAssembly.Suspending(wasi.clock_res_get),
    random_get: new WebAssembly.Suspending(wasi.random_get),
    fd_sync: new WebAssembly.Suspending(wasi.fd_sync),
    fd_datasync: new WebAssembly.Suspending(wasi.fd_datasync),
    fd_advise: new WebAssembly.Suspending(wasi.fd_advise),
    sched_yield: new WebAssembly.Suspending(wasi.sched_yield),
    fd_pread: new WebAssembly.Suspending(wasi.fd_pread),
    fd_pwrite: new WebAssembly.Suspending(wasi.fd_pwrite),
    fd_allocate: new WebAssembly.Suspending(wasi.fd_allocate),
    fd_filestat_set_size: new WebAssembly.Suspending(wasi.fd_filestat_set_size),
    fd_filestat_set_times: new WebAssembly.Suspending(wasi.fd_filestat_set_times),
    fd_fdstat_set_rights: new WebAssembly.Suspending(wasi.fd_fdstat_set_rights),
    proc_raise: new WebAssembly.Suspending(wasi.proc_raise),
    sock_send: new WebAssembly.Suspending(wasi.sock_send),
    sock_recv: new WebAssembly.Suspending(wasi.sock_recv),
    sock_shutdown: new WebAssembly.Suspending(wasi.sock_shutdown),
    args_sizes_get: wasi.args_sizes_get, args_get: wasi.args_get,
    environ_sizes_get: wasi.environ_sizes_get, environ_get: wasi.environ_get, proc_exit: wasi.proc_exit,
  } : wasi;
  const nativeImports = canPark ? { ...native, stat_metadata: new WebAssembly.Suspending(native.stat_metadata), chmod: new WebAssembly.Suspending(native.chmod), fchmod: new WebAssembly.Suspending(native.fchmod), chown: new WebAssembly.Suspending(native.chown) } : native;
  instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: imports, nimbus_proc: nativeImports });
  const start = instance.exports._start;
  function isEntry(value: WebAssembly.ExportValue | undefined): value is (...args: never[]) => void { return typeof value === 'function'; }
  if (!isEntry(start)) throw new Error('WASI child has no _start export');
  let code = 0;
  try { if (canPark) await WebAssembly.promising(start)(); else start(); }
  catch (error) { if (error instanceof Exit) code = error.code; else throw error; }
  finishProc(s, proc, code);
}

async function doFork(s: BashSession, parent: BashProc): Promise<void> {
  const childPid = s.pidNext++;
  const childFds = new Map();
  for (const [fd, e] of parent.fds) {
    childFds.set(fd, e.kind === 'authority' ? { ...e, handle: await s.fs.dup(e.handle.id) } : { ...e });
    if (e.kind === 'pipe') bumpPipe(s, e, 1);
  }
  const child = makeProc(s, childPid, parent.pid, childFds);
  child.cwd = parent.cwd;
  child.preopenMoved = new Map(parent.preopenMoved);
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
  if (t > 0) {
    // A named target still has to be this process's child; reaping another
    // process's child by pid is the same error, just harder to reach.
    const e = s.exitStatus.get(t);
    if (e && e.ppid === proc.pid) pid = t;
  } else {
    // `wait` with no target reaps one of MY children. This used to take the
    // first entry in the map regardless of parentage, so with two subshells
    // each having had a child exit, one could consume the other's status —
    // and then block forever waiting for a child already reaped elsewhere.
    for (const [p, e] of s.exitStatus) { if (e.ppid === proc.pid) { pid = p; break; } }
  }
  if (pid != null) {
    const st = (s.exitStatus.get(pid) as BashExitStatus).status; s.exitStatus.delete(pid);
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
  s.exitStatus.set(proc.pid, { status: st, ppid: proc.ppid });
  for (let i = 0; i < s.waiters.length; i++) {
    const w = s.waiters[i];
    // Only the parent may be woken by this exit — a waiter in another subshell
    // is not waiting for this child, and waking it hands over a status that was
    // never its to claim.
    if (w.proc.pid === proc.ppid && (w.targetPid === proc.pid || w.targetPid <= 0)) {
      s.waiters.splice(i, 1);
      w.proc.ctx.resume = proc.pid; w.proc.ctx.resumeStatus = st;
      s.exitStatus.delete(proc.pid);
      resumeProc(w.proc);
      break;
    }
  }
}


function queueSessionTask(s: BashSession, task: Promise<void>): void {
  const pending = task.catch(error => { s.error = error instanceof Error ? error.message : String(error); });
  s.pending.add(pending);
  void pending.then(() => s.pending.delete(pending));
}

async function pump(s: BashSession): Promise<BashSlice> {
  try {
    while (s.runnable.length || s.pending.size) {
      if (!s.runnable.length) {
        if (s.stdin.waiters.length && !s.stdin.closed && s.stdin.queued === 0) break;
        await Promise.race(s.pending);
        continue;
      }
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
    await Promise.all(s.pending);
    S = null;
    return { state: 'exited', exitCode: code, stdout: out, stderr: err, stats };
  }
  if (s.stdin.waiters.length > 0) {
    return { state: 'need-input', exitCode: 0, stdout: out, stderr: err, stats };
  }
  S = null;
  return { state: 'error', exitCode: 1, stdout: out, stderr: err, error: 'bash-runner: deadlock — live procs with empty run queue', stats };
}

/**
 * The one step dispatch, shared by both transports the host can pick:
 * `facet.submit(bashFacetStep, args)` calls it with the args object
 * already decoded; `facet.submitRequest(bashRequestStep, request)`
 * reaches it through a JSON Request. Both go through this validation so
 * nothing but a boot/feed-shaped payload can reach the scheduler.
 */
globalThis.__bashStep = async function __bashStep(raw: unknown, supervisor?: WasiSupervisorStub): Promise<BashSlice> {
  if (typeof raw !== 'object' || raw === null || !('op' in raw)) {
    return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash-runner: step args must be an object with op' };
  }
  if (raw.op === 'feed') {
    const a = raw as { data?: unknown; eof?: unknown };
    if ((a.data !== undefined && typeof a.data !== 'string') || (a.eof !== undefined && typeof a.eof !== 'boolean')) {
      return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash-runner: malformed feed args' };
    }
    return globalThis.__bashFeed(raw as BashFeedArgs);
  }
  if (raw.op === 'boot') {
    const a = raw as { argv?: unknown; environ?: unknown; cwd?: unknown; parking?: unknown };
    if (!Array.isArray(a.argv) || !Array.isArray(a.environ) || typeof a.cwd !== 'string') {
      return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash-runner: malformed boot args' };
    }
    // A synchronous view exists only in the isolate that owns the filesystem,
    // which is where a guest that cannot park runs; across a hop the stub
    // answers the property with a callable, so it is read only for that host.
    if (supervisor) filesystem = supervisorFilesystem(supervisor, a.parking === 'none' ? supervisor.synchronous : undefined);
    return globalThis.__bashBoot(raw as BashBootArgs);
  }
  return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: `bash-runner: unknown step op ${JSON.stringify(raw.op)}` };
};

globalThis.__bashBoot = async function __bashBoot(args: BashBootArgs): Promise<BashSlice> {
  try {
    S = newSession(args);
    initStdinQueued(S);
    const root = makeProc(S, S.pidNext++, 0, new Map([
      [0, { kind: 'stdin' }], [1, { kind: 'stdout' }], [2, { kind: 'stderr' }],
      [3, { kind: 'preopen', vfsPath: '/', wasiPath: '/' }],
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

globalThis.__bashFeed = async function __bashFeed(args: BashFeedArgs): Promise<BashSlice> {
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
