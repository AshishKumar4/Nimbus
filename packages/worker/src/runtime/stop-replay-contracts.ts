/** What an abort's reason starts with when it is a stop record, before the run's nonce. */
export const STOP_RECORD_PREFIX = 'NIMBUS_STOP ';

/** How many times one process may stop before its read fails instead. */
export const STOP_LIMIT = 64;

/**
 * The most output per stream a run may have printed and still be replayed:
 * the next run is checked against all of it, so the session keeps it.
 */
export const REPLAY_PREFIX_MAX_BYTES = 1024 * 1024;

/** The most clock readings, stdin reads and random bytes a replayable run may draw. */
export const REPLAY_TAPE_MAX_READINGS = 65_536;
export const REPLAY_TAPE_MAX_RANDOM_BYTES = 1024 * 1024;

/** The most answers the session journals for one run; past it the run cannot be replayed. */
export const REPLAY_JOURNAL_MAX_ENTRIES = 65_536;

/** The most response bytes the session records for one process's runs; past it, unreplayable. */
export const REPLAY_FETCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How long a run after a stop may go without asking for the next thing the
 * run before it was answered, while something it asked for waits behind it,
 * before it is taken to have strayed.
 */
export const REPLAY_STALL_MS = 15_000;

/** The longest stop record the session reads; a longer one is not a stop. */
export const STOP_RECORD_MAX_CHARS = 16 * 1024 * 1024;

/** What a stopped run drew from the outside, to be drawn again in the same order. */
export interface ReplayTape {
  /** Math.random's seed (four uint32 words). */
  seed: number[];
  /** Date's clock readings, run-length encoded: [value, times]. */
  now: [number, number][];
  /** performance.now's readings, run-length encoded. */
  perf: [number, number][];
  /** Bytes crypto.getRandomValues handed out, base64. */
  random: string;
  /** How many bytes each completed synchronous read of stdin returned. */
  reads: number[];
}

/** A chunk of output the session had not acknowledged when the run stopped. */
export interface StoppedOutput {
  s: 'stdout' | 'stderr';
  /** Its offset in what the run printed to that stream. */
  at: number;
  /** base64. */
  b: string;
}

export interface StopRecord {
  v: 3;
  /** `stdin`: a read needs input not there yet. `diverged`: a replay did not retrace the run before it. */
  kind: 'stdin' | 'diverged';
  /** The run that stopped (1 for the first). */
  run: number;
  out: StoppedOutput[];
  /** `stdin`: what the read waits for, the end of stdin or any of it. */
  until?: 'end' | 'data';
  /** `stdin`: how many synchronous reads of stdin completed before the one that stopped. */
  stopAt?: number;
  tape?: ReplayTape;
  /** A run whose output is captured, not streamed: what it had printed. */
  captured?: { stdout: string; stderr: string };
  /** `diverged`: how. */
  why?: string;
}

/** What a run after a stop is handed (the runner's `args.replay`). */
export interface ReplayLaunch {
  run: number;
  tape: ReplayTape;
  /** The synchronous read the run before stopped at: where the replay must have printed all of `prefix`. */
  stopAt: number;
  /** What the session showed of each stream, base64: the replay prints it again first. Null when output is captured. */
  prefix: { stdout: string; stderr: string } | null;
  /** Completed supervisor/network observations the guest must receive again. */
  observations?: Record<string, number>;
}

/** A complete response, or the exact body failure after its headers. */
export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  hasBody: boolean;
  body: Uint8Array;
  chunks?: number[];
  bodyError?: string;
}
export type RecordedBody = { body: Uint8Array; digest: string; chunks: number[]; error?: string } | { error: string } | { tooLarge: true };
