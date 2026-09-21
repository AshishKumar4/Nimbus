/**
 * bash/types.ts — the shapes the facet-side bash scheduler operates on.
 *
 * Type-only, in the strict sense: this module must never emit a runtime value.
 * `bash/preamble.ts` is bundled into a source string that is evaluated as a bare
 * function body inside a facet, so an import that survived type erasure would
 * become an unbound identifier there. Keeping this file free of values is what
 * makes the import in preamble.ts safe.
 *
 * The boot/feed/slice shapes live here rather than in bash-runner.ts because
 * they ARE the facet protocol: one side declares them, the other implements
 * them, and before this file the two descriptions of the same payload sat in
 * different files with only a zod schema between them.
 */
import type { Errno, SyscallResult, WasiSupervisorStub } from '../wasi/types.js';
import type { RuntimeFsBridge, VfsCred } from '../os-contracts.js';
import type { AuthorityFd, AuthorityPreopen } from '../wasi/filesystem.js';
/**
 * The errno set this scheduler answers with — the same one every Nimbus syscall
 * layer answers with. This was `Errno | 63`, and the `| 63` was the whole
 * problem: a second vocabulary starting as a magic literal welded onto the
 * shared type at a use site, rather than the shared type being extended at its
 * definition. EPERM now lives in `Errno`, where the next layer that needs it
 * will find it. Kept as an alias so the two names cannot drift apart again.
 */
export type BashErrno = Errno;
/** Boot a bash session in the facet. One per `createBashFacetSession`. */
export interface BashBootArgs {
    op: 'boot';
    argv: string[];
    environ: string[];
    cwd: string;
    cred: Readonly<VfsCred>;
    parking: 'jspi' | 'none';
    stdinData: string;
    stdinClosed: boolean;
    stdinTty: boolean;
    /** Applet names the busybox multicall module answers to (busybox --list). */
    busyboxApplets: string[];
    coreutilsRoot: string;
}
/** Deliver terminal stdin bytes to a parked session and pump again. */
export interface BashFeedArgs {
    op: 'feed';
    data: string;
    eof: boolean;
}
/** One pump slice: what the facet hands back from boot and from every feed. */
export interface BashSlice {
    state: 'need-input' | 'exited' | 'error';
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
    stats?: Record<string, unknown>;
}
/**
 * A file descriptor, discriminated on `kind`. The union is what makes
 * "seeked an fd that was not a file" unrepresentable: reaching `pos` requires
 * having narrowed to a kind that has one.
 */
export type BashFdEntry = {
    kind: 'stdin' | 'stdout' | 'stderr';
} | AuthorityPreopen | AuthorityFd | {
    kind: 'pipe';
    pipeId: number;
    end: 'r' | 'w';
};
/** A byte source that hands out at most what it holds: a pipe or the session stdin. */
export interface BashByteQueue {
    chunks: Uint8Array[];
    queued: number;
}
/** A process parked on a read, waiting for its source to produce bytes or EOF. */
export type BashReadWaiter = {
    proc: BashProc;
} | {
    complete(): void;
};
export interface BashPipe extends BashByteQueue {
    readers: number;
    writers: number;
    /** Processes parked reading this pipe. */
    readW: BashReadWaiter[];
}
export interface BashStdin extends BashByteQueue {
    closed: boolean;
    waiters: BashReadWaiter[];
}
/** Where a parked reader queues, and how to hand it the bytes once they land. */
export interface BashBlockTarget {
    list: BashReadWaiter[];
    wake(): void;
}
/** A scatter/gather buffer list, already stripped of zero-length entries. */
export interface BashIovs {
    list: Array<{
        ptr: number;
        len: number;
    }>;
    total: number;
}
/**
 * One poll_oneoff subscription, decoded.
 *
 * Flat rather than a union on `tag` because the tag arrives as a byte from
 * guest memory: nothing in the type system knows that tag 0 implies `id` and a
 * non-zero tag implies `fd`, and pretending otherwise would only move the
 * assertion around.
 */
export interface BashPollSub {
    /** 0 = CLOCK, 1 = FD_READ, 2 = FD_WRITE. */
    tag: number;
    userdata: bigint;
    /** CLOCK subscriptions: the clock id. */
    id?: number;
    /** CLOCK subscription naming a clock id this facet has no source for. */
    bad?: boolean;
    /** CLOCK subscriptions that are not `bad`: the absolute deadline in ns. */
    deadline?: bigint;
    /** FD_READ / FD_WRITE subscriptions: the descriptor. */
    fd?: number;
}
/** Whether an FD_READ subscription can be answered now, and with how much. */
export interface BashFdReadiness {
    ready: boolean;
    avail: number;
}
/** Why an instance asyncify-unwound; the scheduler dispatches on it. */
export type BashUnwindReason = 'capture' | 'longjmp' | 'fork' | 'waitpid' | 'blockread' | 'exec' | 'filesystem';
/** The read a process parked on, recorded so the scheduler can re-issue it. */
export interface BashPipeReq {
    fd: number;
    iov: BashIovs;
    nreadPtr: number;
    /**
     * Only a poll park carries one. There is no companion `isPoll` flag: asyncify
     * rewind re-enters the SAME import call the guest unwound from, so a park
     * begun in poll_oneoff can only resume in poll_oneoff. A flag recording which
     * one it was would be state that mirrors the call site and is never read —
     * and it was exactly that, in three places, until it was removed.
     */
    pollUserdata?: bigint;
}
/** Bytes waiting to be delivered into a rewinding process's read. */
export interface BashPendingRead {
    iov: BashIovs;
    bytes: Uint8Array;
    nreadPtr: number;
    pollUserdata?: bigint;
}
/**
 * The unwind/rewind register file. Every field past `resume` belongs to exactly
 * one `reason` and is meaningless under the others — an invariant the scheduler
 * relies on and this shape cannot express, which is why the ctx is built with
 * an assertion rather than a literal.
 */
export interface BashProcCtx {
    reason: BashUnwindReason | null;
    rewinding: boolean;
    captureEnv: number;
    ljEnv: number;
    ljVal: number;
    nextSlot: number;
    resume: number;
    /** 'waitpid': the wait status handed back on the rewind. */
    resumeStatus: number;
    /** 'waitpid': the pid argument, <= 0 meaning "any child". */
    waitTarget: number;
    waitStatusPtr: number | null;
    /** 'blockread': the read to re-issue once the source produces. */
    pipeReq: BashPipeReq;
    /** 'exec': the execve arguments. */
    execPath: string;
    execArgv: string[];
    execEnv: string[];
}
/** The wasm exports this scheduler drives. Asyncify supplies the unwind pair. */
export interface BashWasmExports {
    memory: WebAssembly.Memory;
    _start(): void;
    asyncify_start_unwind(buf: number): void;
    asyncify_stop_unwind(): void;
    asyncify_start_rewind(buf: number): void;
    asyncify_stop_rewind(): void;
    [name: string]: WebAssembly.ExportValue;
}
export interface BashInstance {
    readonly exports: BashWasmExports;
}
/** One process in the tree: an instance, its fd table, and its unwind state. */
export interface BashProc {
    pid: number;
    ppid: number;
    fds: Map<number, BashFdEntry>;
    /**
     * Descriptor a preopen was cached under by wasi-libc → where it lives now,
     * for the case where the shell claimed that number with `exec 3>file`.
     */
    preopenMoved: Map<number, number>;
    cwd: string;
    pendingFs?: {
        name: string;
        value?: number;
        settled: boolean;
        promise: Promise<void>;
    };
    inst: BashInstance;
    /** The owning session, so a resumed process can find its run queue. */
    __s: BashSession;
    ctx: BashProcCtx;
    /** Base of the asyncify stack-capture arena. */
    MAIN_BUF: number;
    /** Base of the setjmp slot array, immediately after MAIN_BUF. */
    SLOT0: number;
    pendingRead: BashPendingRead | null;
    /** jmp_buf address → the slot index its most recent setjmp captured into. */
    slotByEnv: Map<number, number>;
    freeSlots: number[];
    DV(): DataView;
    U8(): Uint8Array;
    slotAddr(i: number): number;
    initHdr(a: number, sz: number): void;
}
/** A process parked in waitpid. */
export interface BashWaitEntry {
    proc: BashProc;
    targetPid: number;
}
/** An exited child's status, and whose child it was. */
export interface BashExitStatus {
    status: number;
    ppid: number;
}
export interface BashStats {
    instances: number;
    memPeak: number;
    mainHi: number;
    slotHi: number;
}
/** Everything one bash session owns. Persists across feeds on a warm isolate. */
export interface BashSession {
    mod: WebAssembly.Module;
    /** Command name → the wasm module that answers to it, busybox applets included. */
    coreutils: Map<string, WebAssembly.Module>;
    coreutilsRoot: string;
    fs: RuntimeFsBridge;
    cred: Readonly<VfsCred>;
    parking: 'jspi' | 'none';
    pending: Set<Promise<void>>;
    cwd: string;
    argv: string[];
    environ: string[];
    stdinTty: boolean;
    stdin: BashStdin;
    procs: Map<number, BashProc>;
    pipes: Map<number, BashPipe>;
    runnable: BashProc[];
    /**
     * Reaped-but-unclaimed exit statuses, pid → status and parent.
     *
     * The parent is part of the record because `wait` with no argument must reap
     * one of the CALLER's children. Keyed by status alone, the only thing a
     * waiter could do was take the first entry in the map — which is another
     * process's child whenever two subshells have both had one exit.
     */
    exitStatus: Map<number, BashExitStatus>;
    waiters: BashWaitEntry[];
    pidNext: number;
    pipeNext: number;
    rootPid: number;
    rootExit: number | null;
    steps: number;
    out: string;
    err: string;
    /** preview1 names a guest asked for and this scheduler answered ENOSYS. */
    missingWasi: Set<string>;
    stats: BashStats;
    error: string | null;
}
/**
 * The blocking discipline, abstracted. A bash instance asyncify-parks; an
 * exec'd plain-WASI tool cannot, so it pumps the scheduler synchronously
 * instead. Everything else about the two paths is shared.
 */
export type BashIo = {
    read(fd: number, iov: BashIovs, nread: number): SyscallResult;
    /**
     * Byte count, or null when the descriptor cannot be written to — currently
     * only the read end of a pipe. It used to be "a write here cannot fail",
     * which is how writing to a read end came to succeed silently.
     */
    write(fd: number, bytes: Uint8Array): number | null;
    poll(inPtr: number, outPtr: number, nsubs: number, retPtr: number): SyscallResult;
};
/**
 * The preview1 surface shared by bash instances and exec'd tools.
 *
 * Every name here is a name a guest can import, and the parameter lists follow
 * the preview1 spec — so a syscall whose signature drifts from the ABI is a
 * compile error rather than a wrong answer the guest cannot diagnose. i64
 * arguments arrive as BigInt, though V8 has historically routed some as
 * numbers, so those accept both and the bodies normalise.
 */
export type BashWasiFsImports = {
    fd_prestat_get(fd: number, buf: number): SyscallResult;
    fd_prestat_dir_name(fd: number, path: number, plen: number): SyscallResult;
    path_open(dirfd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number, rightsBase: bigint | number, rightsInheriting: bigint | number, fdflags: number, retPtr: number): SyscallResult;
    fd_filestat_get(fd: number, buf: number): SyscallResult;
    path_filestat_get(dirfd: number, flags: number, pathPtr: number, pathLen: number, buf: number): SyscallResult;
    path_filestat_set_times(dirfd: number, flags: number, pathPtr: number, pathLen: number, atim: bigint | number, mtim: bigint | number, fstflags: number): SyscallResult;
    path_unlink_file(dirfd: number, pathPtr: number, pathLen: number): SyscallResult;
    path_rename(fd1: number, oldPtr: number, oldLen: number, fd2: number, newPtr: number, newLen: number): SyscallResult;
    path_create_directory(dirfd: number, pathPtr: number, pathLen: number): SyscallResult;
    path_readlink(dirfd: number, pathPtr: number, pathLen: number, bufPtr: number, bufLen: number, bufUsedPtr: number): SyscallResult;
    path_symlink(oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number): SyscallResult;
    path_link(fd1: number, lookupFlags: number, oldPtr: number, oldLen: number, fd2: number, newPtr: number, newLen: number): SyscallResult;
    path_remove_directory(dirfd: number, pathPtr: number, pathLen: number): SyscallResult;
    fd_renumber(from: number, to: number): SyscallResult;
    fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint | number, retPtr: number): SyscallResult;
    fd_seek(fd: number, offset: bigint | number, whence: number, retPtr: number): SyscallResult;
    fd_tell(fd: number, retPtr: number): SyscallResult;
    fd_close(fd: number): SyscallResult;
    fd_fdstat_get(fd: number, st: number): SyscallResult;
    fd_fdstat_set_flags(fd: number, flags: number): SyscallResult;
    fd_read(fd: number, iovs: number, n: number, nread: number): SyscallResult;
    fd_write(fd: number, iovs: number, n: number, nw: number): SyscallResult;
    poll_oneoff(inPtr: number, outPtr: number, nsubs: number, retPtr: number): SyscallResult;
    clock_time_get(id: number, precision: bigint | number, t: number): SyscallResult;
    clock_res_get(id: number, r: number): SyscallResult;
    random_get(b: number, l: number): SyscallResult;
    proc_exit(code: number): never;
    fd_sync(fd: number): SyscallResult;
    fd_datasync(fd: number): SyscallResult;
    fd_advise(): SyscallResult;
    sched_yield(): SyscallResult;
    fd_pread(fd: number, iovs: number, n: number, offset: bigint | number, nread: number): SyscallResult;
    fd_pwrite(fd: number, iovs: number, n: number, offset: bigint | number, nw: number): SyscallResult;
    fd_allocate(fd: number, offset: bigint | number, len: bigint | number): SyscallResult;
    fd_filestat_set_size(fd: number, size: bigint | number): SyscallResult;
    fd_filestat_set_times(fd: number, atim: bigint | number, mtim: bigint | number, fstflags: number): SyscallResult;
    fd_fdstat_set_rights(fd: number, rightsBase: bigint | number, rightsInheriting: bigint | number): SyscallResult;
    proc_raise(sig: number): SyscallResult;
    sock_send(fd: number, siDataPtr: number, siDataLen: number, siFlags: number, soDatalenPtr: number): SyscallResult;
    sock_recv(fd: number, riDataPtr: number, riDataLen: number, riFlags: number, roDatalenPtr: number, roFlagsPtr: number): SyscallResult;
    sock_shutdown(fd: number, how: number): SyscallResult;
};
/**
 * The syscalls answered without touching the file layer. Derived from the table
 * rather than restated, so a signature can only be written down once.
 */
export type BashUnsupportedImports = Pick<BashWasiFsImports, 'fd_sync' | 'fd_datasync' | 'fd_advise' | 'sched_yield' | 'fd_pread' | 'fd_pwrite' | 'fd_allocate' | 'fd_filestat_set_size' | 'fd_filestat_set_times' | 'fd_fdstat_set_rights' | 'proc_raise' | 'sock_send' | 'sock_recv' | 'sock_shutdown'>;
/** The full preview1 table a guest is instantiated with: the FS surface plus argv/environ. */
export type BashWasiImports = BashWasiFsImports & {
    args_sizes_get(argcPtr: number, sizePtr: number): BashErrno;
    args_get(argvPtr: number, argvBufPtr: number): BashErrno;
    environ_sizes_get(envcPtr: number, sizePtr: number): BashErrno;
    environ_get(environPtr: number, envBufPtr: number): BashErrno;
};
/**
 * The `nimbus_proc` imports bash is built against — the process primitives
 * preview1 has no answer for. Every one of them either asyncify-unwinds or
 * answers from the scheduler's own tables.
 */
export type BashProcImports = {
    setjmp(env: number): void;
    longjmp(env: number, val: number): void;
    fork(): number;
    vfork(): number;
    waitpid(pid: number, statusPtr: number, opt: number): number;
    execve(pathPtr: number, argvFlatPtr: number, argvLen: number, envFlatPtr: number, envLen: number): number;
    pipe(fdsPtr: number): number;
    dup(o: number): number;
    dup2(o: number, n: number): number;
    kill(): number;
    setpgid(): number;
    getpgid(): number;
    getppid(): number;
    tcsetpgrp(): number;
    tcgetpgrp(): number;
    tcgetattr(): number;
    tcsetattr(): number;
};
/**
 * The facet globals this scheduler reads and installs.
 *
 * `bash-runner.ts` reaches the entry points through `globalThis` because a
 * serialized facet body is authored in the supervisor bundle, where a direct
 * reference to a preamble-only symbol would not typecheck. Declaring them makes
 * that convention checked rather than merely documented.
 */
declare global {
    /** Wasm modules the loader compiled and exposed to the facet, keyed by file name. */
    var __NIMBUS_WASM: Record<string, WebAssembly.Module> | undefined;
    var __bashBoot: (args: BashBootArgs) => Promise<BashSlice>;
    var __bashFeed: (args: BashFeedArgs) => Promise<BashSlice>;
    var __bashStep: (raw: unknown, supervisor?: WasiSupervisorStub) => Promise<BashSlice>;
}
//# sourceMappingURL=types.d.ts.map