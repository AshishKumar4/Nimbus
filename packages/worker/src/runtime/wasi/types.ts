/**
 * wasi/types.ts — the shapes the WASI shim operates on.
 *
 * Type-only, in the strict sense: this module must never emit a runtime value.
 * `wasi/preamble.ts` is bundled into a source string that is evaluated inside a
 * facet with no module system, so an import that survived type erasure would
 * become an unbound identifier there. Keeping this file free of values is what
 * makes the import in preamble.ts safe.
 */
import type { VirtualSocketKernel } from '../virtual-socket-kernel.js';

/**
 * A WASI errno. Modelled as the exact set the shim can return rather than
 * `number`, so a syscall that answers with an unrelated integer — a byte count,
 * a file descriptor, a bare `0` meant as "false" — is a compile error at the
 * `return` rather than a wrong answer the guest cannot diagnose.
 */
export type Errno =
  | 0   // ESUCCESS
  | 2   // EACCES
  | 6   // EAGAIN
  | 8   // EBADF
  | 14  // ECONNREFUSED
  | 20  // EEXIST
  | 23  // EHOSTUNREACH
  | 28  // EINVAL
  | 29  // EIO
  | 31  // EISDIR
  | 32  // ELOOP
  | 44  // ENOENT
  | 52  // ENOSYS
  | 53  // ENOTCONN
  | 54  // ENOTDIR
  | 55  // ENOTEMPTY
  | 57  // ENOTSOCK
  | 64  // EPIPE
  | 70  // ESPIPE
  | 73  // ETIMEDOUT
  | 76; // ENOTCAPABLE

/**
 * What a syscall body may hand back. A cache hit answers synchronously; a body
 * that has to reach the supervisor answers with a Promise the JSPI Suspending
 * wrapper parks the guest on. Both are legal for the SAME syscall — which is
 * precisely why the return type has to say so, rather than each call site
 * guessing.
 */
export type SyscallResult = Errno | Promise<Errno>;

/**
 * Writes a u32 into the guest's linear memory. The socket helpers take it as a
 * parameter because they live at module scope while the memory view belongs to
 * one `__wasiMakeImports` call.
 */
export type WriteU32LE = (off: number, v: number) => void;

/** Nanosecond timestamps tracked per path. */
export interface FileTimes {
  mtime: bigint;
  atime: bigint;
  ctime: bigint;
}

/** One entry of a directory listing, as fd_readdir emits it. */
export interface DirEntry {
  name: string;
  type: number;
}

/**
 * The socket surface the shim uses, and the only thing it needs to know about a
 * peer. A `cloudflare:sockets` connection and a virtual-socket-kernel loopback
 * stream both satisfy it, which is why every socket fd downstream of
 * `__wasiAdoptSocket` is handled by one code path.
 */
export interface WasiSocket {
  readonly opened: Promise<unknown>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

/** Fields every fd carries regardless of kind. */
interface FdEntryCommon {
  /** O_APPEND / O_NONBLOCK mask; readable through fd_fdstat_get. */
  fdflags?: number;
  /** Tracked rights mask. Absent means wide-open. */
  rights?: bigint;
  rightsInheriting?: bigint;
}

export interface StdioFdEntry extends FdEntryCommon {
  kind: 'stdin' | 'stdout' | 'stderr';
}
export interface PreopenFdEntry extends FdEntryCommon {
  kind: 'preopen';
  wasiPath: string;
  vfsPath: string;
  /**
   * fd_readdir treats a preopen exactly as it treats a 'dir' and caches the
   * listing on the entry, so a preopen grows one on first readdir. Optional
   * because __wasiInitFS does not seed it, unlike path_open's 'dir'.
   */
  readdirEntries?: DirEntry[] | null;
}
export interface FileFdEntry extends FdEntryCommon {
  kind: 'file';
  vfsPath: string;
  offset: number;
  oflags: number;
  fdflags: number;
}
export interface DirFdEntry extends FdEntryCommon {
  kind: 'dir';
  vfsPath: string;
  readdirEntries: DirEntry[] | null;
  cookie: bigint;
  oflags: number;
  fdflags: number;
}
export interface SocketFdEntry extends FdEntryCommon {
  kind: 'socket';
  fdflags: number;
  socket: WasiSocket;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  readBuf: Uint8Array;
  readBufOffset: number;
  eof: boolean;
  closed: boolean;
  halfClosedWr: boolean;
}
export interface ListenerFdEntry extends FdEntryCommon {
  kind: 'listener';
  port: number;
  fdflags: number;
}

/**
 * A file descriptor, discriminated on `kind`. The union is what makes
 * "wrote to an fd that was not a file" unrepresentable: reaching `vfsPath`
 * requires having narrowed to a kind that has one.
 */
export type FdEntry =
  | StdioFdEntry
  | PreopenFdEntry
  | FileFdEntry
  | DirFdEntry
  | SocketFdEntry
  | ListenerFdEntry;

/** The in-facet cache of the session VFS. */
export interface WasiFsState {
  root: string;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  times: Map<string, FileTimes>;
  symlinks: Map<string, string>;
  modes: Map<string, number>;
  sizes: Map<string, number>;
  /** Mirror of seeded/demand-loaded content, so the evictor can spot a clean file. */
  origFiles: Map<string, Uint8Array>;
  residentFileCap: number;
  enumeratedRoots: string[];
  revision: number | null;
}

/** Per-path timestamps as they travel in a seed (decimal strings; BigInt is not JSON-safe). */
export interface SeedTimes {
  mtime?: string | number;
  atime?: string | number;
  ctime?: string | number;
}

/** The seed `__wasiInitFS` installs. Mirrors `WasiFsSnapshot` on the wire. */
export interface WasiInitOptions {
  root?: string;
  preopens?: Array<{ wasiPath: string; vfsPath: string }>;
  files?: Record<string, string>;
  dirs?: string[];
  modes: Record<string, number>;
  sizes?: Record<string, number>;
  times?: Record<string, SeedTimes>;
  symlinks?: Record<string, string>;
  residentFileCap?: number;
  enumeratedRoots?: string[];
  revision?: number | null;
}

/** What a live stat answers with. */
export interface WasiStatResult {
  type: string;
  size?: number;
  mtime?: number;
}

/**
 * The supervisor RPC surface the shim uses to make its cache a cache. Absent
 * (a sealed instance) every path degrades to closed-world in-memory behaviour.
 */
export interface WasiSupervisorStub {
  fsReadRange(vfsPath: string, offset: number, length: number): Promise<Uint8Array | ArrayBuffer>;
  fsRevision?(root: string): Promise<number | null>;
  stat(vfsPath: string): Promise<WasiStatResult | null>;
  writeFile(vfsPath: string, bytes: Uint8Array): Promise<unknown>;
  unlink(vfsPath: string): Promise<unknown>;
  mkdir(vfsPath: string): Promise<unknown>;
  rmdir(vfsPath: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  symlink(target: string, vfsPath: string): Promise<unknown>;
  utimes(vfsPath: string, atimeMs: number, mtimeMs: number): Promise<unknown>;
}

/**
 * The two hooks the WASI layer has into the green-thread scheduler.
 * `wasi-threads.ts` owns everything else about it.
 */
export interface WasiThreadScheduler {
  /** Release the scheduler token for the duration of a park. */
  parkIo(parked: Promise<Errno>): Promise<Errno>;
  /** A real scheduling point; answers sched_yield. */
  yieldNow(): Errno | Promise<Errno>;
}

/** How an instance is permitted to block — a property of the caller, not of WASI. */
export type WasiParking = 'jspi' | 'none';

export interface WasiMakeImportsOptions {
  argv?: string[];
  env?: Record<string, string>;
  getMemory(): WebAssembly.Memory;
  abi?: 'preview1' | 'preview0';
  parking?: WasiParking;
  threads?: boolean;
  stdoutWrite?: (s: string) => void;
  stderrWrite?: (s: string) => void;
}

/**
 * The WASI import table, exhaustively.
 *
 * Every name here is a name the guest can import, and every name the guest can
 * import is here. The table `__wasiMakeImports` builds is annotated with this
 * type, so a missing syscall fails to compile and a syscall whose parameter list
 * does not match the ABI fails to compile — which is what makes the
 * blanket-`Proxy`-returning-fake-ESUCCESS class of defect unrepresentable rather
 * than merely absent today.
 *
 * Parameter names follow the preview1 spec. Pointers are u32 offsets into the
 * guest's linear memory; `filesize`/`timestamp`/`rights` are i64 and arrive as
 * BigInt, though V8 has historically routed some as numbers, so those accept
 * both and the bodies normalise.
 */
export interface WasiImports {
  // args / env
  args_get(argvPtr: number, argvBufPtr: number): SyscallResult;
  args_sizes_get(argcPtr: number, sizePtr: number): SyscallResult;
  environ_get(environPtr: number, envBufPtr: number): SyscallResult;
  environ_sizes_get(envcPtr: number, sizePtr: number): SyscallResult;

  // fd basics
  fd_close(fd: number): SyscallResult;
  fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): SyscallResult;
  fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): SyscallResult;
  fd_seek(fd: number, offset: bigint | number, whence: number, newOffsetPtr: number): SyscallResult;
  fd_tell(fd: number, offsetPtr: number): SyscallResult;
  fd_fdstat_get(fd: number, statPtr: number): SyscallResult;
  fd_fdstat_set_flags(fd: number, flags: number): SyscallResult;
  fd_fdstat_set_rights(fd: number, rightsBase: bigint | number, rightsInheriting: bigint | number): SyscallResult;

  // preopens
  fd_prestat_get(fd: number, prestatPtr: number): SyscallResult;
  fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): SyscallResult;

  // paths
  path_open(
    baseFd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number,
    rightsBase: bigint | number, rightsInheriting: bigint | number, fdflags: number, fdOutPtr: number,
  ): SyscallResult;
  path_create_directory(baseFd: number, pathPtr: number, pathLen: number): SyscallResult;
  path_remove_directory(baseFd: number, pathPtr: number, pathLen: number): SyscallResult;
  path_unlink_file(baseFd: number, pathPtr: number, pathLen: number): SyscallResult;
  path_rename(
    srcFd: number, srcPathPtr: number, srcPathLen: number,
    dstFd: number, dstPathPtr: number, dstPathLen: number,
  ): SyscallResult;
  path_filestat_get(
    baseFd: number, lookupflags: number, pathPtr: number, pathLen: number, statPtr: number,
  ): SyscallResult;
  path_filestat_set_times(
    baseFd: number, lookupflags: number, pathPtr: number, pathLen: number,
    atim: bigint | number, mtim: bigint | number, fstflags: number,
  ): SyscallResult;
  path_readlink(
    baseFd: number, pathPtr: number, pathLen: number,
    bufPtr: number, bufLen: number, bufUsedPtr: number,
  ): SyscallResult;
  path_symlink(
    oldPathPtr: number, oldPathLen: number, newFd: number, newPathPtr: number, newPathLen: number,
  ): SyscallResult;
  path_link(
    oldFd: number, oldFlags: number, oldPathPtr: number, oldPathLen: number,
    newFd: number, newPathPtr: number, newPathLen: number,
  ): SyscallResult;

  // filestat on descriptors
  fd_filestat_get(fd: number, statPtr: number): SyscallResult;
  fd_filestat_set_size(fd: number, size: bigint | number): SyscallResult;
  fd_filestat_set_times(
    fd: number, atim: bigint | number, mtim: bigint | number, fstflags: number,
  ): SyscallResult;

  // positional io
  fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint | number, nreadPtr: number): SyscallResult;
  fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, offset: bigint | number, nwrittenPtr: number): SyscallResult;

  // directories
  fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: bigint | number, bufusedPtr: number): SyscallResult;

  // descriptor housekeeping
  fd_advise(): SyscallResult;
  fd_allocate(fd: number, offset: bigint | number, len: bigint | number): SyscallResult;
  fd_datasync(): SyscallResult;
  fd_sync(): SyscallResult;
  fd_renumber(from: number, to: number): SyscallResult;

  // process
  proc_exit(code: number): never;
  proc_raise(sig: number): never;

  // clocks and entropy
  clock_time_get(clockId: number, precision: bigint | number, timePtr: number): SyscallResult;
  clock_res_get(clockId: number, resPtr: number): SyscallResult;
  random_get(bufPtr: number, bufLen: number): SyscallResult;
  sched_yield(): SyscallResult;

  // sockets and polling
  sock_send(fd: number, siDataPtr: number, siDataLen: number, siFlags: number, soDatalenPtr: number): Promise<Errno>;
  sock_recv(
    fd: number, riDataPtr: number, riDataLen: number, riFlags: number,
    roDatalenPtr: number, roFlagsPtr: number,
  ): Promise<Errno>;
  sock_shutdown(fd: number, how: number): Promise<Errno>;
  poll_oneoff(inSubsPtr: number, outEventsPtr: number, nsubs: number, retNeventsPtr: number): Promise<Errno>;
}

/**
 * Syscalls that can park, and therefore get the deadline guard and the JSPI
 * Suspending wrapper. Typed as keys of the table so a rename or a typo is a
 * compile error instead of a silently unwrapped import.
 */
export type ParkableImport = Extract<
  keyof WasiImports,
  'sock_send' | 'sock_recv' | 'sock_shutdown' | 'poll_oneoff'
  | 'fd_read' | 'fd_write' | 'fd_pread' | 'path_filestat_get'
>;

/**
 * A syscall body as the wrapper layer sees it. The park guard and the
 * non-suspending guard are signature-agnostic by construction — they forward
 * `arguments` untouched — so this is the whole of what they may assume.
 */
export type WasiSyscallFn = (...args: never[]) => SyscallResult;

/**
 * The parkable slots of the table under that one shape. The wrappers replace
 * those slots in place, and this names the view they replace them through.
 */
export type WasiParkableTable = Record<ParkableImport, WasiSyscallFn>;

/**
 * One poll_oneoff readiness result, as the per-subscription promises resolve
 * to it and before it is encoded into the guest's event array.
 */
export interface WasiPollEvent {
  idx: number;
  error: Errno;
  type: number;
  nbytes: bigint;
  flags: number;
}

/** What `__wasiMakeImports` hands back. */
export interface WasiInstanceBundle {
  wasiImport: WasiImports;
  getStdout(): string;
  getStderr(): string;
}

/** The subset of a WebAssembly.Instance the run helpers touch. */
export interface WasiStartInstance {
  exports: Record<string, unknown>;
}

/** Outcome of running a guest's `_start`. */
export interface WasiRunResult {
  exitCode: number;
  error?: string;
}

/**
 * The facet globals this shim reads and installs.
 *
 * Runners reach these helpers through `globalThis` because a serialized facet
 * body is authored in the supervisor bundle, where a direct reference to a
 * preamble-only symbol would not typecheck — the convention `__rubyRun` and
 * `__clangRun` already follow. Declaring them makes that convention checked
 * rather than merely documented: until now every one of these reads sat inside a
 * template literal and no compiler had an opinion about any of them.
 */
/**
 * JSPI, which workerd ships (V8 14.2+) and neither the TypeScript lib nor
 * `@cloudflare/workers-types` describes. Declared once here so the twelve
 * uses in the shim are ordinary typed calls rather than twelve casts.
 *
 * `new Suspending(f)` yields a value that is opaque to JavaScript and legal
 * only as a wasm import, where it presents f's own call signature — the
 * suspension is the boundary's business, not the caller's. Typing the
 * constructor as returning `T` is therefore what the import TABLE sees, and is
 * what lets the wrapped slots stay `WasiImports`. Calling the result from JS
 * would not work, and nothing does: the raw bodies fd_read/fd_write route
 * sockets through are captured before any wrapping.
 */
declare global {
  namespace WebAssembly {
    const Suspending: {
      new <T extends (...args: never[]) => unknown>(fn: T): T;
    };
    function promising<T extends (...args: never[]) => unknown>(
      fn: T,
    ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  }

  var __nimbusWasiLastSocketError: string;
  var __wasiAdoptSupervisor: ((sup: WasiSupervisorStub | null) => void) | undefined;
  var __wasiDrainPersist: (() => Promise<void>) | undefined;
  var __wasiRevalidateFS: (() => Promise<string[]>) | undefined;
  var __nimbusVirtualSockets: VirtualSocketKernel | undefined;
}
