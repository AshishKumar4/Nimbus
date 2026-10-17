import { after, closeResident, descriptorNamed, installAuthorityFilesystem, processGoneMessage, refusalErrno, shareResident } from '../wasi/filesystem.js';
import { supervisorFilesystem } from '../vfs-supervisor.js';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../constants.js';
import { PIPE_CAPACITY, decideRead, decideWrite, heldExitSettles, holdsExit, pipeBudget, pipeLimitMessage, readerStops } from './pipe-rules.js';
import { wasiOutputRelay } from '../wasi/stdio.js';
import { outputControlReader } from '../wasi/output-control.js';
import { clockNs, clockResolutionNs, realtimeNs } from '../wasi/clock.js';
import { unixGroups, unixUsers } from '../../shell/unix-accounts.js';
import { ARENA_SIZE, CaptureStore } from './capture-store.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { nameDec } from '../../_shared/bytes.js';
const PAGE = 65536, te = new TextEncoder(), td = new TextDecoder();
const E = { ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, LOOP: 32, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, PIPE: 64, RANGE: 68, SPIPE: 70, SRCH: 71 };
class Exit {
    constructor(c) { this.code = c; }
}
/** A process killed by a signal's default action: SIGPIPE, a write to a pipe no one can read. */
class Signalled {
    constructor(signal) { this.signal = signal; }
}
const SIGPIPE = 13;
/** The answer writeGate gives when the bash process unwound to park its write. */
const WRITE_UNWOUND = Symbol('write-unwound');
/**
 * Without JSPI a synchronous WASI child cannot wait: the command fails, with
 * this, rather than lose data or report a false end of input.
 */
function pipeLimitExceeded(s) { return new Error(pipeLimitMessage(s.pipeBudget)); }
const pipeHost = (s) => (s.parking === 'jspi' ? 'jspi' : 'local');
let S = null;
let filesystem = null;
let outputSupervisor = null;
let inputSupervisor = null;
function norm(p) {
    const parts = [];
    for (const seg of String(p).split('/')) {
        if (!seg || seg === '.')
            continue;
        if (seg === '..') {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return parts.join('/');
}
function newSession(args) {
    const wasmTable = globalThis.__NIMBUS_WASM || {};
    const mod = wasmTable['bash.async.wasm'];
    if (!mod)
        throw new Error('bash.async.wasm missing from __NIMBUS_WASM');
    const coreutils = new Map();
    for (const key of Object.keys(wasmTable)) {
        if (key.startsWith('cu_') && key.endsWith('.wasm'))
            coreutils.set(key.slice(3, -5), wasmTable[key]);
    }
    // Applet aliasing: ONE staged busybox module answers to every applet
    // name (busybox dispatches on argv[0]), so bash's PATH lookup finds
    // ls/cat/grep/... as executables in /bin.
    const busybox = wasmTable['cu_busybox.wasm'];
    if (busybox)
        for (const name of args.busyboxApplets || [])
            coreutils.set(name, busybox);
    if (!filesystem)
        throw new Error('bash requires a process filesystem capability');
    const cwd = args.cwd;
    const outputControl = args.outputControls?.length ? outputControlReader(args.outputControls) : null;
    const target = outputSupervisor;
    if (!target)
        throw new Error('bash requires a process stdio capability');
    const session = {
        mod, coreutils, coreutilsRoot: norm(args.coreutilsRoot), fs: filesystem, cwd, cred: args.cred, parking: args.parking, pipeBudget: pipeBudget(args.memoryBudgetBytes), pending: new Set(),
        argv: args.argv, environ: args.environ,
        stdin: { chunks: args.stdinData ? [te.encode(args.stdinData)] : [], queued: 0, closed: !!args.stdinClosed, waiters: [] },
        processPid: args.processPid || 0, sharedInput: args.sharedInput === true,
        procs: new Map(), idle: [], pipes: new Map(), runnable: [], deferred: [], wake: null, suspended: new Set(), exitStatus: new Map(), heldExits: new Map(), waiters: [],
        pidNext: 100, pipeNext: 1, rootExit: null, steps: 0,
        outputControl,
        output: wasiOutputRelay({ stdout: bytes => target.stdout(bytes), stderr: bytes => { const data = outputControl ? outputControl.feed(bytes) : bytes; if (data.length)
                return target.stderr(data); } }),
        missingWasi: new Set(),
        stats: { instances: 0, reused: 0, memPeak: 0, mainHi: 0, captureBytesHi: 0, captureCompactions: 0, captureLiveHi: 0, forkCopied: 0 },
        error: null,
        processGone: null,
        gone: (refusal) => { session.processGone ??= refusal; },
    };
    return session;
}
function initStdinQueued(s) { s.stdin.queued = s.stdin.chunks.reduce((a, c) => a + c.length, 0); }
function newPipe(s) { const id = s.pipeNext++; s.pipes.set(id, { chunks: [], queued: 0, readers: 1, writers: 1, readW: [], writeW: [] }); return id; }
/** The pipe `fd` writes to, when it is a pipe's write end. */
function writePipe(s, proc, fd) {
    const e = proc.fds.get(fd);
    return e && e.kind === 'pipe' && e.end === 'w' ? s.pipes.get(e.pipeId) : null;
}
/** The pids holding a write end of pipe `pipeId`. */
function pipeWriterPids(s, pipeId) {
    const pids = [];
    for (const proc of s.procs.values()) {
        for (const e of proc.fds.values()) {
            if (e.kind === 'pipe' && e.end === 'w' && e.pipeId === pipeId) {
                pids.push(proc.pid);
                break;
            }
        }
    }
    return pids;
}
/** Without JSPI: run what can run, nested, with `proc` marked suspended beneath it. */
function pumpSuspended(s, proc) {
    s.suspended.add(proc.pid);
    try {
        return pumpOne(s);
    }
    finally {
        s.suspended.delete(proc.pid);
    }
}
/** With JSPI, a writer to this pipe must wait (pipe-rules decideWrite: 'park'). */
function atCapacity(pp) { return decideWrite(pp, 0, 'jspi', PIPE_CAPACITY, Infinity) === 'park'; }
/** Wake the writers a drained pipe, or one whose last read end closed, lets through. */
function wakeWriters(pp) {
    while (pp.writeW.length && !atCapacity(pp)) {
        const w = pp.writeW.shift();
        if (!w)
            break;
        if ('complete' in w) {
            w.complete();
            continue;
        }
        w.proc.writeResumed = true;
        resumeProc(w.proc);
    }
}
// fd 3 is the wasi-libc '/' preopen. It lives in the fd table as a
// real 'preopen' entry: wasi-libc's path ops fd_fdstat_get the dirfd
// to compute inherited rights, so it must answer (not EBADF), and
// lowestFd must never re-issue it for a regular file.
/**
 * Whether a descriptor the host answers for is a FIFO: a pipe, and stdin
 * that is not a terminal (a pipe's or a redirect's bytes). WASI has no FIFO
 * filetype (unknown, as wasmtime says too); stat_metadata's mode does. The
 * terminal's stdin and the output streams are character devices.
 */
function hostFifo(e) { return e.kind === 'pipe' || (e.kind === 'stdin' && !e.terminal); }
function lowestFd(proc) { let fd = 0; while (proc.fds.has(fd) || fd === 3)
    fd++; return fd; }
function bumpPipe(s, e, d) { const pp = s.pipes.get(e.pipeId); if (e.end === 'r')
    pp.readers += d;
else
    pp.writers += d; }
/**
 * What a second descriptor on entry `e` holds (dup, dup2, a fork's copy), for
 * any kind but an authority file's (the authority's own dup): the same open,
 * as dup(2) shares an open file description and its offset. A resident copy
 * is shared; a pipe end's count is the caller's to bump. At once, with no
 * await: a fork's pipe ends are counted before anything else runs.
 */
function shareEntry(e) {
    return e.kind === 'resident' ? shareResident(e) : { ...e };
}
/** A new descriptor on what `proc`'s stream or pipe descriptor `fd` holds, as dup(2); null for any other kind (AuthorityFilesystemOptions.duplicate). */
function duplicateStream(s, proc, fd) {
    const e = proc.fds.get(fd);
    if (e === undefined || (e.kind !== 'pipe' && e.kind !== 'stdin' && e.kind !== 'stdout' && e.kind !== 'stderr'))
        return null;
    const copy = { ...e };
    const next = lowestFd(proc);
    proc.fds.set(next, copy);
    if (copy.kind === 'pipe')
        bumpPipe(s, copy, 1);
    return next;
}
function closeFd(s, proc, fd) {
    const e = proc.fds.get(fd);
    if (!e)
        return;
    proc.fds.delete(fd);
    releaseEntry(s, e);
}
/** A descriptor's claim on what it holds, given up. */
function releaseEntry(s, e) {
    // The entry is gone either way: a release that fails has still released
    // this process's claim on it, and letting the rejection reach s.error
    // would report the whole slice as failed instead of its exit code.
    if (e.kind === 'authority')
        queueSessionTask(s, Promise.resolve(s.fs.close(e.handle.id)).catch(() => { }));
    if (e.kind === 'resident')
        closeResident(e, s.fs);
    if (e.kind === 'pipe') {
        bumpPipe(s, e, -1);
        const pp = s.pipes.get(e.pipeId);
        wakePipe(s, pp);
        wakeWriters(pp);
        if (e.end === 'r')
            settleHeldExits(s, pp);
    }
}
/** After a read from `pp` or a close of one of its read ends: settle the exits held on it (pipe-rules heldExitSettles). */
function settleHeldExits(s, pp) {
    if (s.heldExits.size === 0)
        return;
    const settles = heldExitSettles(pp, PIPE_CAPACITY);
    if (settles === null)
        return;
    for (const [pid, held] of [...s.heldExits]) {
        if (!held.pipes.delete(pp))
            continue;
        if (settles === 'sigpipe')
            held.sigpipe = true;
        if (held.pipes.size > 0)
            continue;
        s.heldExits.delete(pid);
        publishExit(s, pid, held.ppid, held.sigpipe ? SIGPIPE : held.status);
    }
}
function takeUpTo(src, max) {
    let need = max;
    const parts = [];
    while (need > 0 && src.chunks.length) {
        const ch = src.chunks[0];
        if (ch.length <= need) {
            parts.push(ch);
            need -= ch.length;
            src.chunks.shift();
        }
        else {
            parts.push(ch.subarray(0, need));
            src.chunks[0] = ch.subarray(need);
            need = 0;
        }
    }
    const total = max - need;
    src.queued -= total;
    const o = new Uint8Array(total);
    let x = 0;
    for (const p of parts) {
        o.set(p, x);
        x += p.length;
    }
    return o;
}
// POSIX readv is ONE read of up to the summed length, scattered across the
// buffers in order — not a read of the first buffer. Zero-length entries are
// dropped so they never terminate the scatter early.
// A poll park has no destination buffer — it resumes into a fresh poll call.
const EMPTY_IOV = { list: [], total: 0 };
function readIovs(dv, iovs, n) {
    const list = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
        if (len > 0) {
            list.push({ ptr, len });
            total += len;
        }
    }
    return { list, total };
}
function scatter(u8, iov, bytes) {
    let off = 0;
    for (const b of iov.list) {
        if (off >= bytes.length)
            break;
        const n = Math.min(b.len, bytes.length - off);
        u8.set(bytes.subarray(off, off + n), b.ptr);
        off += n;
    }
    return off;
}
function wakePipe(s, pp) {
    while (pp.readW.length && (pp.queued > 0 || pp.writers === 0)) {
        const w = pp.readW.shift();
        if (!w)
            break;
        if ('complete' in w) {
            w.complete();
            continue;
        }
        const proc = w.proc;
        const req = proc.ctx.pipeReq;
        const bytes = pp.queued > 0 ? takeUpTo(pp, req.iov.total) : new Uint8Array(0);
        proc.pendingRead = { iov: req.iov, bytes, nreadPtr: req.nreadPtr, pollUserdata: req.pollUserdata };
        resumeProc(proc);
    }
    settleHeldExits(s, pp);
    wakeWriters(pp);
}
function wakeStdin(s) {
    const st = s.stdin;
    while (st.waiters.length && (st.queued > 0 || st.closed)) {
        const w = st.waiters.shift();
        if (!w)
            break;
        if ('complete' in w) {
            w.complete();
            continue;
        }
        const proc = w.proc;
        const req = proc.ctx.pipeReq;
        const bytes = st.queued > 0 ? takeUpTo(st, req.iov.total) : new Uint8Array(0);
        proc.pendingRead = { iov: req.iov, bytes, nreadPtr: req.nreadPtr, pollUserdata: req.pollUserdata };
        resumeProc(proc);
    }
}
function makeUnsupported(s) {
    const nosys = (name) => () => { s.missingWasi.add(name); return E.NOSYS; };
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
function installPreopenRehoming(proc, imports) {
    const dirfd = (fd) => proc.preopenMoved.get(fd) ?? fd;
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
function makeWasiFs(s, proc, DV, U8, io, memory, synchronous = false, resident) {
    const imports = {
        ...makeUnsupported(s),
        fd_prestat_get(fd, out) { const e = proc.fds.get(fd); if (e?.kind !== 'preopen')
            return E.BADF; DV().setUint8(out, 0); DV().setUint32(out + 4, utf8Length(e.wasiPath), true); return 0; },
        fd_prestat_dir_name(fd, out, cap) { const e = proc.fds.get(fd); if (e?.kind !== 'preopen')
            return E.BADF; const bytes = te.encode(e.wasiPath); if (cap < bytes.length)
            return E.INVAL; U8().set(bytes, out); return 0; },
        fd_close(fd) { if (!proc.fds.has(fd))
            return E.BADF; closeFd(s, proc, fd); return 0; },
        fd_renumber(from, to) {
            const value = proc.fds.get(from);
            if (!value)
                return E.BADF;
            if (from === to)
                return 0;
            closeFd(s, proc, to);
            proc.fds.delete(from);
            proc.fds.set(to, value);
            return 0;
        },
        fd_seek(fd) { return proc.fds.has(fd) ? E.SPIPE : E.BADF; },
        fd_tell(fd) { return proc.fds.has(fd) ? E.SPIPE : E.BADF; },
        fd_filestat_get(fd, out) { const e = proc.fds.get(fd); if (!e)
            return E.BADF; U8().fill(0, out, out + 64); DV().setUint8(out + 16, hostFifo(e) ? 0 : 2); DV().setBigUint64(out + 24, 1n, true); return 0; },
        fd_fdstat_get(fd, out) { const e = proc.fds.get(fd); if (!e)
            return E.BADF; U8().fill(0, out, out + 24); DV().setUint8(out, hostFifo(e) ? 0 : 2); DV().setBigUint64(out + 8, 0x1fffffffn, true); DV().setBigUint64(out + 16, 0x1fffffffn, true); return 0; },
        fd_fdstat_set_flags(fd, flags) { return !proc.fds.has(fd) ? E.BADF : flags === 0 ? 0 : E.NOSYS; },
        fd_read: (fd, p, n, out) => io.read(fd, readIovs(DV(), p, n), out),
        fd_write(fd, p, n, out) {
            if (!proc.fds.has(fd))
                return E.BADF;
            const write = () => {
                let written = 0;
                for (const v of readIovs(DV(), p, n).list) {
                    const result = io.write(fd, U8().subarray(v.ptr, v.ptr + v.len));
                    if (typeof result !== 'number') {
                        if (written === 0)
                            return result.errno;
                        break;
                    }
                    written += result;
                }
                DV().setUint32(out, written, true);
                return 0;
            };
            // A pipe at capacity makes the writer wait before any byte of this call
            // is written, so a call re-entered after the wait never writes twice.
            const gate = io.writeGate?.(fd);
            if (gate === WRITE_UNWOUND)
                return 0;
            if (gate instanceof Promise)
                return gate.then(write);
            return write();
        },
        poll_oneoff: (p, q, n, out) => io.poll(p, q, n, out),
        clock_time_get(id, _precision, out) { const ns = clockNs(id); if (ns === null)
            return E.INVAL; DV().setBigUint64(out, ns, true); return 0; },
        clock_res_get(id, out) { const ns = clockResolutionNs(id); if (ns === null)
            return E.INVAL; DV().setBigUint64(out, ns, true); return 0; },
        random_get(p, n) { for (let i = 0; i < n; i += 65536)
            crypto.getRandomValues(U8().subarray(p + i, p + Math.min(i + 65536, n))); return 0; },
        proc_exit(code) { throw new Exit(code); },
    };
    installAuthorityFilesystem(imports, { fs: () => s.fs, memory, fds: proc.fds, allocateFd: () => lowestFd(proc), synchronous, umask: () => s.cred.umask, residentBytes: WASI_RESIDENT_FILE_CAP_BYTES, residentTables: () => [...s.procs.values()].map((each) => each.fds), resident, processGone: s.gone, duplicate: (fd) => duplicateStream(s, proc, fd) });
    installPreopenRehoming(proc, imports);
    return imports;
}
// Route a write through the process fd table. The caller has already rejected
// an fd the table does not hold, so every branch here answers a real entry —
// an unknown fd must never land in the user's terminal.
function writeThroughFd(s, proc, fd, bytes) {
    const e = proc.fds.get(fd);
    if (e && e.kind === 'pipe') {
        // A pipe descriptor has a direction, and it was recorded and never read.
        // Writing to the READ end used to push bytes into the pipe and report them
        // written, so `exec 3< …; echo x >&3` fed the reader its own output — data
        // appearing from nowhere, attributed to the wrong writer, with no error
        // anywhere. POSIX makes the direction part of the descriptor: EBADF.
        if (e.end === 'r')
            return { errno: E.BADF };
        const pp = s.pipes.get(e.pipeId);
        // Without JSPI nothing parks on a write: past the pipe's budget the
        // writer runs the pipe's readers nested until they bring it back under,
        // and with nothing it can run the command fails rather than grow the pipe
        // without bound (see pipes-design: a synchronous reader cannot wait).
        // A JSPI writer at capacity parked in its gate before it got here, so on
        // this host only the local-host 'nest' and the 'sigpipe' decisions remain.
        for (;;) {
            const decision = decideWrite(pp, bytes.length, pipeHost(s), PIPE_CAPACITY, s.pipeBudget);
            if (decision !== 'nest') {
                if (decision === 'sigpipe') {
                    if (signalDisposition(proc, SIGPIPE) === 1)
                        return { errno: E.PIPE };
                    throw new Signalled(SIGPIPE);
                }
                break;
            }
            if (!pumpSuspended(s, proc))
                throw pipeLimitExceeded(s);
        }
        pp.chunks.push(bytes.slice());
        pp.queued += bytes.length;
        wakePipe(s, pp);
        return bytes.length;
    }
    if (!e || (e.kind !== 'stdout' && e.kind !== 'stderr'))
        return { errno: E.BADF };
    const owned = bytes.slice();
    const delivered = e.kind === 'stderr' ? s.output.stderrBytes(owned) : s.output.stdoutBytes(owned);
    if (delivered && typeof delivered.then === 'function')
        queueSessionTask(s, Promise.resolve(delivered));
    return bytes.length;
}
// Synchronous read for non-parking consumers (files, buffered pipes).
// Returns {errno} or null when the source would block.
function tryReadFd(s, proc, fd, dv, u8, iov, nreadPtr) {
    const e = proc.fds.get(fd);
    const deliver = (bytes) => { dv.setUint32(nreadPtr, scatter(u8, iov, bytes), true); return { errno: 0 }; };
    if (e && e.kind === 'pipe') {
        const pp = s.pipes.get(e.pipeId);
        if (pp.queued > 0) {
            const read = deliver(takeUpTo(pp, iov.total));
            wakeWriters(pp);
            settleHeldExits(s, pp);
            return read;
        }
        if (pp.writers === 0) {
            dv.setUint32(nreadPtr, 0, true);
            return { errno: 0 };
        }
        return null;
    }
    if (e && e.kind === 'stdin') {
        const st = s.stdin;
        if (st.queued > 0)
            return deliver(takeUpTo(st, iov.total));
        if (st.closed) {
            dv.setUint32(nreadPtr, 0, true);
            return { errno: 0 };
        }
        return null;
    }
    if (e) {
        dv.setUint32(nreadPtr, 0, true);
        return { errno: 0 };
    }
    return { errno: E.BADF };
}
// Subscription record: 48B, userdata u64 at +0, tag u8 at +8. A CLOCK carries
// id u32 at +16, timeout u64 at +24, flags u16 at +40 (bit 0 = ABSTIME); an
// FD_READ/FD_WRITE carries the fd u32 at +16.
function readSubs(dv, inPtr, nsubs) {
    const subs = [];
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
        }
        else {
            subs.push({ tag, userdata, fd: dv.getUint32(base + 16, true) });
        }
    }
    return subs;
}
function clockExpired(sub) {
    const now = clockNs(sub.id);
    return now !== null && now >= sub.deadline;
}
function writeEvent(dv, outPtr, slot, sub, errno, nbytes) {
    const ev = outPtr + slot * 32;
    dv.setBigUint64(ev, sub.userdata, true);
    dv.setUint16(ev + 8, errno, true);
    dv.setUint8(ev + 10, sub.tag);
    dv.setBigUint64(ev + 16, BigInt(nbytes), true);
    dv.setUint16(ev + 24, 0, true);
}
// Readiness of an FD_READ subscription. FD_WRITE and anything on an fd this
// table does not hold are handled by the caller.
function fdReadReady(s, proc, fd) {
    const e = proc.fds.get(fd);
    if (!e)
        return null;
    if (e.kind === 'pipe') {
        const pp = s.pipes.get(e.pipeId);
        return { ready: pp.queued > 0 || pp.writers === 0, avail: pp.queued };
    }
    if (e.kind === 'stdin')
        return { ready: s.stdin.queued > 0 || s.stdin.closed, avail: s.stdin.queued };
    return { ready: true, avail: 0 };
}
// Emit every subscription that is ready right now. Returns the event count.
function emitReady(s, proc, dv, outPtr, subs) {
    let n = 0;
    for (const sub of subs) {
        if (sub.tag === 0) {
            if (sub.bad) {
                writeEvent(dv, outPtr, n++, sub, E.INVAL, 0);
                continue;
            }
            if (clockExpired(sub))
                writeEvent(dv, outPtr, n++, sub, 0, 0);
            continue;
        }
        const st = fdReadReady(s, proc, sub.fd);
        if (!st) {
            writeEvent(dv, outPtr, n++, sub, E.BADF, 0);
            continue;
        }
        // FD_WRITE (tag 2) never blocks here: pipes and the output buffers accept
        // whatever is handed to them.
        if (sub.tag === 2 || st.ready)
            writeEvent(dv, outPtr, n++, sub, 0, st.avail);
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
function waitForDeadline(s, proc, subs) {
    const clocks = subs.filter((x) => x.tag === 0 && !x.bad);
    if (!clocks.length)
        return;
    const startedNs = realtimeNs();
    let spins = 0;
    while (!clocks.some(clockExpired)) {
        if (proc.killedBy)
            throw new Signalled(proc.killedBy);
        if (s.rootExit !== null)
            return;
        if (subs.some((x) => x.tag === 1 && (fdReadReady(s, proc, x.fd) || { ready: true }).ready))
            return;
        if (s.runnable.length) {
            pumpOne(s);
            continue;
        }
        if (++spins > FROZEN_PROBE && realtimeNs() === startedNs)
            return;
    }
}
// Report every live clock subscription as fired. Reached only once the wait
// above can make no further progress: the alternative is an eventless success,
// which poll_oneoff may not return and which a guest cannot act on.
function emitClocks(dv, outPtr, subs) {
    let n = 0;
    for (const sub of subs)
        if (sub.tag === 0 && !sub.bad)
            writeEvent(dv, outPtr, n++, sub, 0, 0);
    return n;
}
function blockTarget(s, proc, fd) {
    const e = proc.fds.get(fd);
    if (e && e.kind === 'pipe')
        return { list: s.pipes.get(e.pipeId).readW, wake: () => wakePipe(s, s.pipes.get(e.pipeId)) };
    if (e && e.kind === 'stdin')
        return { list: s.stdin.waiters, wake: () => { wakeStdin(s); requestSharedInput(s); } };
    return null;
}
// A guest read takes at most one bounded packet from the common fd0 store.
// Bash's pending read/fork table shares the unread remainder within this VM.
function requestSharedInput(s) {
    if (!s.sharedInput || s.inputPending || s.stdin.closed || s.stdin.queued)
        return;
    const supervisor = inputSupervisor;
    if (!supervisor?.cpReadStdin)
        throw new Error('bash requires the shared process stdin capability');
    // Called on its receiver: on a workerd RPC stub, Function.prototype.call is itself a remote method name.
    const pending = Promise.resolve(supervisor.cpReadStdin(s.processPid, 5000, undefined, 64 * 1024)).then(packet => {
        if (packet.data?.length) {
            s.stdin.chunks.push(packet.data);
            s.stdin.queued += packet.data.length;
        }
        if (packet.ended)
            s.stdin.closed = true;
        s.inputPending = undefined;
        wakeStdin(s);
        if (!s.stdin.queued && !s.stdin.closed)
            requestSharedInput(s);
    });
    s.inputPending = pending;
    queueSessionTask(s, pending);
}
// ── per-process bash instance ─────────────────────────────────────────
function makeProc(s, pid, ppid, fds) {
    const proc = {
        pid, ppid, fds, preopenMoved: new Map(), cwd: s.cwd, inst: null, __s: s,
        ctx: freshCtx(), incarnation: 0,
        pendingRead: null, writeResumed: false, resident: new Map(),
    };
    const DV = () => new DataView(proc.inst.exports.memory.buffer);
    const U8 = () => new Uint8Array(proc.inst.exports.memory.buffer);
    proc.DV = DV;
    proc.U8 = U8;
    /** Unwind the whole stack, from the import calling this, into the arena's top. */
    const startUnwind = () => { proc.inst.exports.asyncify_start_unwind(proc.captures.unwindAt(proc.inst.exports.memory, stackPointer(), s.stats, proc.pid)); };
    /** The shadow stack pointer at the import calling this: its caller's frame bottom (nimbus-proc.c's wrappers keep no frame). */
    const stackPointer = () => Number(proc.inst.exports.__stack_pointer.value);
    const wstr = (p, str) => { const b = te.encode(str); U8().set(b, p); return b.length; };
    const c = proc.ctx;
    function suspend(name, call) {
        return (...args) => {
            if (c.rewinding && proc.pendingFs?.name === name) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                const value = proc.pendingFs.value;
                proc.pendingFs = undefined;
                if (value === undefined)
                    throw new Error('Filesystem resumed before completion');
                return value;
            }
            const result = call(...args);
            if (!(result instanceof Promise))
                return result;
            const pending = { name, value: 0, promise: Promise.resolve() };
            pending.promise = result.then(value => { pending.value = value; }, error => { pending.value = refusalErrno(error, s.gone); });
            proc.pendingFs = pending;
            c.reason = 'filesystem';
            startUnwind();
            return 0;
        };
    }
    const io = {
        read: (fd, iov, nread) => {
            if (proc.pendingRead) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                const pr = proc.pendingRead;
                proc.pendingRead = null;
                DV().setUint32(pr.nreadPtr, scatter(U8(), pr.iov, pr.bytes), true);
                return 0;
            }
            const dv = DV();
            const sync = tryReadFd(s, proc, fd, dv, U8(), iov, nread);
            if (sync)
                return sync.errno;
            // would block: asyncify-park until bytes/EOF arrive
            dv.setUint32(nread, 0, true);
            c.reason = 'blockread';
            c.pipeReq = { fd, iov, nreadPtr: nread };
            startUnwind();
            return 0;
        },
        write: (fd, bytes) => writeThroughFd(s, proc, fd, bytes),
        writeGate: (fd) => {
            if (proc.writeResumed) { // the re-entered call of a write that waited: stop the rewind, go ahead
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                proc.writeResumed = false;
            }
            // Only a host whose readers can wait lets a writer wait (pipes-design).
            if (s.parking !== 'jspi')
                return undefined;
            const outputWait = s.output.ready();
            if (!writePipe(s, proc, fd) && outputWait) {
                c.reason = 'blockwrite';
                c.outputWait = outputWait;
                startUnwind();
                return WRITE_UNWOUND;
            }
            const pp = writePipe(s, proc, fd);
            if (!pp || !atCapacity(pp))
                return undefined;
            c.reason = 'blockwrite';
            c.writeFd = fd;
            startUnwind();
            return WRITE_UNWOUND;
        },
        poll: (inPtr, outPtr, nsubs, retPtr) => {
            if (proc.pendingRead) { // poll resume: report the fd readable
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                const pr = proc.pendingRead;
                proc.pendingRead = null;
                const dv = DV();
                dv.setBigUint64(outPtr, pr.pollUserdata ?? 0n, true);
                dv.setUint16(outPtr + 8, 0, true);
                dv.setUint8(outPtr + 10, 1); // eventtype fd_read
                dv.setBigUint64(outPtr + 16, BigInt(pr.bytes.length), true);
                dv.setUint16(outPtr + 24, 0, true);
                dv.setUint32(retPtr, 1, true);
                return 0;
            }
            const dv = DV();
            const subs = readSubs(dv, inPtr, nsubs);
            let emitted = emitReady(s, proc, dv, outPtr, subs);
            if (emitted > 0) {
                dv.setUint32(retPtr, emitted, true);
                return 0;
            }
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
            c.pipeReq = { fd: blockSub.fd, iov: EMPTY_IOV, nreadPtr: 0, pollUserdata: blockSub.userdata };
            startUnwind();
            return 0;
        },
    };
    const wasiBase = makeWasiFs(s, proc, DV, U8, io, () => proc.inst.exports.memory, false, proc.resident);
    const wasi = {
        ...wasiBase,
        args_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, s.argv.length, true); dv.setUint32(b, s.argv.reduce((x, v) => x + utf8Length(v) + 1, 0), true); return 0; },
        args_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const a of s.argv) {
            dv.setUint32(ptrs, p, true);
            ptrs += 4;
            p += wstr(p, a);
            U8()[p++] = 0;
        } return 0; },
        environ_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, s.environ.length, true); dv.setUint32(b, s.environ.reduce((x, v) => x + utf8Length(v) + 1, 0), true); return 0; },
        environ_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const v of s.environ) {
            dv.setUint32(ptrs, p, true);
            ptrs += 4;
            p += wstr(p, v);
            U8()[p++] = 0;
        } return 0; },
    };
    const procFs = metadataImports(s, proc, DV, U8, s.fs);
    const nimbus_proc = {
        startup_cwd: (ptr, capacity) => {
            const bytes = te.encode(proc.cwd);
            if (!capacity)
                return bytes.length;
            if (capacity <= bytes.length)
                return -37;
            U8().set(bytes, ptr);
            U8()[ptr + bytes.length] = 0;
            return bytes.length;
        },
        capture_cwd: (ptr, length) => { proc.cwd = nameDec.decode(U8().subarray(ptr, ptr + length)); return 0; },
        stat_metadata: suspend('stat_metadata', procFs.stat_metadata),
        account: suspend('account', procFs.account),
        // A landing (the capture's own rewind, or a longjmp's) stops the rewind and runs no hook.
        setjmp: (env) => {
            if (c.rewinding) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                return;
            }
            const sp = stackPointer();
            proc.captures.setting(proc.inst.exports.memory, env);
            c.reason = 'capture';
            c.captureEnv = env;
            c.captureSp = sp;
            startUnwind();
        },
        // The current stack is unwound and discarded; the target is resolved once it is (step).
        longjmp: (env, val) => {
            if (c.rewinding) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                return;
            }
            c.reason = 'longjmp';
            c.ljEnv = env;
            c.ljVal = val;
            startUnwind();
        },
        fork: () => {
            if (c.rewinding) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                return c.resume;
            }
            c.reason = 'fork';
            startUnwind();
            return 0;
        },
        vfork: () => nimbus_proc.fork(),
        waitpid: (pid, statusPtr, _opt) => {
            if (c.rewinding) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                if (c.waitStatusPtr != null)
                    DV().setInt32(c.waitStatusPtr, c.resumeStatus, true);
                return c.resume;
            }
            c.reason = 'waitpid';
            c.waitTarget = pid;
            c.waitStatusPtr = statusPtr;
            startUnwind();
            return 0;
        },
        execve: (pathPtr, argvFlatPtr, argvLen, envFlatPtr, envLen) => {
            if (c.rewinding) {
                proc.inst.exports.asyncify_stop_rewind();
                c.rewinding = false;
                return c.resume;
            }
            const u8 = U8();
            let e = pathPtr;
            while (u8[e])
                e++;
            c.reason = 'exec';
            c.execPath = nameDec.decode(u8.subarray(pathPtr, e));
            c.execArgv = nameDec.decode(u8.subarray(argvFlatPtr, argvFlatPtr + argvLen)).split('\0').filter((x) => x.length);
            // The child's REAL environment (bash's export set at exec time —
            // PWD tracks the shell's cd, unlike the boot-time s.environ).
            c.execEnv = nameDec.decode(u8.subarray(envFlatPtr, envFlatPtr + envLen)).split('\0').filter((x) => x.length);
            startUnwind();
            return 0;
        },
        pipe: (fdsPtr) => {
            const id = newPipe(s);
            const rfd = lowestFd(proc);
            proc.fds.set(rfd, { kind: 'pipe', pipeId: id, end: 'r' });
            const wfd = lowestFd(proc);
            proc.fds.set(wfd, { kind: 'pipe', pipeId: id, end: 'w' });
            const dv = DV();
            dv.setInt32(fdsPtr, rfd, true);
            dv.setInt32(fdsPtr + 4, wfd, true);
            return 0;
        },
        // nimbus-proc.c reads these two as `errno = -r` on a negative return, so a
        // failure has to arrive negated; refusalErrno's positive value would be
        // handed back to bash as a live descriptor.
        dup: suspend('dup', async (o) => {
            const e = proc.fds.get(o);
            if (!e)
                return -E.BADF;
            const stream = duplicateStream(s, proc, o);
            if (stream !== null)
                return stream;
            try {
                const nf = lowestFd(proc);
                proc.fds.set(nf, e.kind === 'authority' ? { ...e, handle: await s.fs.dup(e.handle.id) } : shareEntry(e));
                return nf;
            }
            catch (error) {
                return -refusalErrno(error, s.gone);
            }
        }),
        dup2: suspend('dup2', async (o, n) => {
            const e = proc.fds.get(o);
            if (!e)
                return -E.BADF;
            if (o === n)
                return n;
            try {
                // The old descriptor is released only once the duplicate exists, so a
                // failed dup2 leaves the target fd exactly as POSIX requires: untouched.
                const copy = e.kind === 'authority' ? { ...e, handle: await s.fs.dup(e.handle.id) } : shareEntry(e);
                const displaced = proc.fds.get(n);
                if (displaced?.kind === 'preopen') {
                    // `exec 3>file` claims the descriptor wasi-libc cached as its
                    // namespace root. The number is bash's to take; the capability is
                    // not, so it moves and every dirfd naming it follows.
                    proc.fds.delete(n);
                    const moved = lowestFd(proc);
                    proc.fds.set(moved, displaced);
                    for (const [from, to] of proc.preopenMoved)
                        if (to === n)
                            proc.preopenMoved.set(from, moved);
                    proc.preopenMoved.set(n, moved);
                }
                else
                    closeFd(s, proc, n);
                proc.fds.set(n, copy);
                if (e.kind === 'pipe')
                    bumpPipe(s, e, 1);
                return n;
            }
            catch (error) {
                return -refusalErrno(error, s.gone);
            }
        }),
        kill: (pid, signal) => signalProc(s, proc, pid, signal),
        setpgid: () => 0, getpgid: () => proc.pid, getppid: () => proc.ppid,
        tcsetpgrp: () => 0, tcgetpgrp: () => proc.pid, tcgetattr: () => -1, tcsetattr: () => 0,
    };
    const envImports = {
        getpid: () => proc.pid, getuid: () => s.cred.uid, geteuid: () => s.cred.uid, getgid: () => s.cred.gid, getegid: () => s.cred.gid,
        setuid: (uid) => uid === s.cred.uid ? 0 : -E.PERM,
        setgid: (gid) => gid === s.cred.gid ? 0 : -E.PERM,
        umask: (mode) => { const previous = s.cred.umask; s.cred = { ...s.cred, umask: mode & 0o777 }; return previous; },
        gethostname: (p, _l) => { U8().set(te.encode('nimbus'), p); return 0; },
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
    // Every copy bash makes of a jmp_buf, and every end of a saved one (wasm/bash/patches/procenv.patch).
    // The jmp_buf hooks record into the module's own log (nimbus-proc.c); a full one is applied at once.
    const nimbus_procenv = { full: () => { proc.captures.applyLog(proc.inst.exports.memory); } };
    proc.inst = new WebAssembly.Instance(s.mod, { wasi_snapshot_preview1: suspendedWasi, nimbus_proc, nimbus_procenv, env: envImports });
    s.stack ??= checkedLayout(s.mod, proc.inst);
    proc.captures = new CaptureStore(s.stack, 0, 0);
    s.stats.instances++;
    s.procs.set(pid, proc);
    return proc;
}
/**
 * The module's shadow stack and hook log, after checking it is the
 * bash-runner@5 module: one that records its jmp_buf copies in its own log
 * (nimbus_procenv_log, handed over by nimbus_procenv.full), exports the
 * stack's bounds, and the stack pointer a longjmp and a fork set.
 */
function checkedLayout(mod, inst) {
    const ex = inst.exports;
    const logs = WebAssembly.Module.imports(mod).some((i) => i.module === 'nimbus_procenv' && i.name === 'full');
    if (!logs || typeof ex.nimbus_procenv_log !== 'function' || typeof ex.__nimbus_signal_disposition !== 'function'
        || !(ex.__data_end instanceof WebAssembly.Global) || !(ex.__heap_base instanceof WebAssembly.Global)) {
        throw new Error('bash-runner@5 needs the bash 5.2.37-5 module (its jmp_buf copies recorded in nimbus_procenv_log); install bash 5.2.37-5');
    }
    try {
        ex.__stack_pointer.value = ex.__stack_pointer.value;
    }
    catch {
        throw new Error('bash-runner@5 needs a mutable __stack_pointer export; install bash 5.2.37-5');
    }
    const low = Number(ex.__data_end.value), high = Number(ex.__heap_base.value), sp = Number(ex.__stack_pointer.value);
    if (!(low < sp && sp <= high))
        throw new Error(`bash-runner@5: the module's stack is not [__data_end, __heap_base) (${low}, ${sp}, ${high})`);
    return { low, high, log: ex.nimbus_procenv_log() };
}
/** A process's unwind state before it first runs; a reason's own fields are set when it unwinds for that reason. */
function freshCtx() {
    return { reason: null, rewinding: false, captureEnv: 0, captureSp: 0, ljEnv: 0, ljVal: 0, resume: 0, writeFd: -1 };
}
/** Exited processes kept for reuse at most (BashSession.idle): what a fork loop keeps live at once, with room. */
const IDLE_MAX = 4;
/**
 * Keep an exited process's instance for the next fork. Only a normal exit
 * qualifies: its instance returned from `_start` with nothing suspended, and
 * nothing (a pending read, a filesystem call, a JSPI wait, a signal) still
 * refers to it. The root's exit ends the session.
 */
function retire(s, proc, signal) {
    if (signal || proc.ppid === 0 || proc.killedBy !== undefined || proc.pendingFs || proc.pendingRead || proc.cancelWaits?.size)
        return;
    if (s.idle.length < IDLE_MAX)
        s.idle.push(proc);
}
/**
 * An idle process made the fresh process `pid` (as makeProc makes one),
 * keeping its instance, its memory and the imports bound to it; null when
 * none is idle whose memory is no larger than `bytes`, the size it must
 * take (a memory cannot shrink).
 */
function reincarnate(s, bytes, pid, ppid, fds) {
    s.idle = s.idle.filter((idle) => idle.inst.exports.memory.buffer.byteLength <= bytes);
    const proc = s.idle.pop();
    if (proc === undefined)
        return null;
    proc.pid = pid;
    proc.ppid = ppid;
    // The authority filesystem holds this very map.
    proc.fds.clear();
    for (const [fd, entry] of fds)
        proc.fds.set(fd, entry);
    proc.preopenMoved = new Map();
    proc.cwd = s.cwd;
    delete proc.killedBy;
    delete proc.execIgnoredSignals;
    delete proc.cancelWaits;
    delete proc.pendingFs;
    // Its imports hold this very object.
    for (const key of Object.keys(proc.ctx))
        Reflect.deleteProperty(proc.ctx, key);
    Object.assign(proc.ctx, freshCtx());
    proc.pendingRead = null;
    proc.writeResumed = false;
    // A fork gives it the parent's captures (doFork); it holds none of the process that exited.
    proc.captures = proc.captures.emptied();
    proc.incarnation++;
    proc.resident.clear();
    s.stats.reused++;
    s.procs.set(pid, proc);
    return proc;
}
function forkSource(proc) {
    return { pid: proc.pid, incarnation: proc.incarnation, captures: proc.captures.fork(), unwound: proc.DV().getUint32(proc.captures.top, true) };
}
/**
 * What of the parent's memory a forked child can read, copied into it: the
 * data, stack and heap below the arena and above it, each live setjmp
 * capture, and the unwind the child rewinds from. The rest of the arena is
 * freed or not yet written, so it is not copied: a 17 MB image is about
 * 1 MB of this.
 */
function copyForkImage(s, parent, child, source) {
    const src = new Uint8Array(parent.inst.exports.memory.buffer);
    const dst = new Uint8Array(child.inst.exports.memory.buffer);
    const { base, size } = source.captures;
    let copied = 0;
    const range = (from, to) => { if (to > from) {
        dst.set(src.subarray(from, to), from);
        copied += to - from;
    } };
    range(0, base);
    for (const [from, to] of source.captures.liveRanges(source.unwound))
        range(from, to);
    range(base + size, src.length);
    s.stats.forkCopied = copied;
}
function setupArena(proc) {
    const base = proc.inst.exports.memory.buffer.byteLength;
    proc.inst.exports.memory.grow(Math.ceil(ARENA_SIZE / PAGE));
    proc.captures = new CaptureStore(proc.captures.layout, base, ARENA_SIZE);
}
// ── scheduler ─────────────────────────────────────────────────────────
function resumeProc(proc) {
    if (!proc.__s.procs.has(proc.pid))
        return;
    proc.ctx.rewinding = true;
    proc.inst.exports.asyncify_start_rewind(proc.captures.top);
    proc.__s.runnable.push(proc);
    wakeScheduler(proc.__s);
}
/**
 * The scheduler awaits pending tasks when nothing is runnable. A task that
 * makes a process runnable without settling (a JSPI reader that drains a
 * pipe and wakes its parked writer, then reads on) must wake it, or the
 * writer waits on a reader that waits on the writer.
 */
function wakeScheduler(s) {
    const wake = s.wake;
    if (wake) {
        s.wake = null;
        wake();
    }
}
function trackArena(s, proc) {
    const at = proc.captures.top, used = proc.DV().getUint32(at, true) - (at + 8);
    if (used > s.stats.mainHi)
        s.stats.mainHi = used;
}
function step(s, proc) {
    if (!s.procs.has(proc.pid))
        return;
    const c = proc.ctx, ex = proc.inst.exports;
    try {
        ex._start();
    }
    catch (e) {
        if (e instanceof Exit) {
            finishProc(s, proc, e.code);
            return;
        }
        if (e instanceof Signalled) {
            finishProc(s, proc, 0, e.signal);
            return;
        }
        throw e;
    }
    if (c.reason === null) {
        // A rewind that never reached its landing ran the guest off its end: not an exit.
        if (c.rewinding)
            throw new Error(`bash-runner: pid ${proc.pid} returned from _start mid-rewind, its longjmp or resume target lost`);
        finishProc(s, proc, 0);
        return;
    }
    ex.asyncify_stop_unwind();
    const r = c.reason;
    c.reason = null;
    const mem = proc.inst.exports.memory.buffer.byteLength;
    if (mem > s.stats.memPeak)
        s.stats.memPeak = mem;
    if (r === 'capture') {
        c.rewinding = true;
        ex.asyncify_start_rewind(proc.captures.take(ex.memory, c.captureEnv, c.captureSp, s.stats, proc.pid));
        s.runnable.push(proc);
    }
    else if (r === 'longjmp') {
        trackArena(s, proc);
        // The current stack is discarded; the landing runs on the stack pointer setjmp's caller had.
        const target = proc.captures.jump(ex.memory, c.ljEnv, c.ljVal, proc.pid);
        ex.__stack_pointer.value = target.sp;
        c.rewinding = true;
        ex.asyncify_start_rewind(target.at);
        s.runnable.push(proc);
    }
    else if (r === 'fork') {
        trackArena(s, proc);
        queueSessionTask(s, doFork(s, proc, forkSource(proc)));
    }
    else if (r === 'waitpid') {
        trackArena(s, proc);
        doWait(s, proc);
    }
    else if (r === 'blockread') {
        trackArena(s, proc);
        const target = blockTarget(s, proc, c.pipeReq.fd);
        if (!target) { // fd closed under us: deliver EOF
            proc.pendingRead = { iov: c.pipeReq.iov, bytes: new Uint8Array(0), nreadPtr: c.pipeReq.nreadPtr, pollUserdata: c.pipeReq.pollUserdata };
            resumeProc(proc);
        }
        else {
            target.list.push({ proc });
            target.wake();
        }
    }
    else if (r === 'blockwrite') {
        trackArena(s, proc);
        if (c.outputWait) {
            const pending = c.outputWait;
            c.outputWait = undefined;
            queueSessionTask(s, pending.then(() => { if (s.procs.has(proc.pid)) {
                proc.writeResumed = true;
                resumeProc(proc);
            } }));
            return;
        }
        const pp = writePipe(s, proc, c.writeFd);
        if (pp && atCapacity(pp))
            pp.writeW.push({ proc });
        else {
            proc.writeResumed = true;
            resumeProc(proc);
        }
    }
    else if (r === 'exec') {
        trackArena(s, proc);
        // With JSPI a child parks on a pipe it would block on; without it, it runs
        // synchronously, so it waits here until what it could depend on has run.
        if (s.parking === 'jspi')
            queueSessionTask(s, doExec(s, proc));
        else
            s.deferred.push(proc);
    }
    else if (r === 'filesystem') {
        const pending = proc.pendingFs;
        if (!pending)
            throw new Error('Missing suspended filesystem operation');
        queueSessionTask(s, pending.promise.then(() => { if (s.procs.has(proc.pid))
            resumeProc(proc); }));
    }
    else {
        throw new Error('bash-runner: unknown unwind reason ' + r);
    }
}
function pumpOne(s) {
    if (s.runnable.length) {
        step(s, s.runnable.shift());
        return true;
    }
    // A deferred child may be the writer a blocked reader is waiting for: it runs
    // nested, to completion or to its own blocked read, as a runnable step does.
    if (s.deferred.length) {
        startDeferred(s);
        return true;
    }
    return false;
}
/** Start the next process that reached exec (see BashSession.deferred). */
function startDeferred(s) {
    const proc = s.deferred.shift();
    if (s.procs.has(proc.pid))
        queueSessionTask(s, doExec(s, proc));
}
// exec re-homes the forked child onto a staged plain-WASI coreutil
// bound to the process fd table (M2 exec-into-runner, in-facet). The
// tool's blocking pipe reads synchronously pump the writer procs.
/**
 * nimbus_proc's calls for what preview1 cannot carry: a process's
 * descriptors' and paths' mode and owner (BusyBox's stat wrappers ask at
 * every stat, bash's own only for a stat preview1 gave no type: a pipe, a
 * stdin that is not a terminal), chmod and chown, and the session's
 * accounts (account).
 */
/** A chown side as the guest's uid_t or gid_t (an i32 here): its id, or null for (uid_t)-1, which keeps the file's. */
function ownerSide(bits) {
    const id = bits >>> 0;
    return id === 0xffffffff ? null : id;
}
function metadataImports(s, proc, DV, U8, fs) {
    const readPath = (ptr, length) => nameDec.decode(U8().subarray(ptr, ptr + length));
    const at = (fd, path) => {
        if (path.startsWith('/'))
            return path;
        if (fd === -1)
            return proc.cwd + '/' + path;
        // Same redirection the preview1 path imports apply: a dirfd the shell
        // claimed still names the root wasi-libc resolved it against.
        const entry = proc.fds.get(proc.preopenMoved.get(fd) ?? fd);
        if (entry?.kind === 'preopen')
            return entry.vfsPath + '/' + path;
        if (entry?.kind !== 'authority')
            throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
        return { directory: entry.handle.id, path };
    };
    const descriptor = (fd) => { const entry = proc.fds.get(fd); if (entry?.kind !== 'authority')
        throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); return entry.handle.id; };
    const metadata = (out, mode, uid, gid) => {
        DV().setUint32(out, mode, true);
        DV().setUint32(out + 4, uid, true);
        DV().setUint32(out + 8, gid, true);
        return 0;
    };
    // fstat's: a file's own, a stream's or a pipe's by its kind (no inode: a terminal's or a FIFO's mode, the session's owner).
    const descriptorMetadata = (fd, out) => {
        const entry = proc.fds.get(fd);
        if (entry === undefined)
            return E.BADF;
        if (entry.kind === 'resident')
            return metadata(out, entry.stat.mode ?? 0, entry.stat.uid, entry.stat.gid);
        if (entry.kind === 'pipe' || entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr')
            return metadata(out, hostFifo(entry) ? 0o010600 : 0o020620, s.cred.uid, s.cred.gid);
        const stat = entry.kind === 'authority' ? () => fs.fstat(entry.handle.id) : entry.kind === 'preopen' ? () => fs.stat(entry.vfsPath) : null;
        if (stat === null)
            return E.BADF;
        return result(stat, st => st ? metadata(out, st.mode ?? 0, st.uid, st.gid) : E.NOENT);
    };
    // The call is produced inside the guard, not handed to it: resolving the fd
    // is itself a syscall step that can fail, and an EBADF raised while building
    // the arguments has to answer the guest as an errno rather than escape the
    // import and fail the whole session.
    const result = (produce, finish) => {
        try {
            const next = after(produce(), finish);
            return next instanceof Promise ? next.catch((error) => refusalErrno(error, s.gone)) : next;
        }
        catch (error) {
            return refusalErrno(error, s.gone);
        }
    };
    return {
        stat_metadata: (fd, ptr, length, follow, out) => {
            if (!ptr)
                return descriptorMetadata(fd, out);
            const path = readPath(ptr, length);
            // A path naming a descriptor (/dev/fd/N) is that descriptor's, resolved as path_filestat_get resolves it.
            const named = descriptorNamed(proc.fds, fd === -1 ? -1 : proc.preopenMoved.get(fd) ?? fd, path, proc.cwd);
            if (named !== null)
                return proc.fds.has(named) ? descriptorMetadata(named, out) : E.NOENT;
            return result(() => fs.stat(at(fd, path), { followSymlinks: !!follow }), st => st ? metadata(out, st.mode ?? 0, st.uid, st.gid) : E.NOENT);
        },
        chmod: (ptr, length, mode) => result(() => fs.chmod(at(-1, readPath(ptr, length)), mode), () => 0),
        fchmod: (fd, mode) => result(() => fs.fchmod(descriptor(fd), mode), () => 0),
        // uid_t and gid_t are unsigned, and come as i32: an id above 0x7fffffff
        // arrives negative (>>> 0 is its value), and (uid_t)-1 keeps that side,
        // as chown(2)'s -1 does, which the session keeps in the same change (null).
        chown: (fd, ptr, length, uidBits, gidBits, follow) => {
            const uid = ownerSide(uidBits), gid = ownerSide(gidBits);
            return result(() => ptr ? fs.chown(at(fd, readPath(ptr, length)), uid, gid, { followSymlinks: !!follow }) : fs.fchown(descriptor(fd), uid, gid), () => 0);
        },
        /**
         * One getpw* or getgr* lookup (nimbus-libc/nimbus-accounts.c), in one
         * round trip: a user (kind 0) or a group (1), by id (by 0), by name (1)
         * or by index (2, getpwent's), answered from /etc/passwd or /etc/group
         * as they are now, as unix-accounts reads them. The record goes to `out`:
         * two u32s (uid and gid; gid and its member count), then its strings,
         * each NUL-ended (user: name, password, gecos, home, shell; group: name,
         * password, members). `needed` gets its size: ERANGE when it is more
         * than `capacity`, NOENT when no account is that one.
         */
        account: (kind, by, ptr, length, idBits, out, capacityBits, needed) => result(() => fs.readFile(kind === 1 ? '/etc/group' : '/etc/passwd'), (bytes) => {
            // A uid, gid or index is unsigned, and comes as i32: one above 0x7fffffff arrives negative.
            const id = idBits >>> 0, capacity = capacityBits >>> 0;
            const text = bytes === null ? '' : td.decode(bytes);
            const name = by === 1 ? nameDec.decode(U8().subarray(ptr, ptr + length)) : '';
            let ids;
            let strings;
            if (kind === 1) {
                const groups = unixGroups(text);
                const group = by === 2 ? groups[id] : groups.find((each) => by === 1 ? each.name === name : each.gid === id);
                if (group === undefined)
                    return E.NOENT;
                ids = [group.gid, group.members.length];
                strings = [group.name, group.password, ...group.members];
            }
            else {
                const users = unixUsers(text);
                const user = by === 2 ? users[id] : users.find((each) => by === 1 ? each.name === name : each.uid === id);
                if (user === undefined)
                    return E.NOENT;
                ids = [user.uid, user.gid];
                strings = [user.name, user.password, user.gecos, user.home, user.shell];
            }
            const encoded = strings.map((each) => te.encode(each));
            const size = encoded.reduce((total, each) => total + each.length + 1, 8);
            DV().setUint32(needed, size, true);
            if (size > capacity)
                return E.RANGE;
            DV().setUint32(out, ids[0], true);
            DV().setUint32(out + 4, ids[1], true);
            let cursor = out + 8;
            for (const each of encoded) {
                U8().set(each, cursor);
                U8()[cursor + each.length] = 0;
                cursor += each.length + 1;
            }
            return 0;
        }),
    };
}
async function doExec(s, proc) {
    if (!s.procs.has(proc.pid))
        return;
    const path = proc.ctx.execPath.startsWith('/') ? proc.ctx.execPath : proc.cwd + '/' + proc.ctx.execPath;
    const key = norm(path);
    const name = key.split('/').pop() ?? '';
    const module = key.startsWith(s.coreutilsRoot + '/') ? s.coreutils.get(name) : undefined;
    if (!module) {
        try {
            await s.fs.access(path, 1);
            proc.ctx.resume = -45;
        }
        catch (error) {
            proc.ctx.resume = -refusalErrno(error, s.gone);
        }
        resumeProc(proc);
        return;
    }
    const canPark = s.parking === 'jspi';
    if (!canPark && !s.fs.synchronous)
        throw new Error('Plain WASI child requires JSPI for an asynchronous filesystem');
    let ignored = 0n;
    for (let signal = 1; signal < 65; signal++) {
        if (proc.inst.exports.__nimbus_signal_disposition(signal) === 1)
            ignored |= 1n << BigInt(signal);
    }
    proc.execIgnoredSignals = ignored;
    let instance;
    function memory() {
        const value = instance?.exports.memory;
        if (!(value instanceof WebAssembly.Memory))
            throw new Error('Child memory is unavailable');
        return value;
    }
    const DV = () => new DataView(memory().buffer);
    const U8 = () => new Uint8Array(memory().buffer);
    // A source that would block with nothing left to run is at end of input, not
    // an unimplemented syscall: without a parking transport no further bytes can
    // ever arrive, and POSIX spells that a zero-byte read, not an error.
    const waitInput = async (fd, iov, out) => {
        for (;;) {
            if (proc.killedBy)
                throw new Signalled(proc.killedBy);
            const ready = tryReadFd(s, proc, fd, DV(), U8(), iov, out);
            if (ready)
                return ready.errno;
            if (!canPark) {
                if (pumpOne(s))
                    continue;
                DV().setUint32(out, 0, true);
                return 0;
            }
            const target = blockTarget(s, proc, fd);
            if (!target)
                return E.BADF;
            await waitChild(proc, complete => { target.list.push({ proc, complete }); target.wake(); });
        }
    };
    const io = {
        read: (fd, iov, out) => {
            for (;;) {
                if (proc.killedBy)
                    throw new Signalled(proc.killedBy);
                const ready = tryReadFd(s, proc, fd, DV(), U8(), iov, out);
                if (ready)
                    return ready.errno;
                if (canPark)
                    return waitInput(fd, iov, out);
                // A synchronous reader cannot wait (pipes-design). If every writer of
                // its pipe is suspended beneath it, nothing it runs can feed it: stop.
                const e = proc.fds.get(fd);
                const piped = e && e.kind === 'pipe' && e.end === 'r' && decideRead(s.pipes.get(e.pipeId), 'local', 'child') === 'nest';
                if (piped && readerStops(pipeWriterPids(s, e.pipeId), s.suspended))
                    throw pipeLimitExceeded(s);
                if (pumpSuspended(s, proc))
                    continue;
                // Nothing it can run, and a write end of its pipe is open (its next
                // write is a pending task): the end of input it would report is false.
                if (piped)
                    throw pipeLimitExceeded(s);
                DV().setUint32(out, 0, true);
                return 0;
            }
        },
        write: (fd, bytes) => {
            if (proc.killedBy)
                throw new Signalled(proc.killedBy);
            return writeThroughFd(s, proc, fd, bytes);
        },
        writeGate: (fd) => {
            if (!canPark)
                return undefined;
            const pp = writePipe(s, proc, fd);
            if (!pp)
                return s.output.ready();
            if (!pp || !atCapacity(pp))
                return undefined;
            // Parks until the pipe drains below its capacity or its readers leave;
            // the write is then checked again from the top (SIGPIPE included).
            return waitChild(proc, complete => { pp.writeW.push({ proc, complete }); });
        },
        poll: (input, output, count, used) => {
            const subscriptions = readSubs(DV(), input, count);
            const ready = emitReady(s, proc, DV(), output, subscriptions);
            if (ready) {
                DV().setUint32(used, ready, true);
                return 0;
            }
            if (!canPark) {
                waitForDeadline(s, proc, subscriptions);
                DV().setUint32(used, emitReady(s, proc, DV(), output, subscriptions), true);
                return 0;
            }
            return (async () => {
                for (;;) {
                    await new Promise(resolve => setTimeout(resolve, 1));
                    if (proc.killedBy)
                        throw new Signalled(proc.killedBy);
                    const count = emitReady(s, proc, DV(), output, subscriptions);
                    if (count) {
                        DV().setUint32(used, count, true);
                        return 0;
                    }
                }
            })();
        },
    };
    const argv = proc.ctx.execArgv;
    const env = proc.ctx.execEnv.length ? proc.ctx.execEnv : s.environ;
    const writeStrings = (values, pointers, buffer) => {
        for (const value of values) {
            const bytes = te.encode(value);
            DV().setUint32(pointers, buffer, true);
            pointers += 4;
            U8().set(bytes, buffer);
            buffer += bytes.length;
            U8()[buffer++] = 0;
        }
        return 0;
    };
    const wasi = {
        ...makeWasiFs(s, proc, DV, U8, io, memory, !canPark),
        args_sizes_get: (a, b) => { DV().setUint32(a, argv.length, true); DV().setUint32(b, argv.reduce((n, v) => n + utf8Length(v) + 1, 0), true); return 0; },
        args_get: (a, b) => writeStrings(argv, a, b),
        environ_sizes_get: (a, b) => { DV().setUint32(a, env.length, true); DV().setUint32(b, env.reduce((n, v) => n + utf8Length(v) + 1, 0), true); return 0; },
        environ_get: (a, b) => writeStrings(env, a, b),
        proc_exit: (code) => { throw new Exit(code); },
    };
    const fs = canPark ? s.fs : s.fs.synchronous;
    if (!fs)
        throw new Error('Synchronous authority is unavailable');
    const native = {
        startup_cwd: (ptr, capacity) => { const bytes = te.encode(proc.cwd); if (!capacity)
            return bytes.length; if (capacity <= bytes.length)
            return -37; U8().set(bytes, ptr); U8()[ptr + bytes.length] = 0; return bytes.length; },
        identity: (field) => { if ((field & 7) === 4) {
            const previous = s.cred.umask;
            s.cred = { ...s.cred, umask: field >>> 3 };
            return previous;
        } return [s.cred.uid, s.cred.gid, proc.pid, proc.ppid][field] ?? 0; },
        ...metadataImports(s, proc, DV, U8, fs),
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
    const nativeImports = canPark ? { ...native, stat_metadata: new WebAssembly.Suspending(native.stat_metadata), chmod: new WebAssembly.Suspending(native.chmod), fchmod: new WebAssembly.Suspending(native.fchmod), chown: new WebAssembly.Suspending(native.chown), account: new WebAssembly.Suspending(native.account) } : native;
    instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: imports, nimbus_proc: nativeImports });
    const start = instance.exports._start;
    function isEntry(value) { return typeof value === 'function'; }
    if (!isEntry(start))
        throw new Error('WASI child has no _start export');
    let code = 0;
    let signal = 0;
    try {
        if (canPark)
            await WebAssembly.promising(start)();
        else
            start();
    }
    catch (error) {
        if (error instanceof Exit)
            code = error.code;
        else if (error instanceof Signalled)
            signal = error.signal;
        else
            throw error;
    }
    finishProc(s, proc, code, signal);
}
async function doFork(s, parent, source) {
    const childPid = s.pidNext++;
    const childFds = new Map();
    for (const [fd, e] of parent.fds) {
        childFds.set(fd, e.kind === 'authority' ? { ...e, handle: await s.fs.dup(e.handle.id) } : shareEntry(e));
        if (e.kind === 'pipe')
            bumpPipe(s, e, 1);
    }
    // The parent exited while its descriptors were copied (a signal), and its
    // instance may be another process's now: the fork never happened.
    if (!s.procs.has(source.pid) || parent.pid !== source.pid || parent.incarnation !== source.incarnation) {
        for (const e of childFds.values())
            releaseEntry(s, e);
        return;
    }
    const pmem = parent.inst.exports.memory;
    // An exited process's instance, when one is idle, rather than a new one.
    const child = reincarnate(s, pmem.buffer.byteLength, childPid, parent.pid, childFds) ?? makeProc(s, childPid, parent.pid, childFds);
    child.cwd = parent.cwd;
    child.preopenMoved = new Map(parent.preopenMoved);
    const cmem = child.inst.exports.memory;
    if (cmem.buffer.byteLength < pmem.buffer.byteLength)
        cmem.grow((pmem.buffer.byteLength - cmem.buffer.byteLength) / PAGE);
    copyForkImage(s, parent, child, source);
    // The one global the child's rewind needs (the asyncify state is its own; __data_end and __heap_base are constants).
    child.inst.exports.__stack_pointer.value = parent.inst.exports.__stack_pointer.value;
    child.captures = source.captures;
    const total = s.procs.size;
    if (total * cmem.buffer.byteLength > s.stats.memPeak)
        s.stats.memPeak = total * cmem.buffer.byteLength;
    child.ctx.resume = 0;
    child.ctx.rewinding = true;
    child.inst.exports.asyncify_start_rewind(child.captures.top);
    s.runnable.push(child);
    parent.ctx.resume = childPid;
    parent.ctx.rewinding = true;
    parent.inst.exports.asyncify_start_rewind(parent.captures.top);
    s.runnable.push(parent);
}
function doWait(s, proc) {
    const t = proc.ctx.waitTarget;
    let pid = null;
    if (t > 0) {
        // A named target still has to be this process's child; reaping another
        // process's child by pid is the same error, just harder to reach.
        const e = s.exitStatus.get(t);
        if (e && e.ppid === proc.pid)
            pid = t;
    }
    else {
        // `wait` with no target reaps one of MY children. This used to take the
        // first entry in the map regardless of parentage, so with two subshells
        // each having had a child exit, one could consume the other's status —
        // and then block forever waiting for a child already reaped elsewhere.
        for (const [p, e] of s.exitStatus) {
            if (e.ppid === proc.pid) {
                pid = p;
                break;
            }
        }
    }
    if (pid != null) {
        const st = s.exitStatus.get(pid).status;
        s.exitStatus.delete(pid);
        proc.ctx.resume = pid;
        proc.ctx.resumeStatus = st;
        resumeProc(proc);
    }
    else {
        s.waiters.push({ proc, targetPid: t });
    }
}
/** A child parked on a pipe is also woken when its virtual process dies. */
function waitChild(proc, register) {
    if (proc.killedBy)
        throw new Signalled(proc.killedBy);
    return new Promise(resolve => {
        const complete = () => { proc.cancelWaits?.delete(complete); resolve(); };
        (proc.cancelWaits ??= new Set()).add(complete);
        register(complete);
    });
}
function signalDisposition(proc, signal) {
    if (signal === 9)
        return 0;
    return proc.execIgnoredSignals === undefined
        ? proc.inst.exports.__nimbus_signal_disposition(signal)
        : (proc.execIgnoredSignals & (1n << BigInt(signal))) !== 0n ? 1 : 0;
}
/** Default terminating signals for virtual children, never host OS pids. */
function signalProc(s, caller, pid, signal) {
    if (!Number.isInteger(signal) || signal < 0 || signal >= 65)
        return -E.INVAL;
    if (pid <= 0)
        return -E.NOSYS;
    const victim = s.procs.get(pid);
    // POSIX permits probing a zombie until its parent reaps it.
    if (!victim)
        return s.exitStatus.has(pid) ? 0 : -E.SRCH;
    if (signal === 0)
        return 0;
    // Every virtual Bash process owns its instance/memory. Query the VICTIM,
    // not the caller currently executing kill. An exec'd child has reset its
    // caught handlers; consulting its old shell image would be incorrect.
    const disposition = signalDisposition(victim, signal);
    if (disposition === 1)
        return 0;
    if (disposition !== 0)
        return -E.NOSYS;
    switch (signal) {
        case 1:
        case 2:
        case 3:
        case 6:
        case 9:
        case 13:
        case 14:
        case 15: break;
        default: return -E.NOSYS;
    }
    if (victim === caller)
        throw new Signalled(signal);
    victim.killedBy = signal;
    s.runnable = s.runnable.filter(proc => proc !== victim);
    s.deferred = s.deferred.filter(proc => proc !== victim);
    s.waiters = s.waiters.filter(waiter => waiter.proc !== victim);
    s.suspended.delete(pid);
    for (const pipe of s.pipes.values()) {
        pipe.readW = pipe.readW.filter(waiter => !('proc' in waiter) || waiter.proc !== victim);
        pipe.writeW = pipe.writeW.filter(waiter => !('proc' in waiter) || waiter.proc !== victim);
    }
    s.stdin.waiters = s.stdin.waiters.filter(waiter => !('proc' in waiter) || waiter.proc !== victim);
    finishProc(s, victim, 0, signal);
    for (const complete of victim.cancelWaits ?? [])
        complete();
    wakeScheduler(s);
    return 0;
}
function finishProc(s, proc, code, signal = 0) {
    // A terminated JSPI child may unwind after its signal exit was published.
    // Never overwrite that status or wake a later wait with a second exit.
    if (!s.procs.has(proc.pid))
        return;
    // A wait status: the exit code in the second byte, or the killing signal in
    // the low seven bits (WIFSIGNALED), which bash reports as 128 + signal.
    const st = signal ? signal & 0x7f : (code & 0xff) << 8;
    s.procs.delete(proc.pid);
    // Pipes this exit is held on (pipe-rules holdsExit), taken before its own
    // write ends close. The root process is never held: its exit ends the run.
    const held = new Set();
    if (proc.ppid !== 0 && !signal) {
        for (const e of proc.fds.values()) {
            const pp = e.kind === 'pipe' && e.end === 'w' ? s.pipes.get(e.pipeId) : null;
            if (pp && holdsExit(pp, pipeHost(s), PIPE_CAPACITY))
                held.add(pp);
        }
    }
    if (held.size > 0)
        s.heldExits.set(proc.pid, { status: st, ppid: proc.ppid, pipes: held, sigpipe: false });
    for (const fd of [...proc.fds.keys()])
        closeFd(s, proc, fd);
    if (proc.ppid === 0)
        s.rootExit = signal ? 128 + signal : code;
    // A held exit is published when it settles (settleHeldExits), which may
    // already have happened above if this process read its own pipe.
    if (held.size === 0)
        publishExit(s, proc.pid, proc.ppid, st);
    proc.captures = proc.captures.emptied();
    retire(s, proc, signal);
}
/** Make `pid`'s wait status reapable, handing it to its parent's pending wait. */
function publishExit(s, pid, ppid, st) {
    s.exitStatus.set(pid, { status: st, ppid });
    for (let i = 0; i < s.waiters.length; i++) {
        const w = s.waiters[i];
        // Only the parent may be woken by this exit — a waiter in another subshell
        // is not waiting for this child, and waking it hands over a status that was
        // never its to claim.
        if (w.proc.pid === ppid && (w.targetPid === pid || w.targetPid <= 0)) {
            s.waiters.splice(i, 1);
            w.proc.ctx.resume = pid;
            w.proc.ctx.resumeStatus = st;
            s.exitStatus.delete(pid);
            resumeProc(w.proc);
            break;
        }
    }
}
// A task wakes the scheduler once, when it settles. The scheduler must not
// race the pending set on every wake: a task parked for a whole command (a
// child waiting on input) would collect a reaction per wake until it settles.
function queueSessionTask(s, task) {
    const pending = task.catch(error => { s.error = error instanceof Error ? error.message : String(error); });
    s.pending.add(pending);
    void pending.then(() => { s.pending.delete(pending); wakeScheduler(s); });
}
async function pump(s) {
    try {
        while (s.runnable.length || s.pending.size || s.deferred.length) {
            if (!s.runnable.length) {
                if (!s.sharedInput && s.stdin.waiters.length && !s.stdin.closed && s.stdin.queued === 0)
                    break;
                // A deferred child starts only once every pending fork and exec has
                // settled, so the stages it reads from exist and have run what they can.
                if (s.pending.size) {
                    await new Promise((resolve) => { s.wake = resolve; });
                    s.wake = null;
                    continue;
                }
                startDeferred(s);
                continue;
            }
            if (++s.steps > 5_000_000)
                throw new Error('bash-runner: runaway scheduler (>5M steps)');
            step(s, s.runnable.shift());
            if (s.rootExit !== null)
                break;
        }
    }
    catch (e) {
        s.error = String(e && e.stack || e && e.message || e);
    }
    const lost = await s.output.drain();
    if (lost)
        s.error = s.error || lost;
    const out = '', err = '';
    const control = s.outputControl ? { ...s.outputControl.values } : undefined;
    if (s.outputControl)
        for (const key of Object.keys(s.outputControl.values))
            delete s.outputControl.values[key];
    const stats = { ...s.stats, steps: s.steps, missingWasi: [...s.missingWasi] };
    if (s.error) {
        S = null;
        return { state: 'error', exitCode: 1, stdout: out, stderr: err, error: s.error, stats, control };
    }
    if (s.rootExit !== null || s.procs.size === 0) {
        const code = s.rootExit === null ? 0 : s.rootExit;
        await Promise.all(s.pending);
        S = null;
        if (s.processGone !== null)
            return { state: 'error', exitCode: code || 1, stdout: out, stderr: err, error: processGoneMessage(s.processGone), stats, control };
        return { state: 'exited', exitCode: code, stdout: out, stderr: err, stats, control };
    }
    if (s.stdin.waiters.length > 0) {
        return { state: 'need-input', exitCode: 0, stdout: out, stderr: err, stats, control };
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
globalThis.__bashStep = async function __bashStep(raw, supervisor) {
    if (typeof raw !== 'object' || raw === null || !('op' in raw)) {
        return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash-runner: step args must be an object with op' };
    }
    if (raw.op === 'feed') {
        const a = raw;
        if ((a.data !== undefined && typeof a.data !== 'string') || (a.eof !== undefined && typeof a.eof !== 'boolean')) {
            return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash-runner: malformed feed args' };
        }
        return globalThis.__bashFeed(raw);
    }
    if (raw.op === 'boot') {
        const a = raw;
        if (!Array.isArray(a.argv) || !Array.isArray(a.environ) || typeof a.cwd !== 'string') {
            return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash-runner: malformed boot args' };
        }
        // A synchronous view exists only in the isolate that owns the filesystem,
        // which is where a guest that cannot park runs; across a hop the stub
        // answers the property with a callable, so it is read only for that host.
        if (supervisor) {
            filesystem = supervisorFilesystem(supervisor, a.parking === 'none' ? supervisor.synchronous : undefined);
            outputSupervisor = supervisor;
            inputSupervisor = supervisor;
        }
        return globalThis.__bashBoot(raw);
    }
    return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: `bash-runner: unknown step op ${JSON.stringify(raw.op)}` };
};
globalThis.__bashBoot = async function __bashBoot(args) {
    try {
        S = newSession(args);
        initStdinQueued(S);
        const root = makeProc(S, S.pidNext++, 0, new Map([
            [0, { kind: 'stdin', terminal: !!args.stdinTty }], [1, { kind: 'stdout' }], [2, { kind: 'stderr' }],
            [3, { kind: 'preopen', vfsPath: '/', wasiPath: '/' }],
        ]));
        setupArena(root);
        S.runnable.push(root);
        return pump(S);
    }
    catch (e) {
        S = null;
        return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'boot failed: ' + String(e && e.message || e) };
    }
};
globalThis.__bashFeed = async function __bashFeed(args) {
    if (!S) {
        return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash facet has no active session (warm isolate recycled?)' };
    }
    try {
        if (args.data) {
            const b = te.encode(args.data);
            S.stdin.chunks.push(b);
            S.stdin.queued += b.length;
        }
        if (args.eof)
            S.stdin.closed = true;
        wakeStdin(S);
        return pump(S);
    }
    catch (e) {
        const s = S;
        S = null;
        return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'feed failed: ' + String(e && e.message || e) };
    }
};
