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
export const PIPE_CAPACITY = 65536;
export function decideWrite(pipe, bytes, host, capacity, budget) {
    if (pipe.readers === 0)
        return 'sigpipe';
    if (host === 'jspi')
        return pipe.queued >= capacity ? 'park' : 'write';
    // Without JSPI nothing parks on a write (a synchronous reader could not wait
    // for the writer it would hand control to); a pipe grows to its budget.
    return pipe.queued > 0 && pipe.queued + bytes > budget ? 'nest' : 'write';
}
export function decideRead(pipe, host, kind) {
    if (pipe.queued > 0)
        return 'take';
    if (pipe.writers === 0)
        return 'eof';
    return host === 'jspi' || kind === 'bash' ? 'park' : 'nest';
}
/**
 * A reader that decided 'nest' stops the command at once when every open
 * write end of its pipe belongs to a frame suspended beneath it: those
 * writers can only go on after it returns, so nothing it could run nested
 * would ever give it input.
 */
export function readerStops(writerPids, suspended) {
    let any = false;
    for (const pid of writerPids) {
        if (!suspended.has(pid))
            return false;
        any = true;
    }
    return any;
}
/**
 * The held exit status. On Linux a writer that cannot park here would still
 * be blocked writing when it exits with more than a pipe's capacity unread,
 * so its exit status is held on that pipe (the host without JSPI; a parked
 * writer never exits that way). The status changes nothing a reader sees:
 * every byte is already in the pipe and the write end is closed.
 */
export function holdsExit(pipe, host, capacity) {
    // Only while a reader is left: a hold settles when the last read end closes,
    // so one taken on a readerless pipe would never settle. (The model discards
    // a readerless pipe's bytes, so there the check is implied; the runner
    // keeps them.)
    return host === 'local' && pipe.readers > 0 && pipe.queued > capacity;
}
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
export function heldExitSettles(pipe, capacity) {
    if (pipe.queued <= capacity)
        return 'status';
    return pipe.readers === 0 ? 'sigpipe' : null;
}
/**
 * Without JSPI, what one pipe may hold: an eighth of half the memory budget
 * (eight pipes at it, each read into a second copy, use half).
 */
export function pipeBudget(memoryBudgetBytes) {
    const budget = typeof memoryBudgetBytes === 'number' && memoryBudgetBytes > 0 ? memoryBudgetBytes : DEFAULT_MEMORY_BUDGET;
    return Math.floor(budget / (4 * 8));
}
/** A host that states no memory budget has a Worker isolate's. */
export const DEFAULT_MEMORY_BUDGET = 128 * 1024 * 1024;
/** The one message for a command a host without JSPI cannot carry on. */
export function pipeLimitMessage(budget) {
    const mib = Math.round(budget / (1024 * 1024));
    return `pipe buffer limit ${mib} MiB exceeded: this runtime cannot pause a WASI writer without JSPI`;
}
