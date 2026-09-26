/**
 * The wasm bash's pipe rules, as one set of decisions the runner and its
 * refinement test share (FormalModelsLane's Nimbus.Runtime.Pipes; the
 * design, with the traces behind each rule, is pipes-design.md).
 *
 * A pipe here is only its counts: bytes queued, open read ends, open write
 * ends. A process is who is asking: on which host (whether a guest can be
 * parked on a promise) and as what (a bash process, which can always unwind
 * itself, or a WASI child, which on a host without JSPI cannot wait at all).
 * The runner carries each decision out; nothing here moves bytes.
 */
/** Capacity: with JSPI, a writer to a pipe holding this much waits for a reader. */
export declare const PIPE_CAPACITY = 65536;
export type PipeHost = 'jspi' | 'local';
export type PipeWriterKind = 'bash' | 'child';
export interface PipeCounts {
    readonly queued: number;
    readonly readers: number;
    readonly writers: number;
}
/**
 * - `sigpipe`: no read end is open, now or ever; the write kills the writer.
 * - `write`: append the bytes.
 * - `park`: wait (JSPI host) until the pipe drains below capacity or its
 *   readers leave, then decide again.
 * - `nest`: the pipe is past its budget (host without JSPI): run the pipe's
 *   readers nested, then decide again; nothing to run means the command fails.
 */
export type WriteDecision = 'sigpipe' | 'write' | 'park' | 'nest';
/**
 * - `take`: read what is queued.
 * - `eof`: empty, and no write end is open: end of input.
 * - `park`: wait for a writer (a JSPI guest, or a bash process, which unwinds).
 * - `nest`: a WASI child on a host without JSPI cannot wait: run what can
 *   run, nested, then decide again; nothing to run means the command fails
 *   (it never reports a false end of input).
 */
export type ReadDecision = 'take' | 'eof' | 'park' | 'nest';
export declare function decideWrite(pipe: PipeCounts, bytes: number, host: PipeHost, capacity: number, budget: number): WriteDecision;
export declare function decideRead(pipe: PipeCounts, host: PipeHost, kind: PipeWriterKind): ReadDecision;
/**
 * A reader that decided 'nest' stops the command at once when every open
 * write end of its pipe belongs to a frame suspended beneath it: those
 * writers can only go on after it returns, so nothing it could run nested
 * would ever give it input.
 */
export declare function readerStops(writerPids: Iterable<number>, suspended: ReadonlySet<number>): boolean;
/**
 * The held exit status. On Linux a writer that cannot park here would still
 * be blocked writing when it exits with more than a pipe's capacity unread,
 * so its exit status is held on that pipe (the host without JSPI; a parked
 * writer never exits that way). The status changes nothing a reader sees:
 * every byte is already in the pipe and the write end is closed.
 */
export declare function holdsExit(pipe: PipeCounts, host: PipeHost, capacity: number): boolean;
/**
 * When a hold on a pipe settles, checked after each read from it and each
 * close of one of its read ends:
 * - `status`: the pipe is down to its capacity, so on Linux the writer would
 *   have finished writing: it exits with its own status. This happens even
 *   if a reader is still alive (a background job that inherited the read end
 *   must not keep the pipeline waiting).
 * - `sigpipe`: the last read end closed with more than capacity unread: the
 *   writer would have been killed writing (141).
 * - null: still blocked.
 * A reader that is alive never turns a hold into SIGPIPE.
 */
export declare function heldExitSettles(pipe: PipeCounts, capacity: number): 'status' | 'sigpipe' | null;
/**
 * Without JSPI, what one pipe may hold: an eighth of half the memory budget
 * (eight pipes at it, each read into a second copy, use half).
 */
export declare function pipeBudget(memoryBudgetBytes: number | undefined): number;
/** A host that states no memory budget has a Worker isolate's. */
export declare const DEFAULT_MEMORY_BUDGET: number;
/** The one message for a command a host without JSPI cannot carry on. */
export declare function pipeLimitMessage(budget: number): string;
//# sourceMappingURL=pipe-rules.d.ts.map