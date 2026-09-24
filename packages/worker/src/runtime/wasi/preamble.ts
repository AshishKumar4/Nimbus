/**
 * wasi/preamble.ts — the WASI snapshot_preview1 shim, as real TypeScript.
 *
 * This file IS the shim. It is not a mirror of one: `scripts/bundle-facet-workers.mjs`
 * esbuilds it into `wasi-instance.generated.ts`, and `wasi-instance.ts` re-exports
 * that as `WASI_INSTANCE_PREAMBLE_SRC` — the string every runner splices into its
 * facet module. The same pattern virtual-socket-kernel.ts already uses.
 *
 * Until this move the shim lived inside a template literal, so no type checker had
 * ever read it. The syscall surface with the highest defect density in the tree was
 * the one part of it a compiler could not see.
 *
 * Constraints the build imposes on this file, all asserted by the bundler:
 *   - Every symbol a facet reaches (`__wasiInitFS`, `__wasiMakeImports`, `fdTable`,
 *     `__wasiRunStart`, `__wasiRunStartAsync`) must stay a
 *     TOP-LEVEL declaration. Callers append `export { … }` to the emitted string.
 *   - Nothing may be imported for its value. Type-only imports are erased and are
 *     the only kind permitted; a value import would become a bare identifier in a
 *     scope that has no module system.
 *   - `wasi-threads.ts` is concatenated after this and shares one evaluated scope.
 */
import type { AcceptedVirtualConnection, VirtualSocketKernel } from '@nimbus-sh/core/runtime/virtual-socket-kernel.js';
import type {
  Errno,
  FdEntry,
  ListenerFdEntry,
  ParkableImport,
  SyscallResult,
  WasiFsState,
  WasiImports,
  WasiInitOptions,
  WasiInstanceBundle,
  WasiMakeImportsOptions,
  WasiParkableTable,
  WasiPollEvent,
  WasiRunResult,
  WasiSocket,
  WasiStartInstance,
  WasiSupervisorStub,
  WasiSyscallFn,
  WasiThreadScheduler,
  WriteU32LE,
} from '@nimbus-sh/core/runtime/wasi/types.js';

import {
  AuthorityLookupCache,
  installAuthorityFilesystem,
  WASI_ACCEPTED_PATH_PREFIX,
  WASI_LISTEN_PATH_PREFIX,
  WASI_TCP_PATH_PREFIX,
} from '@nimbus-sh/core/runtime/wasi/filesystem.js';
import { supervisorFilesystem } from '@nimbus-sh/core/runtime/vfs-supervisor.js';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '@nimbus-sh/core/constants.js';

// errno constants
const __WASI_ESUCCESS       = 0;
const __WASI_EAGAIN         = 6;
const __WASI_EACCES         = 2;
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
const __WASI_ESPIPE         = 70;
const __WASI_ETIMEDOUT      = 73;
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
// fdflags (fd_write / path_open) — bit 0 is O_APPEND.
const __WASI_FDFLAGS_APPEND = 1;
const __WASI_FDFLAGS_NONBLOCK = 4;
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
const __WASI_RIGHT_FD_READ  = 1n << 1n;
const __WASI_RIGHT_FD_WRITE = 1n << 6n;
// WASI socket and polling support B7: sock_shutdown SD flags.
const __WASI_SDFLAGS_RD = 1;
const __WASI_SDFLAGS_WR = 2;
// WASI socket and polling support B8: poll_oneoff subscription / event types.
const __WASI_EVENTTYPE_CLOCK    = 0;
const __WASI_EVENTTYPE_FD_READ  = 1;
const __WASI_EVENTTYPE_FD_WRITE = 2;
const __WASI_SUBCLOCKFLAGS_ABSTIME = 1;  // SUBSCRIPTION_CLOCK_ABSTIME

// WASI socket and polling support B7: resolved at preamble module-init via dynamic import.
// CF docs: "TCP sockets cannot be created in global scope and shared
// across requests" — so we only IMPORT the module here (cheap symbol
// resolution); the actual connect() call lives inside path_open which
// runs at facet-handler time (i.e., within WorkerEntrypoint.execute()).
let __cfSocketConnect: typeof import('cloudflare:sockets').connect | null = null;
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

class __WasiExit { declare code: number; constructor(code: number) { this.code = code | 0; } }

// The device a pathless descriptor (stdio, a socket) reports in fd_filestat_get.
// Above any device the authority can hand out, so a fd-numbered inode on it
// never collides with a file's (dev, ino).
const __WASI_STREAM_DEV = 1n << 32n;

// ─── Filesystem state ───────────────────────────────────────────────────
//
// __wasiInitFS({ root, preopens, residentFileCap? }) installs a per-call
// filesystem view:
//   root      string  — canonical session root, e.g. 'home/user'.
//   preopens  Array<{ wasiPath, vfsPath }> — fd>=3 preopens (in order).
//
// There is no in-facet copy of the filesystem. Every file and directory
// syscall is answered by the authority codec (wasi/filesystem.ts) through the
// supervisor stub __wasiAdoptSupervisor installs, reading and writing the same
// inodes the shell does. What this module keeps is the descriptor table's
// non-file kinds: stdio, sockets, listeners and the preopen roots.
//
// Starting empty rather than null keeps the invariant structural: a syscall
// before init answers EBADF against an empty descriptor table, which is true,
// rather than trapping the guest.
function __wasiEmptyFS(): WasiFsState {
  return { root: '', residentFileCap: WASI_RESIDENT_FILE_CAP_BYTES };
}
let __wasiFS: WasiFsState = __wasiEmptyFS();
let __wasiPreopens: Array<{ fd: number; wasiPath: string; vfsPath: string }> = [];

// ── Threads ──────────────────────────────────────────────────────────────
//
// The green-thread scheduler for this process, when the guest is a
// wasi-threads build; null otherwise, which is every runtime today. Held here
// rather than passed through every call because one facet is one process, the
// same reason __wasiFS and __wasiSup are. The WASI layer reads it for exactly
// two things — releasing the scheduler token while a syscall parks, and
// sched_yield — and wasi-threads.ts owns everything else about it.
let __wasiThreads: WasiThreadScheduler | null = null;

// ── Live backing store ───────────────────────────────────────────────────
//
// The supervisor stub. Every filesystem call the guest makes is answered by
// the authority codec (wasi/filesystem.ts) through it; absent (unit tests,
// compute-only instances) the guest has stdio, sockets and clocks but no
// files, and a file syscall answers EBADF.
let __wasiSup: WasiSupervisorStub | null = null;

// Lookups answered from memory between resumptions (AuthorityLookupCache).
// Per process, like the stub: a fresh init drops them, and every adoption is
// an entry from outside that the next lookup revalidates against.
const __wasiLookups = new AuthorityLookupCache();

// Adopting is idempotent and never downgrades. A resident process re-enters
// through routed fetch/handleHttpRequest hops that resolve the entrypoint
// WITHOUT a supervisor in env; clearing the live stub on those hops would
// strand the process.
export function __wasiAdoptSupervisor(sup: WasiSupervisorStub | null): void {
  __wasiLookups.resumed();
  if (sup) __wasiSup = sup;
}

// A guest-visible path in canonical form: no leading '/', no '..', no double
// slashes. The socket path prefixes are matched against it.
function __wasiCanonicalize(p: string): string {
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


export function __wasiInitFS(opts: WasiInitOptions): void {
  // A fresh init is a fresh process: no supervisor adopted yet. Pools reuse an
  // isolate across calls, so the previous tenant's stub must not answer the
  // next program's syscalls.
  __wasiSup = null;
  __wasiLookups.forget();
  __wasiFS = {
    root: __wasiCanonicalize(opts.root || ''),
    // Largest regular file the codec answers from a resident copy.
    residentFileCap: Number(opts.residentFileCap ?? WASI_RESIDENT_FILE_CAP_BYTES),
  };
  // Reset fd table baseline; install preopens as fd 3, 4, 5, ...
  // Emptied rather than replaced: the authority codec and the socket helpers
  // are handed this Map, and a swap would leave half of them writing into a
  // table nothing reads.
  __wasiPreopens = [];
  fdTable.clear();
  fdTable.set(0, { kind: 'stdin' });
  fdTable.set(1, { kind: 'stdout' });
  fdTable.set(2, { kind: 'stderr' });
  nextFd = 3;
  for (const po of (opts.preopens || [])) {
    const fd = __wasiAllocateFd();
    const vfsPath = __wasiCanonicalize(po.vfsPath);
    fdTable.set(fd, { kind: 'preopen', wasiPath: po.wasiPath, vfsPath });
    __wasiPreopens.push({ fd, wasiPath: po.wasiPath, vfsPath });
  }
}


// The guest-visible absolute path a path_* call names. wasi-libc resolves an
// absolute path against its longest matching preopen and passes the REMAINDER
// (e.g. 'dev/tcp/127.0.0.1/8790' under the '/' preopen), so a raw prefix test
// on pathArg only ever matches hand-written wasm that skips libc.
function __wasiGuestPath(baseFd: number, pathArg: string): string {
  if (pathArg.startsWith('/')) return pathArg;
  const base = fdTable.get(baseFd);
  if (!base || base.kind !== 'preopen') return pathArg;
  return base.wasiPath.endsWith('/') ? base.wasiPath + pathArg : base.wasiPath + '/' + pathArg;
}

// Loopback names resolve to the session itself, which Cloudflare gives a
// Worker no outbound TCP route to. They go to the virtual socket kernel
// instead — the same loopback the shell's curl and node's patched fetch use.
function __wasiIsLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '::' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// Why a socket open failed, for guests whose errno alone is too coarse to
// explain it (e.g. a facet with no supervisor binding for loopback routing).
// Adapters read it off globalThis and append it to the raised error.
globalThis.__nimbusWasiLastSocketError = '';

function __wasiConnectLoopback(port: number): { errno: Errno; socket: WasiSocket | null } {
  const kernel = globalThis.__nimbusVirtualSockets;
  if (!kernel || typeof kernel.connectStream !== 'function') {
    globalThis.__nimbusWasiLastSocketError =
      'this process has no Nimbus virtual socket kernel, so in-session ports cannot be dialed';
    return { errno: __WASI_ENOSYS, socket: null };
  }
  try {
    return { errno: __WASI_ESUCCESS, socket: kernel.connectStream(port) };
  } catch (e) {
    globalThis.__nimbusWasiLastSocketError = ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
    return { errno: __WASI_ECONNREFUSED, socket: null };
  }
}

function __wasiConnectRemote(host: string, port: number): { errno: Errno; socket: WasiSocket | null } {
  if (typeof __cfSocketConnect !== 'function') {
    // cloudflare:sockets unavailable in this runtime. Report ENOSYS so
    // the user program sees a clear errno rather than a hang.
    globalThis.__nimbusWasiLastSocketError = 'outbound TCP is unavailable in this runtime';
    return { errno: __WASI_ENOSYS, socket: null };
  }
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
    return { errno: __WASI_ESUCCESS, socket: __cfSocketConnect({ hostname: host, port }, { allowHalfOpen: true }) };
  } catch (e) {
    // Synchronous errors from connect() (e.g. invalid address). Surface
    // as ECONNREFUSED since the user-observable behavior is the same.
    globalThis.__nimbusWasiLastSocketError = ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
    return { errno: __WASI_ECONNREFUSED, socket: null };
  }
}

// WASI socket and polling support B7 helper: open a TCP socket when path_open
// is invoked on a /dev/tcp/<host>/<port> synthetic path. Remote hosts go
// through cloudflare:sockets; loopback goes through the virtual socket kernel.
// Both produce the SAME kind:'socket' fd — everything downstream (fd_read,
// fd_write, sock_*, poll_oneoff, fd_close) is identical for either peer.
// Returns a WASI errno and writes the new fd to fdOutPtr.
function __wasiOpenTcpSocket(pathArg: string, fdflags: number, fdOutPtr: number, writeU32LE: WriteU32LE): Errno {
  // pathArg shape: "/dev/tcp/<host>/<port>".
  const tail = pathArg.substring(WASI_TCP_PATH_PREFIX.length);
  const slashIdx = tail.lastIndexOf('/');
  if (slashIdx <= 0 || slashIdx === tail.length - 1) return __WASI_EINVAL;
  const host = tail.substring(0, slashIdx);
  const portStr = tail.substring(slashIdx + 1);
  const port = parseInt(portStr, 10);
  if (!host || !(port > 0 && port < 65536)) return __WASI_EINVAL;
  const opened = __wasiIsLoopbackHost(host)
    ? __wasiConnectLoopback(port)
    : __wasiConnectRemote(host, port);
  if (opened.errno !== __WASI_ESUCCESS) return opened.errno;
  writeU32LE(fdOutPtr, __wasiAdoptSocket(opened.socket as WasiSocket, fdflags));
  return __WASI_ESUCCESS;
}

function __wasiKernelOrNull(what: string): VirtualSocketKernel | null {
  const kernel = globalThis.__nimbusVirtualSockets;
  if (kernel) return kernel;
  globalThis.__nimbusWasiLastSocketError =
    'this process has no Nimbus virtual socket kernel, so ' + what;
  return null;
}

// Open a listening socket as a descriptor. The port must already be bound; the
// descriptor is the accept queue, not the bind.
function __wasiOpenListener(pathArg: string, fdflags: number, fdOutPtr: number, writeU32LE: WriteU32LE): Errno {
  const port = parseInt(pathArg.substring(WASI_LISTEN_PATH_PREFIX.length), 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return __WASI_EINVAL;
  const kernel = __wasiKernelOrNull('ports cannot be listened on');
  if (!kernel) return __WASI_ENOSYS;
  // A guest opening this path IS the guest asking to listen — that is what
  // listen(2) compiles to for a program built against wasi-libc. Refusing an
  // unbound port made the path usable only by a runtime that could reach out to
  // JS and bind it first (ruby, through __nimbusRubySockets), so a plain WASI
  // server got ENOTCONN from listen and could never serve. Binding here is
  // additive: no guest could previously succeed on an unbound port.
  if (!kernel.listeners.has(port)) {
    try {
      kernel.listen(port);
    } catch (e) {
      globalThis.__nimbusWasiLastSocketError =
        'port ' + port + ' could not be bound: ' + ((e as Error) && (e as Error).message ? (e as Error).message : String(e));
      return __WASI_ENOTCONN;
    }
    // The supervisor has to learn about the port, or nothing outside the
    // session can route to it: bound is not served.
    const announce = Reflect.get(globalThis, '__nimbusVirtualSocketDidListen') as
      ((p: number) => void) | undefined;
    if (typeof announce === 'function') announce(port);
  }
  const fd = __wasiAllocateFd();
  fdTable.set(fd, { kind: 'listener', port, fdflags: fdflags | 0 });
  writeU32LE(fdOutPtr, fd);
  return __WASI_ESUCCESS;
}

// accept(2) over a listening descriptor. Blocking by default (the read parks
// until a connection arrives); O_NONBLOCK yields EAGAIN on an empty queue.
// Either way the bytes handed back are the accepted connection's id, which the
// guest then opens as a socket descriptor.
async function __wasiAcceptRead(entry: ListenerFdEntry, iovsPtr: number, iovsLen: number, nreadPtr: number, writeU32LE: WriteU32LE, view: () => DataView, u8: () => Uint8Array): Promise<Errno> {
  const kernel = __wasiKernelOrNull('connections cannot be accepted');
  if (!kernel) return __WASI_ENOSYS;
  try {
    let accepted: AcceptedVirtualConnection | null;
    if ((entry.fdflags & __WASI_FDFLAGS_NONBLOCK) !== 0) {
      accepted = kernel.acceptNow(entry.port);
      if (!accepted) { writeU32LE(nreadPtr, 0); return __WASI_EAGAIN; }
    } else {
      accepted = await kernel.accept(entry.port);
    }
    const bytes = new TextEncoder().encode(String(accepted.id) + '\n');
    const dv = view();
    const memU8 = u8();
    let total = 0;
    for (let i = 0; i < iovsLen && total < bytes.length; i++) {
      const iov = iovsPtr + i * 8;
      const bufPtr = dv.getUint32(iov, true);
      const bufLen = dv.getUint32(iov + 4, true);
      const n = Math.min(bufLen, bytes.length - total);
      memU8.set(bytes.subarray(total, total + n), bufPtr);
      total += n;
    }
    writeU32LE(nreadPtr, total);
    return __WASI_ESUCCESS;
  } catch (e) {
    // A rejected Suspending import traps in the guest with no diagnosis, so
    // failures become an errno plus a recorded reason instead.
    globalThis.__nimbusWasiLastSocketError = ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
    return __WASI_ENOTCONN;
  }
}

// Bind an already-accepted kernel connection to a file descriptor, so a
// server's accepted socket is the same kind of fd as a client's dialed one.
function __wasiOpenAcceptedSocket(pathArg: string, fdflags: number, fdOutPtr: number, writeU32LE: WriteU32LE): Errno {
  const id = parseInt(pathArg.substring(WASI_ACCEPTED_PATH_PREFIX.length), 10);
  if (!Number.isInteger(id) || id <= 0) return __WASI_EINVAL;
  const kernel = globalThis.__nimbusVirtualSockets;
  if (!kernel || typeof kernel.streamFor !== 'function') {
    globalThis.__nimbusWasiLastSocketError =
      'this process has no Nimbus virtual socket kernel, so accepted connections cannot be bound';
    return __WASI_ENOSYS;
  }
  let socket: WasiSocket;
  try {
    socket = kernel.streamFor(id);
  } catch (e) {
    globalThis.__nimbusWasiLastSocketError = ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
    return __WASI_ENOTCONN;
  }
  writeU32LE(fdOutPtr, __wasiAdoptSocket(socket, fdflags));
  return __WASI_ESUCCESS;
}

// The one place a socket becomes a file descriptor. Anything in Cloudflare's
// Socket shape qualifies: a cloudflare:sockets connection, a dialed loopback
// connection, or an accepted one. Every socket fd in the table comes from here,
// which is why nothing downstream has to tell them apart.
function __wasiAdoptSocket(socket: WasiSocket, fdflags: number): number {
  const fd = __wasiAllocateFd();
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
  return fd;
}

// ─── fd table ──────────────────────────────────────────────────────────
//
// Entry shapes this module owns:
//   { kind: 'stdin' | 'stdout' | 'stderr' }
//   { kind: 'preopen', wasiPath, vfsPath, rights? }
//   { kind: 'socket' | 'listener', socket, reader, writer, readBuf, ... }
// and the authority codec's (wasi/filesystem.ts), which shares the table:
//   { kind: 'authority', handle, type, rights, ... }   a live descriptor
//   { kind: 'resident',  stat, bytes, position, ... }  a read-only copy
//
// WASI socket and polling support B6: 'rights' is an optional BigInt mask. When set, fd_fdstat_get
// returns it (instead of the wide-open default). fd_fdstat_set_rights
// writes to it. The mask is advisory for this module's own kinds; the codec
// enforces rights on its descriptors.
export const fdTable = new Map<number, FdEntry>();
let nextFd = 3;
// The only source of descriptor numbers. A second counter — one for files, one
// for sockets — hands the same number out twice and the later open silently
// destroys the earlier fd's entry.
function __wasiAllocateFd(): number { return nextFd++; }



// ─── makeImports ────────────────────────────────────────────────────────

// ── Park watchdog ────────────────────────────────────────────────────────
//
// Measured on deployed throwaway workers (probe a8be311831c0c183a): a wasm
// stack suspended ACROSS REQUESTS resumes correctly inside a DO Facet, but
// only up to roughly 15-18 seconds of idle. Past that ceiling the promise
// NEVER SETTLES — it does not reject, it simply never resolves. An unguarded
// park therefore wedges the process forever with nothing raised anywhere,
// which is strictly worse than failing: nothing to log, nothing to retry.
//
// Every import that parks on a HOST promise therefore parks against a deadline
// set with margin below the measured floor, and on expiry resolves to EAGAIN —
// an errno the guest's own retry logic already handles — instead of hanging.
// That is the `parkable` list below, and it is exactly the set of imports that
// are also Suspending-wrapped, minus one.
//
// sched_yield is the exception, and deliberately so: it is Suspending-wrapped
// in a threads build but is NOT in `parkable`, because it does not wait on the
// host at all. It waits on THIS scheduler, through wasi-threads' `yieldNow`,
// which already moves the thread to runnable, queues it and dispatches. Sending
// it through `parkIo` as well would mark a queued thread parked and inflate
// pendingIo. `withParkDeadline` and `yieldNow` are alternatives, not layers —
// see the integration table at the top of wasi-threads.ts. The earlier wording
// here claimed every suspending import was deadline-guarded, which read as a
// bug in the code rather than an imprecision in the sentence.
//
// This guards the PROMISE, not the suspension mechanism, so it serves an
// Asyncify-unwound guest exactly as well as a JSPI-suspended one.
const __WASI_PARK_CEILING_MS  = 15000;  // measured; deadline must stay under
const __WASI_PARK_DEADLINE_MS = 10000;
void __WASI_PARK_CEILING_MS;

function withParkDeadline(fn: WasiSyscallFn): WasiSyscallFn {
  return function parkGuarded(this: unknown, ...args: never[]) {
    const r = fn.apply(this, args);
    // A cache hit or a sync errno is passed straight through: only a real
    // park is guarded, so this costs nothing on the synchronous path.
    if (!r || typeof (r as Promise<Errno>).then !== 'function') return r;
    const guarded = new Promise<Errno>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(__WASI_EAGAIN);
      }, __WASI_PARK_DEADLINE_MS);
      const finish = (value: Errno) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      (r as Promise<Errno>).then(finish, () => finish(__WASI_EAGAIN));
    });
    // A real park is also the moment a threaded process must let a peer run:
    // this is the single point every blocking syscall already goes through,
    // so the scheduler needs no per-import wiring.
    return __wasiThreads ? __wasiThreads.parkIo(guarded) : guarded;
  };
}

export function __wasiMakeImports(opts: WasiMakeImportsOptions): WasiInstanceBundle {
  // opts: { argv, env, getMemory, abi?, parking?, threads?, stdoutWrite?, stderrWrite? }
  //
  // WASI shipped two wire ABIs and both are still in the world: the modern
  // sysroot handed to user programs is preview1, while the binji-2020 clang and
  // wasm-ld toolchain is preview0 ('wasi_unstable'). Every function name and
  // every signature is identical between them, so a mismatch never traps — it
  // silently returns wrong numbers. Exactly two encodings differ, and both are
  // parameters of this one implementation rather than grounds for a second:
  // fd_seek's whence constants are permuted, and filestat is 56 bytes with a
  // u32 nlink instead of 64 with a u64.
  const preview0 = opts.abi === 'preview0';
  // preview0: CUR=0, END=1, SET=2. preview1: SET=0, CUR=1, END=2.
  const WHENCE_SET = preview0 ? 2 : 0;
  const WHENCE_CUR = preview0 ? 0 : 1;
  const WHENCE_END = preview0 ? 1 : 2;
  const argv = opts.argv || [];
  const envArr: string[] = [];
  if (opts.env) for (const k of Object.keys(opts.env)) envArr.push(k + '=' + opts.env[k]);
  const utf8enc = new TextEncoder();
  const utf8dec = new TextDecoder();

  function view() { return new DataView(opts.getMemory().buffer); }
  function u8()   { return new Uint8Array(opts.getMemory().buffer); }
  function writeU32LE(off: number, v: number): void { view().setUint32(off, v >>> 0, true); }
  function writeU64LE(off: number, v: bigint | number): void {
    const dv = view();
    if (typeof v === 'bigint') { dv.setBigUint64(off, v, true); return; }
    const lo = (v >>> 0);
    const hi = Math.floor(v / 4294967296) >>> 0;
    dv.setUint32(off,     lo, true);
    dv.setUint32(off + 4, hi, true);
  }
  function readPath(ptr: number, len: number): string {
    const bytes = u8().subarray(ptr, ptr + len);
    return utf8dec.decode(bytes);
  }
  let stdoutBuf = '';
  let stderrBuf = '';
  // A sink and the readable buffer are mutually exclusive: with a sink the
  // output is forwarded live (the resident TUI runs for hours), so accumulating
  // it too would grow stdoutBuf/stderrBuf without bound inside the facet. Absent
  // a sink the buffer stays readable via getStdout()/getStderr().
  function appendStream(kind: 'stdout' | 'stderr', bytes: Uint8Array): void {
    const s = utf8dec.decode(bytes);
    if (kind === 'stdout') {
      if (opts.stdoutWrite) opts.stdoutWrite(s);
      else stdoutBuf += s;
    } else {
      if (opts.stderrWrite) opts.stderrWrite(s);
      else stderrBuf += s;
    }
  }

  /** Scatter the given bytes across the iovec list; returns bytes consumed. */
  function scatterIovs(bytes: Uint8Array, iovsPtr: number, iovsLen: number, dv: DataView, memU8: Uint8Array): number {
    let done = 0;
    for (let i = 0; i < iovsLen && done < bytes.length; i++) {
      const iov = iovsPtr + i * 8;
      const bufPtr = dv.getUint32(iov, true);
      const bufLen = dv.getUint32(iov + 4, true);
      const n = Math.min(bufLen, bytes.length - done);
      if (n <= 0) break;
      memU8.set(bytes.subarray(done, done + n), bufPtr);
      done += n;
      if (n < bufLen) break;
    }
    return done;
  }
  /** Total capacity of an iovec list. */
  function iovsCapacity(iovsPtr: number, iovsLen: number, dv: DataView): number {
    let total = 0;
    for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovsPtr + i * 8 + 4, true);
    return total;
  }

  const imports: WasiImports = {
    // ── args / env ──
    args_get(argvPtr, argvBufPtr) {
      let buf = argvBufPtr;
      const memU8 = u8();
      const dv = view();
      for (let i = 0; i < argv.length; i++) {
        dv.setUint32(argvPtr + i * 4, buf, true);
        const bytes = utf8enc.encode(argv[i] + '\0');
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
        const bytes = utf8enc.encode(envArr[i] + '\0');
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
      const entry = fdTable.get(fd) as FdEntry;
      if (entry.kind === 'preopen') return __WASI_ESUCCESS;
      // WASI socket and polling support B7: best-effort close of socket streams. The actual
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
      if (!entry) return __WASI_EBADF;
      // wasi-libc maps read(2) to fd_read for every fd kind. A socket fd
      // reads via the JSPI socket body (returns a Promise the Suspending
      // wrapper awaits); a directory fd is EISDIR per POSIX, not EBADF.
      if (entry.kind === 'socket') return __rawSockRecv(fd, iovsPtr, iovsLen, 0, nreadPtr, 0);
      // Reading a listening socket is accept(2); the Suspending wrapper awaits
      // the returned Promise, so the guest's accept loop simply blocks.
      if (entry.kind === 'listener') {
        return __wasiAcceptRead(entry, iovsPtr, iovsLen, nreadPtr, writeU32LE, view, u8);
      }
      if (entry.kind === 'preopen') return __WASI_EISDIR;
      return __WASI_EBADF;
    },

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      // wasi-libc maps write(2) to fd_write for every fd kind; a socket fd
      // sends via the JSPI socket body (returns a Promise).
      const sockEntry = fdTable.get(fd);
      if (sockEntry && sockEntry.kind === 'socket') {
        return __rawSockSend(fd, iovsPtr, iovsLen, 0, nwrittenPtr);
      }
      if (fd !== 1 && fd !== 2) return __WASI_EBADF;
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
      let combined: Uint8Array;
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

    fd_seek(fd, _offsetArg, _whence, _newOffsetPtr) {
      // Seeking a pipe/tty is ESPIPE — lets guests detect non-seekable
      // stdio (POSIX lseek on a pipe). A socket is a non-seekable stream too.
      if (fd === 0 || fd === 1 || fd === 2) return __WASI_ESPIPE;
      const entry = fdTable.get(fd);
      if (entry && (entry.kind === 'socket' || entry.kind === 'listener')) return __WASI_ESPIPE;
      return __WASI_EBADF;
    },

    fd_tell(fd, _offsetPtr) {
      if (fd === 0 || fd === 1 || fd === 2) return __WASI_ESPIPE;
      const entry = fdTable.get(fd);
      if (entry && (entry.kind === 'socket' || entry.kind === 'listener')) return __WASI_ESPIPE;
      return __WASI_EBADF;
    },

    fd_fdstat_get(fd, statPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      const dv = view();
      let ftype = __WASI_FT_UNKNOWN;
      if (entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
        ftype = __WASI_FT_CHARACTER_DEVICE;
      } else if (entry.kind === 'preopen') {
        ftype = __WASI_FT_DIRECTORY;
      } else if (entry.kind === 'socket' || entry.kind === 'listener') {
        ftype = __WASI_FT_SOCKET_STREAM;  // WASI socket and polling support B7
      }
      dv.setUint8(statPtr, ftype);
      dv.setUint8(statPtr + 1, 0);
      dv.setUint16(statPtr + 2, (entry.fdflags || 0) & 0xFFFF, true);
      dv.setUint32(statPtr + 4, 0, true);
      // WASI socket and polling support B6: honor entry.rights when set, else wide-open default.
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
      // Sockets track the mask too: guests set O_NONBLOCK on a socket and
      // then read it back through fd_fdstat_get.
      if (entry.kind === 'socket' || entry.kind === 'listener') entry.fdflags = flags;
      return __WASI_ESUCCESS;
    },

    // WASI socket and polling support B6: track per-fd rights mask. Callers narrow their own caps;
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
    path_open(baseFd, dirflags, pathPtr, pathLen, oflags, rightsBase, _rightsInheriting, fdflags, fdOutPtr) {
      const pathArg = readPath(pathPtr, pathLen);

      // WASI socket and polling support B7: synthetic /dev/tcp/<host>/<port> path — open a TCP
      // socket (remote via cloudflare:sockets, loopback via the virtual
      // socket kernel). Bash-like convention.
      const guestPath = __wasiGuestPath(baseFd, pathArg);
      if (guestPath.startsWith(WASI_TCP_PATH_PREFIX)) {
        return __wasiOpenTcpSocket(guestPath, fdflags, fdOutPtr, writeU32LE);
      }
      if (guestPath.startsWith(WASI_ACCEPTED_PATH_PREFIX)) {
        return __wasiOpenAcceptedSocket(guestPath, fdflags, fdOutPtr, writeU32LE);
      }
      if (guestPath.startsWith(WASI_LISTEN_PATH_PREFIX)) {
        return __wasiOpenListener(guestPath, fdflags, fdOutPtr, writeU32LE);
      }
      // Every other path is the authority codec's; without a supervisor there
      // is no filesystem to open it on.
      return __WASI_EBADF;
    },

    // ── path_create_directory ──
    path_create_directory(_baseFd, _pathPtr, _pathLen) { return __WASI_EBADF; },

    path_remove_directory(_baseFd, _pathPtr, _pathLen) { return __WASI_EBADF; },

    path_unlink_file(_baseFd, _pathPtr, _pathLen) { return __WASI_EBADF; },

    // ── path_rename (atomic; overwrites destination) ──
    path_rename(_srcFd, _srcPathPtr, _srcPathLen, _dstFd, _dstPathPtr, _dstPathLen) { return __WASI_EBADF; },

    // ── path_filestat_get ──
    path_filestat_get(_baseFd, _lookupflags, _pathPtr, _pathLen, _statPtr) { return __WASI_EBADF; },

    // WASI socket and polling support B2: real path_filestat_set_times. Honors ATIM/ATIM_NOW/
    // MTIM/MTIM_NOW flags. Spec: atim_ns and mtim_ns are absolute
    // nanosecond timestamps; flags select which fields to update + whether
    // to clamp to "now". ENOENT if path doesn't exist.
    path_filestat_set_times(_baseFd, _lookupflags, _pathPtr, _pathLen, _atimArg, _mtimArg, _fstflags) { return __WASI_EBADF; },

    // WASI socket and polling support B3: read the target string of a symlink. Spec:
    //   path_readlink(fd, path, path_len, buf, buf_len, *bufused)
    // Truncates to buf_len; writes actual bytes to *bufused.
    path_readlink(_baseFd, _pathPtr, _pathLen, _bufPtr, _bufLen, _bufUsedPtr) { return __WASI_EBADF; },

    // WASI socket and polling support B3: create a symlink. Spec:
    //   path_symlink(old_path, fd, new_path)
    // old_path is the symlink's TARGET (stored verbatim); fd+new_path
    // is the location where the symlink itself is created.
    path_symlink(_oldPathPtr, _oldPathLen, _newFd, _newPathPtr, _newPathLen) { return __WASI_EBADF; },

    // WASI socket and polling support B3: hardlink. Spec:
    //   path_link(old_fd, old_flags, old_path, new_fd, new_path)
    // Implements as a shared-buffer alias. POSIX semantics: both names
    // point at the same inode, so writes through either are visible to
    // the other. In our in-memory FS the "same inode" is the same
    // Uint8Array reference. CAVEAT: our setFile/fd_write paths REPLACE
    // the buffer reference (immutable-style update) so subsequent writes
    // don't propagate. Matches link(2) at the WASI-layer (link itself
    // succeeds; concurrent-mutation semantics are filesystem-dependent
    // and our shim is a single-call sandbox).
    path_link(_oldFd, _oldFlags, _oldPathPtr, _oldPathLen, _newFd, _newPathPtr, _newPathLen) { return __WASI_EBADF; },

    // ── fd_filestat_get / fd_filestat_set_size ──
    fd_filestat_get(fd, statPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      // Files and directories are the authority codec's. A descriptor with no
      // path (stdio, a socket) is still its own object and must not share an
      // inode with every other one, so it is named by its fd — on a device of
      // its own, because (dev, ino) is the identity and the authority's
      // devices already use the small numbers (the kernel namespace is 0,
      // SQLite devices count from 1, and their inodes from 1 too).
      let ftype = __WASI_FT_UNKNOWN;
      if (entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
        ftype = __WASI_FT_CHARACTER_DEVICE;
      } else if (entry.kind === 'socket' || entry.kind === 'listener') {
        // Guests fstat a socket fd to learn it is not a regular file (Ruby's
        // IO layer keys buffering and seekability off exactly this).
        ftype = __WASI_FT_SOCKET_STREAM;
      } else return __WASI_EBADF;
      const dv = view();
      dv.setUint8(statPtr + 16, ftype);
      writeU64LE(statPtr, __WASI_STREAM_DEV);
      writeU64LE(statPtr + 8, BigInt(fd) + 1n);
      if (preview0) {
        for (let i = 17; i < 20; i++) dv.setUint8(statPtr + i, 0);
        dv.setUint32(statPtr + 20, 1, true);  // nlink u32
        for (let off = 24; off < 56; off += 8) writeU64LE(statPtr + off, 0n);
        return __WASI_ESUCCESS;
      }
      for (let i = 17; i < 24; i++) dv.setUint8(statPtr + i, 0);
      writeU64LE(statPtr + 24, 1n);           // nlink u64
      for (let off = 32; off < 64; off += 8) writeU64LE(statPtr + off, 0n);
      return __WASI_ESUCCESS;
    },
    fd_filestat_set_size(_fd, _size) { return __WASI_EBADF; },
    // WASI socket and polling support B2: real fd_filestat_set_times.
    fd_filestat_set_times(_fd, _atimArg, _mtimArg, _fstflags) { return __WASI_EBADF; },

    // ── fd_pread / fd_pwrite (offset-explicit) ──
    fd_pread(_fd, _iovsPtr, _iovsLen, _offsetArg, _nreadPtr) { return __WASI_EBADF; },

    fd_pwrite(_fd, _iovsPtr, _iovsLen, _offsetArg, _nwrittenPtr) { return __WASI_EBADF; },

    // ── fd_readdir ──
    //
    // WASI dirent layout (24 bytes per entry):
    //   d_next   u64 @ 0    (cookie for next entry)
    //   d_ino    u64 @ 8
    //   d_namlen u32 @ 16
    //   d_type   u8  @ 20
    //   pad             21..23
    // followed by name bytes (variable).
    fd_readdir(_fd, _bufPtr, _bufLen, _cookieArg, _bufusedPtr) { return __WASI_EBADF; },

    fd_advise(_fd, _offset, _len, _advice) { return __WASI_ESUCCESS; },
    // WASI socket and polling support B4: real fd_allocate. Extends the file's byte buffer with
    // zeros so [offset, offset+len) is allocated. POSIX posix_fallocate
    // semantics. ENOSPC is not reachable in our in-memory FS (the
    // 32 MiB snapshot cap is enforced at supervisor level; in-call we
    // just allocate the JS Uint8Array).
    fd_allocate(_fd, _offsetArg, _lenArg) { return __WASI_EBADF; },
    fd_datasync()   { return __WASI_ESUCCESS; },
    fd_sync()       { return __WASI_ESUCCESS; },
    // dup2(2), and the only way to reach it: preview1 has no dup. Renumbering
    // CLOSES `to` — dropping the entry instead leaks whatever it held, and for
    // a socket that is a live stream the kernel is never told about.
    fd_renumber(from, to) {
      const entry = fdTable.get(from);
      if (!entry) return __WASI_EBADF;
      if (from === to) return __WASI_ESUCCESS;
      const target = fdTable.get(to);
      // Preopens are the filesystem's roots. Renumbering over one takes the VFS
      // out from under the guest with nothing left to read, so it is refused
      // rather than obeyed — fd_close declines to close them for the same reason.
      if (target && target.kind === 'preopen') return __WASI_ENOTCAPABLE;
      if (target && target.kind === 'socket' && !target.closed) {
        try { target.socket.close(); } catch {}
        target.closed = true;
      }
      fdTable.delete(from);
      fdTable.set(to, entry);
      return __WASI_ESUCCESS;
    },

    // ── proc_exit ──
    proc_exit(code) { throw new __WasiExit(code | 0); },
    // WASI socket and polling support B5: proc_raise(sig) — POSIX shell convention encodes a
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
      let nowNs: bigint;
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

    // A yield is a no-op for a single-threaded guest and a real scheduling
    // point for a threaded one — the same syscall, answered by whoever owns
    // the runnable set.
    sched_yield()   { return __wasiThreads ? __wasiThreads.yieldNow() : __WASI_ESUCCESS; },

    // ── WASI socket and polling support B8: poll_oneoff FULL ────────────────────────────────
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
      const promises = subs.map((s): Promise<WasiPollEvent> => {
        if (s.badTag) {
          return Promise.resolve({
            idx: s.idx, error: __WASI_EINVAL, type: s.tag, nbytes: 0n, flags: 0,
          });
        }
        if (s.tag === __WASI_EVENTTYPE_CLOCK) {
          // Compute absolute deadline (ns) and convert to ms-delay.
          let deadlineNs: bigint;
          if (((s.flags as number) & __WASI_SUBCLOCKFLAGS_ABSTIME) !== 0) {
            deadlineNs = s.timeout as bigint;
          } else {
            // Relative: deadline = now + timeout.
            const nowNs = (s.id === __WASI_CLOCK_REALTIME)
              ? BigInt(Date.now()) * 1000000n
              : monoNowNs();
            deadlineNs = nowNs + (s.timeout as bigint);
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
        const entry = fdTable.get(s.fd as number);
        if (!entry) {
          return Promise.resolve({
            idx: s.idx, error: __WASI_EBADF, type: s.tag, nbytes: 0n, flags: 0,
          });
        }
        // Regular files, dirs, stdio: always ready (POSIX: regular files
        // never block — read returns immediately even if at EOF). Files and
        // directories are the authority's descriptors; leaving them out made
        // polling one EBADF, which a guest reads as "this fd is gone".
        if (entry.kind === 'preopen' || entry.kind === 'authority' || entry.kind === 'resident' ||
            entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
          let nbytes = 0n;
          if (entry.kind === 'resident' && s.tag === __WASI_EVENTTYPE_FD_READ) {
            const remain = entry.bytes.length - entry.position;
            nbytes = remain > 0 ? BigInt(remain) : 0n;
          } else if (s.tag === __WASI_EVENTTYPE_FD_WRITE) {
            // Writable: report large available capacity. Most user code
            // only checks nbytes > 0.
            nbytes = 0xFFFFFFFFn;
          }
          return Promise.resolve({
            idx: s.idx, error: __WASI_ESUCCESS, type: s.tag, nbytes, flags: 0,
          });
        }
        // Listening socket: readable exactly when a connection is queued.
        if (entry.kind === 'listener') {
          if (s.tag === __WASI_EVENTTYPE_FD_WRITE) {
            return Promise.resolve({ idx: s.idx, error: __WASI_ESUCCESS, type: s.tag, nbytes: 0n, flags: 0 });
          }
          const kernel = globalThis.__nimbusVirtualSockets;
          if (!kernel) {
            return Promise.resolve({ idx: s.idx, error: __WASI_ENOSYS, type: s.tag, nbytes: 0n, flags: 0 });
          }
          const ready = (): WasiPollEvent => ({
            idx: s.idx, error: __WASI_ESUCCESS, type: s.tag,
            nbytes: BigInt(kernel.pending(entry.port)), flags: 0,
          });
          if (kernel.pending(entry.port) > 0) return Promise.resolve(ready());
          return kernel.waitReadable([entry.port], null).then(ready);
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
              const { value, done } = await entry.reader.read() as ReadableStreamReadResult<Uint8Array | ArrayBufferView>;
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
      const ready: WasiPollEvent[] = [];
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
          ready.push(probed as WasiPollEvent);
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

    // WASI socket and polling support B7: sockets via cloudflare:sockets connect() + JSPI.
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
      let combined: Uint8Array;
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
        const msg = ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
        globalThis.__nimbusWasiLastSocketError = msg;
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
          const { value, done } = await entry.reader.read() as ReadableStreamReadResult<Uint8Array | ArrayBufferView>;
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
          const msg = ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
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
        // Empirically observed on prod (sock-shutdown-write probe failing
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
        // back regardless). The probe is the latter case; the limit for
        // the former is documented in the surrounding sock_* commentary.
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

    // The last preview1 syscall, and the one a guest written against libc
    // reaches for: wasi-libc's accept(2) is a direct call to this and nothing
    // else. The path_open route — open '/dev/nimbus/listen/N', read the id,
    // open '/dev/nimbus/socket/<id>' — exists because ruby.wasm resolves
    // descriptors through its own fd table and cannot use one handed to it out
    // of band. That constraint belongs to guests layered over wasi-vfs, not to
    // WASI. Both routes end at __wasiAdoptSocket, so an accepted connection is
    // the same kind of fd whichever way it arrived.
    async sock_accept(fd, flags, fdOutPtr) {
      const entry = fdTable.get(fd);
      if (!entry) return __WASI_EBADF;
      if (entry.kind !== 'listener') return __WASI_ENOTSOCK;
      const kernel = __wasiKernelOrNull('connections cannot be accepted');
      if (!kernel) return __WASI_ENOSYS;
      // Non-blocking is a property of either descriptor: the listener's own
      // flags, or the ones this call asks the accepted socket to carry.
      const nonblock = ((entry.fdflags | flags) & __WASI_FDFLAGS_NONBLOCK) !== 0;
      try {
        let accepted: AcceptedVirtualConnection | null;
        if (nonblock) {
          accepted = kernel.acceptNow(entry.port);
          if (!accepted) return __WASI_EAGAIN;
        } else {
          accepted = await kernel.accept(entry.port);
        }
        const socket = kernel.streamFor(accepted.id);
        writeU32LE(fdOutPtr, __wasiAdoptSocket(socket, flags & __WASI_FDFLAGS_NONBLOCK));
        return __WASI_ESUCCESS;
      } catch (e) {
        // A rejected Suspending import traps in the guest with no diagnosis,
        // so the reason is recorded alongside a plain errno.
        globalThis.__nimbusWasiLastSocketError =
          ((e as Error) && (e as Error).message) ? (e as Error).message : String(e);
        return __WASI_ENOTCONN;
      }
    },
  };

  installAuthorityFilesystem(imports, {
    fs: () => __wasiSup ? supervisorFilesystem(__wasiSup, opts.parking === 'none' ? __wasiSup.synchronous : undefined) : null,
    memory: opts.getMemory,
    fds: fdTable,
    allocateFd: __wasiAllocateFd,
    abi: opts.abi,
    synchronous: opts.parking === 'none',
    residentBytes: __wasiFS.residentFileCap,
    lookups: __wasiLookups,
  });

  // Input that did not come from the filesystem can carry a peer's write, so
  // the next lookup takes the barrier before answering from memory.
  const fromOutside = (name: 'fd_read' | 'sock_recv' | 'sock_accept' | 'poll_oneoff', outside: (fd: number) => boolean) => {
    const body: WasiSyscallFn = imports[name];
    (imports as WasiParkableTable)[name] = function (this: unknown, ...args: never[]) {
      const result = body.apply(this, args);
      if (!outside(args[0])) return result;
      if (result && typeof (result as Promise<Errno>).then === 'function') {
        return (result as Promise<Errno>).finally(() => __wasiLookups.resumed());
      }
      __wasiLookups.resumed();
      return result;
    };
  };
  fromOutside('fd_read', fd => {
    const kind = fdTable.get(fd)?.kind;
    return kind !== 'authority' && kind !== 'resident' && kind !== 'preopen';
  });
  fromOutside('sock_recv', () => true);
  fromOutside('sock_accept', () => true);
  fromOutside('poll_oneoff', () => true);

  // Raw async socket bodies, captured BEFORE JSPI-wrapping so fd_read /
  // fd_write can route socket fds through them (wasi-libc maps read(2)/
  // write(2) to fd_read/fd_write for every fd kind, sockets included).
  const __rawSockRecv = imports.sock_recv;
  const __rawSockSend = imports.sock_send;

  // WASI socket and polling support B7: wrap the async socket imports in WebAssembly.Suspending
  // so the wasm caller can use sync-shape calls that yield to the JS
  // event loop. Requires V8 14.2+ (workerd Oct 2025+) — see
  // If Suspending isn't available (older runtime), socket imports remain
  // async fns that the wasm boundary will reject with a trap — caller
  // sees a clean failure via __wasiRunStartAsync's catch block.
  // Park watchdog — see the constants and withParkDeadline at module scope.
  // Every import that can park.
  const parkable: readonly ParkableImport[] = [
    'sock_send', 'sock_recv', 'sock_shutdown', 'sock_accept', 'poll_oneoff',
    'fd_read', 'fd_write', 'fd_pread', 'fd_pwrite', 'path_filestat_get',
    'path_open', 'fd_close', 'fd_renumber', 'fd_seek', 'fd_tell', 'fd_filestat_get',
    'fd_fdstat_set_flags', 'fd_fdstat_set_rights', 'fd_filestat_set_size',
    'fd_sync', 'fd_datasync', 'fd_allocate', 'fd_advise', 'fd_readdir',
    'path_create_directory', 'path_remove_directory', 'path_unlink_file',
    'path_rename', 'path_symlink', 'path_readlink', 'path_link',
    'fd_filestat_set_times', 'path_filestat_set_times',
  ];
  // Applied before Suspending wraps them.
  for (const name of parkable) {
    if (typeof imports[name] === 'function') (imports as WasiParkableTable)[name] = withParkDeadline(imports[name]);
  }

  // How this instance is allowed to block — a parameter, because it is a
  // property of the CALLER, not of WASI.
  //
  // 'jspi' (default) is the general case: parkable imports are Suspending
  // and every entry into the guest goes through WebAssembly.promising.
  //
  // 'none' is for a guest whose entries are synchronous by contract — a
  // render backend driven per frame from a sync host, a module-init
  // reactor. Such a guest can never be under a suspender, and a Suspending
  // import traps it on the FIRST call even when that call would have
  // returned a plain errno (measured: a hand-assembled import returning 42
  // still threw). So it gets unwrapped imports, and a body that parks
  // anyway must not be handed a Promise where an i32 belongs: that is a
  // configuration error, and it is reported where it happens.
  if (opts.parking === 'none') {
    // Threads are cooperative suspension by construction: a guest that cannot
    // be suspended cannot have them, and pretending otherwise would run every
    // thread to completion inline — a function call wearing a thread's name.
    if (opts.threads) {
      throw new Error(
        'wasi: a threads build cannot run with parking:none; its threads block on a '
        + 'software futex, which requires the guest to be entered under '
        + 'WebAssembly.promising',
      );
    }
    for (const name of parkable) {
      const fn: WasiSyscallFn = imports[name];
      if (typeof fn !== 'function') continue;
      (imports as WasiParkableTable)[name] = function noPark(this: unknown, ...args: never[]) {
        const r = fn.apply(this, args);
        if (r && typeof (r as Promise<Errno>).then === 'function') {
          throw new Error(
            'wasi: ' + name + ' parked in a non-suspending instance; a guest that '
            + 'cannot be entered under WebAssembly.promising must not be given a '
            + 'filesystem or socket that blocks',
          );
        }
        return r;
      };
    }
  } else if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function') {
    imports.sock_send = new WebAssembly.Suspending(imports.sock_send);
    imports.sock_recv = new WebAssembly.Suspending(imports.sock_recv);
    imports.sock_shutdown = new WebAssembly.Suspending(imports.sock_shutdown);
    imports.sock_accept = new WebAssembly.Suspending(imports.sock_accept);
    imports.poll_oneoff = new WebAssembly.Suspending(imports.poll_oneoff);
    imports.fd_read = new WebAssembly.Suspending(imports.fd_read);
    imports.fd_write = new WebAssembly.Suspending(imports.fd_write);
    imports.fd_pread = new WebAssembly.Suspending(imports.fd_pread);
    imports.fd_pwrite = new WebAssembly.Suspending(imports.fd_pwrite);
    imports.path_filestat_get = new WebAssembly.Suspending(imports.path_filestat_get);
    imports.path_open = new WebAssembly.Suspending(imports.path_open);
    imports.fd_close = new WebAssembly.Suspending(imports.fd_close);
    imports.fd_renumber = new WebAssembly.Suspending(imports.fd_renumber);
    imports.fd_seek = new WebAssembly.Suspending(imports.fd_seek);
    imports.fd_tell = new WebAssembly.Suspending(imports.fd_tell);
    imports.fd_filestat_get = new WebAssembly.Suspending(imports.fd_filestat_get);
    imports.fd_fdstat_set_flags = new WebAssembly.Suspending(imports.fd_fdstat_set_flags);
    imports.fd_fdstat_set_rights = new WebAssembly.Suspending(imports.fd_fdstat_set_rights);
    imports.fd_filestat_set_size = new WebAssembly.Suspending(imports.fd_filestat_set_size);
    imports.fd_sync = new WebAssembly.Suspending(imports.fd_sync);
    imports.fd_datasync = new WebAssembly.Suspending(imports.fd_datasync);
    imports.fd_allocate = new WebAssembly.Suspending(imports.fd_allocate);
    imports.fd_advise = new WebAssembly.Suspending(imports.fd_advise);
    imports.fd_readdir = new WebAssembly.Suspending(imports.fd_readdir);
    imports.path_create_directory = new WebAssembly.Suspending(imports.path_create_directory);
    imports.path_remove_directory = new WebAssembly.Suspending(imports.path_remove_directory);
    imports.path_unlink_file = new WebAssembly.Suspending(imports.path_unlink_file);
    imports.path_rename = new WebAssembly.Suspending(imports.path_rename);
    imports.path_symlink = new WebAssembly.Suspending(imports.path_symlink);
    imports.path_readlink = new WebAssembly.Suspending(imports.path_readlink);
    imports.path_link = new WebAssembly.Suspending(imports.path_link);
    imports.fd_filestat_set_times = new WebAssembly.Suspending(imports.fd_filestat_set_times);
    imports.path_filestat_set_times = new WebAssembly.Suspending(imports.path_filestat_set_times);
    if (opts.threads) imports.sched_yield = new WebAssembly.Suspending(imports.sched_yield);
  }

  return {
    wasiImport: imports,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

export function __wasiRunStart(instance: WasiStartInstance, ctx?: unknown): WasiRunResult {
  try {
    const start = instance.exports._start;
    if (typeof start !== 'function') {
      return { exitCode: 1, error: '_start is not a function (got ' + typeof start + ')' };
    }
    start();
    return { exitCode: 0 };
  } catch (e) {
    if (e && (e as object).constructor && (e as object).constructor.name === '__WasiExit') {
      return { exitCode: (e as __WasiExit).code };
    }
    return { exitCode: 1, error: ((e as Error) && (e as Error).message) ? (e as Error).message : String(e) };
  }
}

// WASI socket and polling support (P3/P4 forward-decl): async variant of runStart. Wraps _start
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
export async function __wasiRunStartAsync(instance: WasiStartInstance, ctx?: unknown): Promise<WasiRunResult> {
  try {
    const start = instance.exports._start;
    if (typeof start !== 'function') {
      return { exitCode: 1, error: '_start is not a function (got ' + typeof start + ')' };
    }
    // WebAssembly.promising wraps the export so it returns a Promise<void>
    // that resolves when the (potentially-suspending) wasm computation
    // completes. Available since V8 14.2 (workerd Oct 2025) — see
    //
    // If promising isn't available (older runtimes), fall through to a
    // direct call — fully spec-compatible for non-suspending _start.
    if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.promising === 'function') {
      const promisingStart = WebAssembly.promising(start as () => unknown);
      await promisingStart();
    } else {
      start();
    }
    return { exitCode: 0 };
  } catch (e) {
    if (e && (e as object).constructor && (e as object).constructor.name === '__WasiExit') {
      return { exitCode: (e as __WasiExit).code };
    }
    return { exitCode: 1, error: ((e as Error) && (e as Error).message) ? (e as Error).message : String(e) };
  }
}
// A serialized facet body is evaluated in this module's scope, but runners
// reach helpers through globalThis (the convention __rubyRun and __clangRun
// already follow) because a direct reference to a preamble-only symbol will
// not typecheck in the supervisor bundle the body is authored in.
globalThis.__wasiAdoptSupervisor = __wasiAdoptSupervisor;
// ── END: wasi-instance preamble ─────────────────────────────────────────