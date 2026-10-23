/**
 * Processes and pipes for a WASI guest: the `nimbus_proc` imports.
 *
 * A guest without fork (git, built with NIMBUS_PROC: packages/worker/wasm/git)
 * starts a child as Windows does, naming the program, its arguments and
 * environment, its directory, and which of its own descriptors become the
 * child's 0, 1 and 2. The child is an ordinary session process, started
 * through the one child-process route every facet program uses (cpSpawn;
 * node's child_process takes the same route): it is in the process table,
 * runs as this process's credential, and can be signalled. Its standard
 * streams are always pipes on the session side; this module connects each to
 * whatever the guest named:
 *
 *   - a pipe the guest made (`pipe`): bytes the guest writes to its end go to
 *     the child's stdin (cpStdinWrite, cpStdinEnd when the last writer
 *     closes), bytes the child writes come into it (cpReadOutput);
 *   - the guest's own stdout or stderr: the child's output joins it;
 *   - nothing (-1, or the guest's stdin, which is empty): the child's stdin
 *     ends at once and its output is dropped.
 *
 * A guest's pipe descriptors read, write, close, poll (poll_oneoff) and take
 * O_NONBLOCK as POSIX's do; git's pipe_command polls a child's stdin and
 * stdout together.
 *
 * Coherence follows the process model (core README, "When a program sees a
 * change"): starting a child and writing to it are observations, so what the
 * guest holds of its writes goes to the session first (`release`); a child's
 * output and its exit are input, so the guest's next filesystem answer takes
 * the barrier (`inbound`).
 *
 * Every import answers 0 or a positive WASI errno; the C side
 * (git-wasi-compat.c) turns that into errno.
 */
import { type Errno, type FdEntry, type SyscallResult, type WasiSupervisorStub, type WasiInputPacket } from './types.js';
import type { Awaitable } from '../os-contracts.js';
/**
 * The longest a guest waits on a child in one call. A wasm stack suspended
 * past about 15 s in a facet never resumes (wasi/preamble.ts, park
 * watchdog), and a child may run for minutes, so a wait for its output or its
 * end gives up at this. A pipe's read or write answers what the instance's
 * image asks again (ProcessHostOptions.gaveUp: NIMBUS_ERESTART, or EINTR to
 * an image that does not restart: git's xread retries it, its stdio does not,
 * and takes it for EOF); a wait for a child answers EINTR, which its callers
 * (wait_or_whine, the spawn shim) retry. Under the watchdog's own 10 s, which
 * still guards poll_oneoff and would answer EAGAIN, which git's poll loop
 * does not retry.
 */
export declare const PROCESS_PARK_MS = 8000;
/**
 * A pipe: bytes in order, and how many descriptors hold each end. A pipe
 * whose read end feeds a child's stdin forwards what is written instead of
 * keeping it.
 */
export interface Pipe {
    chunks: Uint8Array[];
    buffered: number;
    writers: number;
    readers: number;
    waiters: Array<() => void>;
    /** Set when the read end is a child's stdin. */
    forward: ((bytes: Uint8Array) => Promise<{
        ok: boolean;
        signal?: string;
    }>) | null;
    end: (() => Promise<void>) | null;
    ended: boolean;
    /** The session could not deliver all of a child's output: a reader gets EIO after what did arrive. */
    failed: boolean;
}
export interface PipeFdEntry {
    kind: 'pipe';
    end: 'read' | 'write';
    pipe: Pipe;
    fdflags?: number;
    rights?: bigint;
    rightsInheriting?: bigint;
}
/**
 * The guest's half of the session's Dynamic Worker ledger (worker
 * runtime/child-news.ts, which node's child_process speaks too): the news of
 * its children it has applied, and whether its only remaining work is
 * waiting on them. The session refuses a spawn no release could ever make
 * room for (EAGAIN) only when every holder says so.
 */
export interface ChildNews {
    apply(numbers: number[] | undefined): void;
    say(blocked: boolean): void;
}
export interface ProcessHostOptions {
    /** The guest's descriptor table, shared with the rest of its WASI layer. */
    fds: Map<number, FdEntry | PipeFdEntry>;
    allocateFd(): number;
    memory(): WebAssembly.Memory;
    /** The supervisor the guest's facet holds, and the guest's own pid. */
    supervisor(): WasiSupervisorStub | null;
    pid: number;
    /** An injected broker-bounded read of this process's stdin channel. */
    input?: (maxBytes: number) => Awaitable<WasiInputPacket>;
    /** The guest's stdout and stderr, where a child's output that joins them goes. */
    output(fd: 1 | 2, bytes: Uint8Array): void | Promise<void>;
    /** Before an observation: what the guest holds of its writes goes to the session. */
    release(): Promise<void>;
    /** After input: the guest's next filesystem answer takes the barrier. */
    inbound(): void;
    /** The ledger's news protocol, where the session speaks it. */
    news: ChildNews | null;
    /** The credential the guest runs as; null where it has none (a guest with no session). */
    cred(): {
        uid: number;
        gid: number;
    } | null;
    /** Whether the guest can be suspended in an import (JSPI), so that an import may answer by promise. */
    parks: boolean;
    /**
     * What a pipe's read or write, or a stdin read, that gave up at
     * PROCESS_PARK_MS answers: NIMBUS_ERESTART for an image that asks again
     * (types.ts), else EINTR.
     */
    gaveUp: Errno;
    /**
     * The image takes the signals sent to its process (NIMBUS_ESIGNAL): while
     * it waits, the host waits for them too (cpNextSignal), and one that comes
     * ends the wait at once, answered NIMBUS_ESIGNAL + its number, for the
     * guest's libc to raise. Else a wait answers EINTR on a stdin signal only.
     */
    takesSignals: boolean;
    /**
     * Every answer by promise goes through here: a threaded guest's run token
     * is handed back while it waits, so the peer that would end the wait runs.
     * A poll's readiness is not: the poll that awaits it hands the token back.
     */
    park(wait: Promise<Errno>): Promise<Errno>;
}
/** What a poll of a pipe end finds: bytes waiting (or room), whether the other end is gone; null once it gave up. */
export interface PipeReadiness {
    nbytes: number;
    hangup: boolean;
}
export interface ProcessHost {
    imports: Record<string, (...args: number[]) => SyscallResult>;
    /** Read from a pipe descriptor into the guest's iovecs: the errno, or null when `fd` is not a pipe. */
    read(fd: number, iovs: number, iovsLen: number, nread: number): SyscallResult | null;
    /** Write the guest's iovecs to a pipe descriptor: the errno, or null when `fd` is not a pipe. */
    write(fd: number, iovs: number, iovsLen: number, nwritten: number): SyscallResult | null;
    /** Close a pipe descriptor: the errno, or null when `fd` is not a pipe. */
    close(fd: number): SyscallResult | null;
    /** Whether `fd` is a pipe descriptor. */
    isPipe(fd: number): boolean;
    /**
     * What a wait that ended without its answer answers (a poll's, whose pipes
     * did): the signal that interrupted it (NIMBUS_ESIGNAL + its number), taken,
     * else EINTR, the wait having given up.
     */
    interrupted(): Errno;
    /**
     * For an image that takes its signals, a wait that ends only when one
     * comes (interrupted then answers it): a poll races it against its
     * subscriptions, its clocks and sockets among them. Null for any other.
     */
    signalWait(): {
        ready: Promise<void>;
        cancel(): void;
    } | null;
    /** A new descriptor on what pipe or stream descriptor `fd` holds, as dup(2); null for any other kind (AuthorityFilesystemOptions.duplicate). */
    duplicate(fd: number): number | null;
    /**
     * When pipe descriptor `fd` (isPipe) is ready for `want`, for poll_oneoff:
     * at once when it is, else a wait that answers when it becomes so, or null
     * once it gave up at PROCESS_PARK_MS. A poll that returns cancels the waits
     * it no longer needs.
     */
    readiness(fd: number, want: 'read' | 'write'): PipeReadiness | {
        ready: Promise<PipeReadiness | null>;
        cancel(): void;
    };
    /** The guest exited: its children's output and ends are no longer followed. */
    dispose(): void;
    /**
     * The guest returned to its host (an entry into it ended): a check it made
     * while it ran no longer has its signals watched, so an idle guest asks
     * the session nothing; its next check watches them again. Unless it holds
     * one it has not raised, it tells the session it took every signal handed
     * to it (cpSignalsTaken), which then counts none of them as untaken; it
     * settles once the session has heard.
     */
    left(): Promise<void>;
}
export declare function processHost(opts: ProcessHostOptions): ProcessHost;
//# sourceMappingURL=processes.d.ts.map