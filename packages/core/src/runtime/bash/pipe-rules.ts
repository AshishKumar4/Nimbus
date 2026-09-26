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

export function decideWrite(
  pipe: PipeCounts, bytes: number, host: PipeHost, capacity: number, budget: number,
): WriteDecision {
  if (pipe.readers === 0) return 'sigpipe';
  if (host === 'jspi') return pipe.queued >= capacity ? 'park' : 'write';
  // Without JSPI nothing parks on a write (a synchronous reader could not wait
  // for the writer it would hand control to); a pipe grows to its budget.
  return pipe.queued > 0 && pipe.queued + bytes > budget ? 'nest' : 'write';
}

export function decideRead(pipe: PipeCounts, host: PipeHost, kind: PipeWriterKind): ReadDecision {
  if (pipe.queued > 0) return 'take';
  if (pipe.writers === 0) return 'eof';
  return host === 'jspi' || kind === 'bash' ? 'park' : 'nest';
}

/**
 * A reader that decided 'nest' stops the command at once when every open
 * write end of its pipe belongs to a frame suspended beneath it: those
 * writers can only go on after it returns, so nothing it could run nested
 * would ever give it input.
 */
export function readerStops(writerPids: Iterable<number>, suspended: ReadonlySet<number>): boolean {
  let any = false;
  for (const pid of writerPids) {
    if (!suspended.has(pid)) return false;
    any = true;
  }
  return any;
}

/**
 * Without JSPI, what one pipe may hold: an eighth of half the memory budget
 * (eight pipes at it, each read into a second copy, use half).
 */
export function pipeBudget(memoryBudgetBytes: number | undefined): number {
  const budget = typeof memoryBudgetBytes === 'number' && memoryBudgetBytes > 0 ? memoryBudgetBytes : DEFAULT_MEMORY_BUDGET;
  return Math.floor(budget / (4 * 8));
}

/** A host that states no memory budget has a Worker isolate's. */
export const DEFAULT_MEMORY_BUDGET = 128 * 1024 * 1024;

/** The one message for a command a host without JSPI cannot carry on. */
export function pipeLimitMessage(budget: number): string {
  const mib = Math.round(budget / (1024 * 1024));
  return `pipe buffer limit ${mib} MiB exceeded: this runtime cannot pause a WASI writer without JSPI`;
}
