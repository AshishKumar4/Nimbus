/**
 * Stop and replay: a synchronous read of stdin that has to wait.
 *
 * Node's `fs.readFileSync(0)` blocks the whole program until its writer ends
 * stdin, and `fs.readSync(0, …)` until some of it arrives. A Nimbus process
 * is JavaScript in a workerd isolate, which has no way to block: workerd turns
 * Atomics.wait off (jsg/setup.c++, SetAllowAtomicsWait(false)), every I/O
 * call returns a promise, and JSPI suspends wasm frames only ("trying to
 * suspend JS frames"). A read that finds its input not there yet cannot wait
 * for it in place.
 *
 * So the run stops there and the program runs again once the input is there.
 * The stop is `ctx.abort(string)`, which terminates the isolate's JavaScript
 * at once (V8 TerminateExecution): no catch, finally, microtask or timer of
 * the program runs after it. Its reason is a primitive string the guest
 * builds with functions it captured before the program ran (no Error object,
 * no JSON or base64 the program could have replaced), and reaches the caller
 * whole: the output the session has not acknowledged, and a tape of the
 * draws the run made inside its isolate (its random seed, clock readings,
 * random bytes, how much each synchronous read of stdin took). The
 * supervisor waits for the input (FacetManager.exec), then launches the same
 * program on the same pid from fresh module state with the stdin the stopped
 * run took, the input after it, and the tape.
 *
 * Everything else the run saw crossed from the session, and is checked there,
 * where the program cannot reach (ReplayJournal): every answer a supervisor
 * call got is journaled as a digest of what it carried, in the order the run
 * was answered, and a run after a stop must ask for the same things and be
 * answered the same, in that order, up to the read the run before stopped at
 * (the boundary). A request still unanswered at the stop is not answered
 * before the boundary. Its network goes through the session too (the
 * supervisor binding is also its outbound, SupervisorRPC.fetch/connect): a
 * response is recorded with its bytes and served again, and a connection is
 * something done outside the process. Output is checked at both ends: the
 * session keeps what it showed (ReplayOutputGate), and the guest drops what
 * it prints again only where it matches. Anything a run after a stop does
 * differently before the boundary ends it loudly (`diverged`), and nothing it
 * did differently reaches anyone.
 *
 * A run can be replayed only while it has done nothing outside itself: a
 * second run would do it again. The session counts every call that could
 * (any supervisor call not known to be a read or the process's own output,
 * any request but a read, any connection), and so does the guest, to fail
 * the read where the program can catch it: ERR_NIMBUS_SYNC_STDIN, naming the
 * first. A program that never reads stdin synchronously, or finds its input
 * there when it does, runs once and is never held: no static guess about the
 * code is made.
 *
 * The guest half is private to the runner module (`const __nimbusStopReplay`,
 * never on globalThis), and a stop record counts only when it carries the
 * run's nonce, which the session mints per run and only that module holds:
 * a program cannot stop itself, or forge a stop by throwing.
 */

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
const STOP_RECORD_MAX_CHARS = 16 * 1024 * 1024;

/**
 * SUPERVISOR calls that change nothing outside the process: reads, its own
 * output, what it learned for its next launch. Every other call counts as one
 * a second run would repeat, including any name added to SupervisorRPC later.
 * `fsOpen` counts only when it opens for writing (STOP_REPLAY_SOURCE). The
 * umask a program sets is the process's own and is put back before a second
 * run (FacetManager.exec).
 */
export const SUPERVISOR_CALLS_WITHOUT_EFFECTS: readonly string[] = [
  'stdout', 'stderr', 'reportExit', 'reportRuntimeCode',
  'readFile', 'readFileBytes', 'stat', 'lstat', 'exists', 'readdir', 'readlink', 'access',
  'hasLegacySymlinkUnder', 'fsAcquire', 'fsAcquired', 'fsRevision', 'fsList', 'fsStorageGrant',
  'fsRead', 'fsReadRange', 'fsReadRangeUncached', 'fsReadBatch', 'fsFstat', 'fsRealpath',
  'fsLinkLeadsTo', 'fsSeek', 'fsDup', 'fsClose', 'fsReaddirHandle', 'fsSync', 'setUmask',
  'cpReadStdin', 'cpReadOutput', 'cpDrainOutput', 'cpWait', 'wsPoll',
  'getPackument', 'getCachedTarball', 'prefetch', 'transform', 'replayBoundary',
  // Object protocol, not calls.
  'then', 'constructor', 'toString', 'valueOf', 'toJSON',
];

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
}

export function decodeBase64(text: string | undefined): Uint8Array {
  if (!text) return new Uint8Array(0);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.byteLength; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isBase64Within = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' && value.length <= Math.ceil(maxBytes / 3) * 4 && value.length % 4 === 0 && BASE64.test(value);
const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const isReadings = (value: unknown): value is [number, number][] =>
  Array.isArray(value) && value.length <= REPLAY_TAPE_MAX_READINGS
  && value.every((entry) => Array.isArray(entry) && entry.length === 2 && Number.isFinite(entry[0]) && isCount(entry[1], Number.MAX_SAFE_INTEGER) && entry[1] >= 1);

function isTape(value: unknown): value is ReplayTape {
  if (typeof value !== 'object' || value === null) return false;
  const tape = value as Record<string, unknown>;
  return Array.isArray(tape.seed) && tape.seed.length === 4 && tape.seed.every((word) => isCount(word, 0xffffffff))
    && isReadings(tape.now) && isReadings(tape.perf)
    && isBase64Within(tape.random, REPLAY_TAPE_MAX_RANDOM_BYTES)
    && Array.isArray(tape.reads) && tape.reads.length <= REPLAY_TAPE_MAX_READINGS && tape.reads.every((n) => isCount(n, Number.MAX_SAFE_INTEGER));
}

function isOutput(value: unknown): value is StoppedOutput[] {
  if (!Array.isArray(value) || value.length > 4096) return false;
  let bytes = 0;
  for (const chunk of value) {
    if (typeof chunk !== 'object' || chunk === null) return false;
    const { s, at, b } = chunk as Record<string, unknown>;
    if ((s !== 'stdout' && s !== 'stderr') || !isCount(at, Number.MAX_SAFE_INTEGER) || !isBase64Within(b, 2 * REPLAY_PREFIX_MAX_BYTES)) return false;
    bytes += (b.length / 4) * 3;
    if (bytes > 2 * REPLAY_PREFIX_MAX_BYTES + 3) return false;
  }
  return true;
}

/**
 * The stop record `error` carries for run `run` of a launch whose nonce is
 * `nonce`, or null when it carries none: any other error, a record of another
 * run or launch, or one that does not hold to the record's shape and bounds.
 * The guest stops with a string (`ctx.abort(reason)`), which reaches the
 * caller as an Error with that message. Nothing in a record is used before
 * all of it is checked.
 */
export function stopRecordOf(error: unknown, nonce: string, run: number): StopRecord | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const marker = `${STOP_RECORD_PREFIX}${nonce} `;
  const at = message.indexOf(marker);
  if (nonce.length < 16 || at < 0 || message.length - at > STOP_RECORD_MAX_CHARS) return null;
  let record: unknown;
  try { record = JSON.parse(message.slice(at + marker.length)); } catch { return null; }
  if (typeof record !== 'object' || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.v !== 3 || r.run !== run || !isOutput(r.out)) return null;
  if (r.captured !== undefined) {
    const captured = r.captured as Record<string, unknown> | null;
    if (typeof captured !== 'object' || captured === null
      || typeof captured.stdout !== 'string' || typeof captured.stderr !== 'string'
      || captured.stdout.length + captured.stderr.length > REPLAY_PREFIX_MAX_BYTES) return null;
  }
  if (r.kind === 'stdin') {
    if ((r.until !== 'end' && r.until !== 'data') || !isCount(r.stopAt, REPLAY_TAPE_MAX_READINGS) || !isTape(r.tape)) return null;
  } else if (r.kind === 'diverged') {
    if (typeof r.why !== 'string' || r.why.length > 1000) return null;
  } else {
    return null;
  }
  return record as StopRecord;
}

const EMPTY = new Uint8Array(0);

function concatBytes(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/**
 * The session's side of a process's output across its runs: each chunk a run
 * prints arrives tagged with the run and its offset, so a chunk the session
 * already has (it also rode a stop) is delivered once, and a stopped run's
 * late chunk is dropped (it rode the stop, or its successor prints it). It
 * keeps what it delivered, up to REPLAY_PREFIX_MAX_BYTES a stream: the prefix
 * the next run is checked against is what the session showed, not what a run
 * says it showed.
 */
export class ReplayOutputGate {
  run = 1;
  private received = { stdout: 0, stderr: 0 };
  private shown: Record<'stdout' | 'stderr', Uint8Array[]> = { stdout: [], stderr: [] };
  /** More than REPLAY_PREFIX_MAX_BYTES was shown on a stream: no run after a stop can be checked. */
  over = false;

  /** A run strayed: nothing more it prints is delivered. */
  close(): void {
    this.run = -1;
  }

  /** The part of a chunk not yet delivered. */
  take(stream: 'stdout' | 'stderr', data: Uint8Array, at: number, run: number): Uint8Array {
    if (run !== this.run) return EMPTY;
    const skip = Math.max(0, this.received[stream] - at);
    if (skip >= data.byteLength) return EMPTY;
    const fresh = skip > 0 ? data.subarray(skip) : data;
    this.received[stream] = Math.max(this.received[stream], at + data.byteLength);
    if (this.received[stream] > REPLAY_PREFIX_MAX_BYTES) {
      this.over = true;
      this.shown = { stdout: [], stderr: [] };
    }
    if (!this.over) this.shown[stream].push(fresh.slice());
    return fresh;
  }

  /**
   * Run `record.run` stopped: what its record carries that is not yet
   * delivered, in order, and the prefix its successor must print first (null
   * when more was shown than a run can be checked against). Its successor's
   * output starts past the prefix.
   */
  stopped(record: StopRecord): { fresh: { stream: 'stdout' | 'stderr'; bytes: Uint8Array }[]; prefix: Record<'stdout' | 'stderr', Uint8Array> | null } {
    const fresh: { stream: 'stdout' | 'stderr'; bytes: Uint8Array }[] = [];
    for (const chunk of record.out) {
      const bytes = this.take(chunk.s, decodeBase64(chunk.b), chunk.at, record.run);
      if (bytes.byteLength > 0) fresh.push({ stream: chunk.s, bytes });
    }
    if (this.run !== -1) this.run = record.run + 1;
    if (this.over) return { fresh, prefix: null };
    const prefix = {
      stdout: concatBytes(this.shown.stdout, this.received.stdout),
      stderr: concatBytes(this.shown.stderr, this.received.stderr),
    };
    this.shown = { stdout: [prefix.stdout], stderr: [prefix.stderr] };
    return { fresh, prefix };
  }
}

/**
 * Bytes held as owned pieces of a fixed size, however small the writes that
 * brought them: a writer's one-byte writes cost a piece per 64 KiB, not an
 * array and a packet each.
 */
export class OwnedPieces {
  static readonly SIZE = 64 * 1024;
  private readonly pieces: Uint8Array[] = [];
  private used = OwnedPieces.SIZE;
  bytes = 0;

  add(data: Uint8Array): void {
    let at = 0;
    while (at < data.byteLength) {
      if (this.used === OwnedPieces.SIZE) {
        this.pieces.push(new Uint8Array(OwnedPieces.SIZE));
        this.used = 0;
      }
      const n = Math.min(OwnedPieces.SIZE - this.used, data.byteLength - at);
      this.pieces[this.pieces.length - 1].set(data.subarray(at, at + n), this.used);
      this.used += n;
      at += n;
    }
    this.bytes += data.byteLength;
  }

  /** The pieces, the last cut to what it holds; call once. */
  finish(): Uint8Array[] {
    const last = this.pieces.length - 1;
    if (last >= 0 && this.used < OwnedPieces.SIZE) this.pieces[last] = this.pieces[last].slice(0, this.used);
    return this.pieces;
  }
}

/**
 * What a run took from its stdin channel, as the session handed it over
 * (cpReadStdin): what goes back in front of the channel for the next run,
 * whatever the run says it took. Only the current run of the process may read
 * its channel: a stopped run's read still in flight takes nothing, so it
 * cannot swallow the input its successor waits for.
 */
export class StdinTaken {
  private writerId: string | null = null;
  private pieces = new OwnedPieces();
  private over = false;

  constructor(private readonly hold: { take(max: number): number; give(n?: number): void }, private readonly limit: number) {}

  /** A run with this writer identity starts: it alone reads the channel. */
  start(writerId: string): void {
    this.writerId = writerId;
  }

  /** The run stopped: no run reads the channel until the next starts. */
  retire(): void {
    this.writerId = '';
  }

  /** Whether a read by this writer identity may take from the channel. */
  admits(writerId: string | undefined): boolean {
    return writerId === undefined || this.writerId === null || writerId === this.writerId;
  }

  /** The current run was handed these bytes. */
  note(data: Uint8Array): void {
    if (this.over || data.byteLength === 0) return;
    const granted = this.pieces.bytes + data.byteLength > this.limit ? 0 : this.hold.take(data.byteLength);
    if (granted < data.byteLength) {
      this.hold.give(granted + this.pieces.bytes);
      this.over = true;
      this.pieces = new OwnedPieces();
      return;
    }
    this.pieces.add(data);
  }

  /**
   * What the stopped run took, in order, and its size, still held against the
   * budget (the caller gives it back once it hands it on); null when it took
   * more than the limit. The next run's account starts empty.
   */
  take(): { chunks: Uint8Array[]; bytes: number } | null {
    if (this.over) return null;
    const bytes = this.pieces.bytes;
    const chunks = this.pieces.finish();
    this.pieces = new OwnedPieces();
    return { chunks, bytes };
  }

  /** Give back what is held: the process ended. */
  release(): void {
    this.hold.give(this.pieces.bytes);
    this.pieces = new OwnedPieces();
  }
}

/**
 * Supervisor calls whose answers carry what the program sees of a path: the
 * session journals them for a process that can stop. Not journaled: the
 * coherence calls (fsAcquire and its kin) and the namespace listing (fsList),
 * which describe the whole filesystem, so that any change anywhere would end
 * every replay; and descriptor bookkeeping. They say where to look and when;
 * what is there is read by one of these.
 */
export const JOURNALED_CALLS: ReadonlySet<string> = new Set([
  'readFile', 'readFileBytes', 'stat', 'lstat', 'exists', 'readdir', 'readlink', 'access',
  'hasLegacySymlinkUnder', 'fsOpen', 'fsRead', 'fsReadRange', 'fsReadRangeUncached', 'fsReadBatch',
  'fsFstat', 'fsRealpath', 'fsLinkLeadsTo', 'fsReaddirHandle', 'getPackument', 'getCachedTarball',
]);

const QUIET_CALLS: ReadonlySet<string> = new Set(SUPERVISOR_CALLS_WITHOUT_EFFECTS);

/** What an op does outside the process, or null when it does nothing a second run would repeat. */
export function supervisorCallEffect(op: string, args: readonly unknown[] | undefined): string | null {
  const path = args?.find((a): a is string => typeof a === 'string');
  if (op === 'fsOpen') {
    const flags = args?.[1] as Record<string, unknown> | null | undefined;
    const writes = !!(flags && (flags.write || flags.append || flags.create || flags.truncate));
    return writes ? `fsOpen ${path ?? ''} for writing`.trim() : null;
  }
  if (QUIET_CALLS.has(op)) return null;
  return path ? `${op} ${path}` : op;
}

/**
 * Keys whose values change with nothing the program reads: coherence tokens,
 * the namespace's whole-filesystem revision and epoch (a listing's own
 * entries carry their paths' revisions), and access times (a read is not a
 * change). Left out of an answer's digest.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set(['acquired', 'atime', 'atimeMs', 'atimeNs', 'lease', 'rev', 'epoch']);

/**
 * A digest of what a value carries, the same for the same contents however it
 * was built: bytes as bytes, strings by UTF-16 unit, objects by sorted key.
 * Two independent FNV-1a lanes, 64 bits: it is to notice a file that changed
 * while a process waited, not to resist a chosen collision.
 */
export function answerDigest(value: unknown): string {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  const mix = (code: number): void => {
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b ^ (code + 0x9e), 2246822519) >>> 0;
  };
  const text = (s: string): void => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(0xffff); };
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 64) { text('…'); return; }
    if (v === null) { mix(1); return; }
    if (v === undefined) { mix(2); return; }
    switch (typeof v) {
      case 'string': mix(3); text(v); return;
      case 'number': mix(4); text(Object.is(v, -0) ? '-0' : String(v)); return;
      case 'boolean': mix(v ? 5 : 6); return;
      case 'bigint': mix(7); text(String(v)); return;
      case 'object': break;
      default: mix(8); return;
    }
    if (v instanceof Uint8Array || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v)
        : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
      mix(9);
      for (let i = 0; i < bytes.byteLength; i++) mix(bytes[i]);
      mix(0x1ff);
      return;
    }
    if (seen.has(v)) { mix(10); return; }
    seen.add(v);
    if (Array.isArray(v)) {
      mix(11);
      for (const item of v) walk(item, depth + 1);
      mix(12);
    } else if (v instanceof Error) {
      mix(13);
      text(String((v as { code?: unknown }).code ?? v.name));
      text(v.message);
    } else {
      mix(14);
      for (const key of Object.keys(v as object).sort()) {
        if (VOLATILE_KEYS.has(key)) continue;
        text(key);
        walk((v as Record<string, unknown>)[key], depth + 1);
      }
      mix(15);
    }
    seen.delete(v);
  };
  walk(value, 0);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** A recorded response: served to a run after a stop instead of fetching again. */
export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
}

interface JournalEntry {
  key: string;
  occurrence: number;
  /** What it was answered: a digest, or 'error:…'. Unset while unanswered. */
  digest?: string;
  /** The order it was answered in, among this run's answers. */
  completion?: number;
  response?: RecordedResponse;
}

export interface Expected {
  digest: string | undefined;
  /** Null: not answered when the run before stopped. */
  completion: number | null;
  response?: RecordedResponse;
}

/** What makes a run after a stop stray: ReplayJournal hands it to the process's owner. */
export type DivergeHandler = (why: string) => void;

/**
 * The session's journal of one process that can stop, across its runs: what
 * each run was answered, and for a run after a stop, what it must be answered
 * again and in which order, up to the boundary (see the header). One per
 * process, created when it launches and closed when it ends.
 */
export class ReplayJournal {
  /** The run being answered (its writer identity); another run's calls take nothing. */
  private run: string | null = null;
  /** This run's answers, or null once it cannot be replayed (nothing more is recorded). */
  private entries: JournalEntry[] | null = [];
  private occurrences = new Map<string, number>();
  private completions = 0;
  /** Why the current run cannot be replayed: the first thing it did outside itself, or a bound. */
  unreplayable: string | null = null;
  diverged: string | null = null;
  private expected: Map<string, Expected[]> | null = null;
  private expectedCompleted = 0;
  /** How many of those the run after the stop has asked for again. */
  private expectedAsked = 0;
  private boundaryPassed = true;
  private delivered = 0;
  private waiting = new Map<number, { release: () => void; fail: (e: Error) => void }>();
  private atBoundary: { release: () => void; fail: (e: Error) => void }[] = [];
  private stall: ReturnType<typeof setTimeout> | null = null;
  private recordedBytes = 0;
  /** Paths the process's stdin is (a `< file`), as storage keys: reading them is reading input. */
  private readonly inputPaths = new Set<string>();

  constructor(private readonly onDiverge: DivergeHandler, private readonly stallMs: number = REPLAY_STALL_MS) {}

  /** A run begins: the writer identity its calls carry. */
  start(run: string): void {
    this.run = run;
  }

  /**
   * The process's stdin is the file at `path` (`< file`). Reading it is
   * reading input, as a pipe's packets are, not the world the run saw: a run
   * after a stop reads ahead what the run before stopped short of. A call
   * that names only that file is answered without being journaled.
   */
  input(path: string): void {
    this.inputPaths.add(storageKey(path));
  }

  /** Whether a call made by `run` belongs to the run being answered. */
  admits(run: string | undefined): boolean {
    return run === undefined || (this.run !== null && run === this.run);
  }

  /** Whether the run being answered may still be stopped and replayed. */
  get replayable(): boolean {
    return this.unreplayable === null && this.diverged === null;
  }

  /**
   * Whether what the run is answered is still journaled: it may yet stop, or
   * it is a run after a stop still short of its boundary.
   */
  get recording(): boolean {
    return this.entries !== null || !this.boundaryPassed;
  }

  /**
   * The current run stopped: what it was answered becomes what the next run
   * must be answered again, and what it was still waiting for is answered to
   * the next only past the boundary. Nothing it asked for is answered now.
   */
  stopped(): void {
    const expected = new Map<string, Expected[]>();
    let completed = 0;
    for (const entry of this.entries ?? []) {
      const list = expected.get(entry.key) ?? [];
      list[entry.occurrence] = {
        digest: entry.digest,
        completion: entry.completion ?? null,
        ...(entry.response ? { response: entry.response } : {}),
      };
      expected.set(entry.key, list);
      if (entry.completion !== undefined) completed++;
    }
    this.failHeld(new Error('this run of the process has stopped'));
    this.run = null;
    this.expected = expected;
    this.expectedCompleted = completed;
    this.expectedAsked = 0;
    this.boundaryPassed = false;
    this.delivered = 0;
    this.entries = [];
    this.occurrences = new Map();
    this.completions = 0;
    this.unreplayable = null;
  }

  /** The process ended: nothing more is answered or held. */
  close(): void {
    this.failHeld(new Error('the process has ended'));
    this.run = null;
    this.entries = null;
    this.expected = null;
  }

  /** The current run did something outside itself (or `what` makes it unreplayable): see the class. */
  effect(what: string): Error | null {
    if (!this.boundaryPassed) {
      return this.diverge(`it did something outside itself before the read, which the run before it did not (${what})`);
    }
    this.disqualify(what);
    return null;
  }

  /** The current run cannot be replayed (D1: nothing more is recorded for it). */
  disqualify(why: string): void {
    if (this.unreplayable === null) this.unreplayable = why;
    this.entries = null;
  }

  /** A supervisor call from the process: answered through `dispatch`, journaled, ordered. */
  handle(op: string, args: readonly unknown[] | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown> {
    if (!this.admits(run)) return Promise.reject(new Error('this run of the process has stopped'));
    if (this.diverged !== null) return Promise.reject(new Error(this.diverged));
    const effect = supervisorCallEffect(op, args);
    if (effect !== null) {
      const refused = this.effect(effect);
      return refused ? Promise.reject(refused) : dispatch();
    }
    if (!JOURNALED_CALLS.has(op)) return dispatch();
    if (this.boundaryPassed && this.entries === null) return dispatch();
    if (this.inputPaths.size > 0 && namesOnly(args, this.inputPaths)) return dispatch();
    const key = callKey(op, args);
    return this.answer(key, describeCall(op, args), dispatch, undefined);
  }

  /**
   * One journaled answer: `produce` yields it (and a recording to keep, for a
   * response); a run after a stop is answered as the run before it was, or it
   * strays. Resolves when the program may have it.
   */
  async answer<T>(key: string, what: string, produce: (expected?: Expected) => Promise<T>, record?: (value: T) => RecordedResponse | undefined): Promise<T> {
    // The run asking: if it stops before its answer comes, the answer is not its.
    const asking = this.run;
    const entries = this.entries;
    const occurrence = this.occurrences.get(key) ?? 0;
    this.occurrences.set(key, occurrence + 1);
    let entry: JournalEntry | null = null;
    if (this.entries !== null) {
      if (this.entries.length >= REPLAY_JOURNAL_MAX_ENTRIES) {
        this.disqualify(`asked for more than ${REPLAY_JOURNAL_MAX_ENTRIES} things first, more than a second run is checked against`);
      } else {
        entry = { key, occurrence };
        this.entries.push(entry);
      }
    }
    let expected: Expected | undefined;
    if (!this.boundaryPassed) {
      expected = this.expected?.get(key)?.[occurrence];
      if (expected === undefined) throw this.diverge(`it asked for ${what}, which the run before it did not ask for there`);
      if (expected.completion !== null) this.expectedAsked++;
    }
    let value: T | undefined;
    let failure: unknown;
    let digest: string;
    try {
      value = await produce(expected);
      digest = answerDigest(value);
    } catch (error) {
      failure = error;
      digest = 'error:' + answerDigest(error instanceof Error ? error : String(error));
    }
    if (this.run !== asking) throw new Error('this run of the process has stopped');
    if (expected !== undefined && expected.digest !== undefined && expected.digest !== digest) {
      throw this.diverge(`${what} was answered differently from the run before it (it changed while the process waited)`);
    }
    if (expected !== undefined) await this.hold(expected.completion);
    if (this.run !== asking) throw new Error('this run of the process has stopped');
    // The next answer in the run before's order goes once this one has.
    if (expected !== undefined && expected.completion !== null) setTimeout(() => this.advance(), 0);
    if (entry !== null && this.entries !== null && this.entries === entries) {
      entry.digest = digest;
      entry.completion = this.completions++;
      if (record && failure === undefined) {
        const response = record(value as T);
        if (response) {
          this.recordedBytes += response.body.byteLength;
          if (this.recordedBytes > REPLAY_FETCH_MAX_BYTES) {
            this.disqualify(`received more than ${REPLAY_FETCH_MAX_BYTES / 1048576} MiB over the network first, more than a second run is handed back`);
          } else {
            entry.response = response;
          }
        }
      }
    }
    if (failure !== undefined) throw failure;
    return value as T;
  }

  /**
   * The run after a stop reached the read the run before stopped at. It must
   * have asked again for everything the run before was answered by then; an
   * answer still on its way (the run got to the read sooner) is checked when
   * it comes, and given in the run before's order. The program reaches the
   * read synchronously, so it cannot wait here for it: getting to the read
   * before an answer is an order Node can give too.
   */
  boundary(run: string | undefined): void {
    if (!this.admits(run) || this.boundaryPassed || this.diverged !== null) return;
    if (this.expectedAsked < this.expectedCompleted) {
      this.diverge(`it reached the read without asking for everything the run before it was answered before it (${this.expectedAsked} of ${this.expectedCompleted})`);
      return;
    }
    this.boundaryPassed = true;
    this.expected = null;
    for (const held of this.atBoundary.splice(0)) held.release();
  }

  /** Whether a run after a stop is still retracing the run before it. */
  get replaying(): boolean {
    return !this.boundaryPassed;
  }

  private hold(completion: number | null): Promise<void> {
    if (completion === null) {
      return new Promise((release, fail) => { this.atBoundary.push({ release, fail }); });
    }
    if (completion === this.delivered) return Promise.resolve();
    return new Promise((release, fail) => {
      this.waiting.set(completion, { release, fail });
      this.watch();
    });
  }

  /** The answer in turn was given: the next in the run before's order may go. */
  private advance(): void {
    this.delivered++;
    const next = this.waiting.get(this.delivered);
    if (next) {
      this.waiting.delete(this.delivered);
      next.release();
    }
    this.watch();
  }

  private watch(): void {
    if (this.stall !== null) clearTimeout(this.stall);
    this.stall = null;
    if (this.waiting.size === 0) return;
    this.stall = setTimeout(() => {
      this.stall = null;
      if (this.waiting.size > 0) {
        this.diverge(`it did not ask again for what the run before it was answered next (answer ${this.delivered + 1} of ${this.expectedCompleted})`);
      }
    }, this.stallMs);
  }

  private diverge(why: string): Error {
    const error = new Error('node: this program did not retrace its run before when Nimbus ran it again to wait for stdin: ' + why);
    if (this.diverged === null) {
      this.diverged = why;
      this.failHeld(error);
      this.onDiverge(why);
    }
    return error;
  }

  private failHeld(error: Error): void {
    if (this.stall !== null) clearTimeout(this.stall);
    this.stall = null;
    for (const held of this.waiting.values()) held.fail(error);
    this.waiting.clear();
    for (const held of this.atBoundary.splice(0)) held.fail(error);
  }
}

function storageKey(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * Whether a call names a path, and every path it names is one of `paths`:
 * its string arguments, and the `path` of each entry of an array argument
 * (fsReadBatch).
 */
function namesOnly(args: readonly unknown[] | undefined, paths: ReadonlySet<string>): boolean {
  let named = false;
  for (const arg of args ?? []) {
    const items = Array.isArray(arg) ? arg : [arg];
    for (const item of items) {
      const path = typeof item === 'string' ? item
        : item !== null && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string' ? (item as { path: string }).path
        : null;
      if (path === null) continue;
      if (!paths.has(storageKey(path))) return false;
      named = true;
    }
  }
  return named;
}

/** A call's identity across runs: its op and arguments, digested. */
export function callKey(op: string, args: readonly unknown[] | undefined): string {
  return op + ' ' + answerDigest(args ?? []);
}

/** A call, for a person: its op and the first path it names. */
export function describeCall(op: string, args: readonly unknown[] | undefined): string {
  const path = args?.find((a): a is string => typeof a === 'string');
  return path ? `${op} ${path}` : op;
}

/**
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `const __nimbusStopReplay`, private to the runner module.
 *
 *   ledger(supervisor)   the SUPERVISOR binding, counting calls that do
 *                        something outside the process (default-deny), so the
 *                        read fails where the program can catch it. The
 *                        session counts them too, and is what decides.
 *   begin(launch)        per run: { replay, abort, captured, capturedText,
 *                        nonce, boundary, outbound }.
 *   arm(canStop, whyNot) before the entry: records the run's draws when it can
 *                        stop, replays the stopped run's.
 *   write / acked        each streamed chunk of output on its way out.
 *   readSome / readAll   how many bytes a synchronous read of stdin returns.
 *   block(until, syscall)  a read cannot complete: stops the run, or says why it cannot.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   finish() / booted()  at exit, or when a resident is up: a replay that
 *                        never reached the read it stopped at.
 *
 * What it does with the run's nonce in hand uses only what it captured
 * before the program ran: the stop record is serialized here by hand (no
 * JSON, btoa, Error or prototype method the program could have replaced) and
 * handed to ctx.abort as a primitive string.
 */
export const STOP_REPLAY_SOURCE = `
const __nimbusStopReplay = (() => {
  // Captured before any program runs.
  const ReflectApply = Reflect.apply;
  const StringCharCodeAt = String.prototype.charCodeAt;
  const StringFromCharCode = String.fromCharCode;
  const TypedArrayLength = Reflect.getOwnPropertyDescriptor(Reflect.getPrototypeOf(Uint8Array.prototype), "length").get;
  const NumberIsFinite = Number.isFinite;
  const U8 = Uint8Array;
  const QUIET = ${JSON.stringify(Object.fromEntries(SUPERVISOR_CALLS_WITHOUT_EFFECTS.map((name) => [name, true])))};
  const ObjectHasOwn = Object.hasOwn;
  const PREFIX = ${JSON.stringify(STOP_RECORD_PREFIX)};
  const PREFIX_MAX = ${REPLAY_PREFIX_MAX_BYTES};
  const READINGS_MAX = ${REPLAY_TAPE_MAX_READINGS};
  const RANDOM_MAX = ${REPLAY_TAPE_MAX_RANDOM_BYTES};
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lengthOf = (bytes) => ReflectApply(TypedArrayLength, bytes, []);

  // ── The record's serializer: primitives and our own arrays only. ──
  function str(s) {
    let out = "\\"";
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c = ReflectApply(StringCharCodeAt, s, [i]);
      if (c === 34) out += "\\\\\\"";
      else if (c === 92) out += "\\\\\\\\";
      else if (c < 32 || (c >= 0xd800 && c <= 0xdfff)) {
        const h = "0123456789abcdef";
        out += "\\\\u" + h[(c >> 12) & 15] + h[(c >> 8) & 15] + h[(c >> 4) & 15] + h[c & 15];
      } else out += s[i];
    }
    return out + "\\"";
  }
  function num(n) { return NumberIsFinite(n) ? "" + n : "0"; }
  // base64 over a list of byte chunks, as one stream.
  function b64(chunks) {
    let out = "", carry = 0, have = 0;
    for (let k = 0; k < chunks.length; k++) {
      const bytes = chunks[k];
      const n = lengthOf(bytes);
      for (let i = 0; i < n; i++) {
        carry = (carry << 8) | bytes[i];
        have++;
        if (have === 3) {
          out += B64[(carry >> 18) & 63] + B64[(carry >> 12) & 63] + B64[(carry >> 6) & 63] + B64[carry & 63];
          carry = 0; have = 0;
        }
      }
    }
    if (have === 1) out += B64[(carry >> 2) & 63] + B64[(carry << 4) & 63] + "==";
    else if (have === 2) out += B64[(carry >> 10) & 63] + B64[(carry >> 4) & 63] + B64[(carry << 2) & 63] + "=";
    return out;
  }
  function list(items, each) {
    let out = "[";
    for (let i = 0; i < items.length; i++) out += (i > 0 ? "," : "") + each(items[i]);
    return out + "]";
  }
  function pairs(items) { return list(items, (p) => "[" + num(p[0]) + "," + num(p[1]) + "]"); }
  function pendingOut() {
    if (run.captured) return "[]";
    return list(run.pending, (c) => "{\\"s\\":" + str(c.s) + ",\\"at\\":" + num(c.at) + ",\\"b\\":" + str(b64([c.b])) + "}");
  }
  function capturedOut() {
    if (!run.captured || !run.canStop || run.capturedText === null) return "";
    const text = run.capturedText();
    return ",\\"captured\\":{\\"stdout\\":" + str("" + text.stdout) + ",\\"stderr\\":" + str("" + text.stderr) + "}";
  }
  function capturedLength() {
    if (!run.captured || run.capturedText === null) return 0;
    const text = run.capturedText();
    return ("" + text.stdout).length + ("" + text.stderr).length;
  }
  // The stop: never returns when it stops.
  function stop(body) {
    run.abort(PREFIX + run.nonce + " " + "{\\"v\\":3,\\"run\\":" + num(run.number) + ",\\"out\\":" + pendingOut() + capturedOut() + body + "}");
  }

  let run = null;

  // A replay that does not retrace the run before it is ended before what it
  // does differently reaches anyone.
  function diverge(why) {
    const text = "" + why;
    if (run.abort) stop(",\\"kind\\":\\"diverged\\",\\"why\\":" + str(text.length > 900 ? text.slice(0, 900) : text));
    throw new Error("node: this program did not retrace its run before when Nimbus ran it again to wait for stdin: " + text);
  }
  const replaying = () => run !== null && run.replay !== null && !run.boundaryPassed;
  // D1: once a run cannot be replayed it records nothing more.
  const recording = () => run !== null && run.recordTape && run.why === null;
  function unreplayable(why) {
    if (run && run.armed && run.why === null) run.why = why;
  }
  function effect(what) {
    if (!run || !run.armed) return;
    if (replaying()) diverge("it did something outside itself before the read, which the run before it did not (" + what + ")");
    unreplayable("did something outside itself first (" + what + "), which a second run would do again");
  }
  function ledger(supervisor) {
    if (!supervisor) return supervisor;
    return new Proxy(supervisor, {
      get(target, name) {
        const value = Reflect.get(target, name);
        if (typeof value !== "function" || typeof name !== "string" || ObjectHasOwn(QUIET, name)) return value;
        return (...args) => {
          const flags = name === "fsOpen" ? args[1] : null;
          const writes = name !== "fsOpen" || !!(flags && (flags.write || flags.append || flags.create || flags.truncate));
          const path = args.find((a) => typeof a === "string");
          if (writes) effect(name + (path ? " " + path : ""));
          return target[name](...args);
        };
      },
    });
  }

  // A reading of a clock: the stopped run's, in order, then live ones, kept
  // for the next stop as [value, times] runs.
  function readings(entries) {
    let i = 0, used = 0;
    return (live) => {
      while (i < entries.length && used >= entries[i][1]) { i++; used = 0; }
      if (i < entries.length) { used++; return entries[i][0]; }
      const value = live();
      if (!recording()) return value;
      const last = entries[entries.length - 1];
      if (last && last[0] === value) last[1]++;
      else if (entries.length >= READINGS_MAX) unreplayable("read the clock more than " + READINGS_MAX + " times first, more than a second run is handed back");
      else entries[entries.length] = [value, 1];
      i = entries.length - 1;
      used = entries.length > 0 ? entries[i][1] : 0;
      return value;
    };
  }

  // Math.random from a seed the run is handed: xoshiro128** (Blackman and
  // Vigna), 53 bits per draw, so a replay draws the same numbers with no
  // record of them.
  function seeded(seed) {
    let a = seed[0] | 0, b = seed[1] | 0, c = seed[2] | 0, d = seed[3] | 0;
    const next = () => {
      const t = b << 9;
      let r = Math.imul(b, 5);
      r = Math.imul((r << 7) | (r >>> 25), 9);
      c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
      d = (d << 11) | (d >>> 21);
      return r >>> 0;
    };
    return function random() { return ((next() >>> 6) * 134217728 + (next() >>> 5)) / 9007199254740992; };
  }

  const realRandomValues = globalThis.crypto && globalThis.crypto.getRandomValues
    ? globalThis.crypto.getRandomValues.bind(globalThis.crypto) : null;
  const fromBase64 = (text) => {
    const s = atob(text || "");
    const bytes = new U8(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = ReflectApply(StringCharCodeAt, s, [i]);
    return bytes;
  };

  function installTape(tape, record) {
    const seed = tape ? tape.seed : Array.from(realRandomValues ? realRandomValues(new Uint32Array(4)) : [Date.now() >>> 0, 1, 2, 3]);
    const now = tape ? tape.now.map((e) => e.slice()) : [];
    const perf = tape ? tape.perf.map((e) => e.slice()) : [];
    const given = tape ? fromBase64(tape.random) : new U8(0);
    const drawn = given.byteLength > 0 ? [given] : [];
    let drawnBytes = given.byteLength;
    let givenAt = 0;
    run.tape = { seed, now, perf, drawn, reads: tape ? tape.reads.slice() : [] };
    run.replayedReads = tape ? tape.reads.length : 0;
    run.recordTape = record;

    Math.random = seeded(seed);

    // Date, with the current time taken from the tape: new Date(), Date()
    // and Date.now(). Same prototype and statics, so instanceof and
    // subclasses are unchanged.
    const RealDate = globalThis.Date;
    const nowReading = readings(now);
    const tapedNow = () => nowReading(() => RealDate.now());
    const TapedDate = function Date(...args) {
      if (!new.target) return new RealDate(tapedNow()).toString();
      return Reflect.construct(RealDate, args.length === 0 ? [tapedNow()] : args, new.target);
    };
    Object.setPrototypeOf(TapedDate, RealDate);
    TapedDate.prototype = RealDate.prototype;
    TapedDate.now = tapedNow;
    try { RealDate.prototype.constructor = TapedDate; } catch {}
    globalThis.Date = TapedDate;

    const performance = globalThis.performance;
    if (performance && typeof performance.now === "function") {
      const realPerfNow = performance.now.bind(performance);
      const perfReading = readings(perf);
      try { performance.now = () => perfReading(realPerfNow); } catch {}
    }

    const crypto = globalThis.crypto;
    if (crypto && realRandomValues) {
      const getRandomValues = function getRandomValues(view) {
        const bytes = new U8(view.buffer, view.byteOffset, view.byteLength);
        if (bytes.byteLength <= 65536 && givenAt + bytes.byteLength <= given.byteLength) {
          bytes.set(given.subarray(givenAt, givenAt + bytes.byteLength));
          givenAt += bytes.byteLength;
          return view;
        }
        givenAt = given.byteLength;
        realRandomValues(view);
        if (recording()) {
          if (drawnBytes + bytes.byteLength > RANDOM_MAX) unreplayable("drew more than " + RANDOM_MAX + " random bytes first, more than a second run is handed back");
          else { drawn[drawn.length] = bytes.slice(); drawnBytes += bytes.byteLength; }
        }
        return view;
      };
      const randomUUID = function randomUUID() {
        const b = getRandomValues(new U8(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        let h = "";
        for (let i = 0; i < 16; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
      };
      try { crypto.getRandomValues = getRandomValues; crypto.randomUUID = randomUUID; } catch {}
    }
  }

  // The replay reached the read the run before it stopped at: by now it has
  // printed exactly what that run had, on both streams, and from here on its
  // output and what it does are its own. The session is told, so what it
  // holds for past the boundary is answered.
  function boundary() {
    if (run.prefix) {
      for (const stream of ["stdout", "stderr"]) {
        if (run.sent[stream] !== lengthOf(run.prefix[stream])) {
          diverge("by the read it stopped at, the run before it had printed " + lengthOf(run.prefix[stream])
            + " bytes to " + stream + " and this one " + run.sent[stream]);
        }
      }
    }
    run.boundaryPassed = true;
    if (run.onBoundary) run.onBoundary();
  }

  return {
    ledger,
    unreplayable,
    effect,
    begin(launch) {
      const replay = launch.replay || null;
      const ctxAbort = launch.abort || null;
      run = {
        number: replay ? replay.run : 1,
        abort: ctxAbort,
        nonce: "" + (launch.nonce || ""),
        captured: !!launch.captured,
        capturedText: typeof launch.capturedText === "function" ? launch.capturedText : null,
        onBoundary: typeof launch.boundary === "function" ? launch.boundary : null,
        outbound: !!launch.outbound,
        replay,
        armed: false,
        canStop: false,
        whyNot: null,
        why: null,
        boundaryPassed: replay === null,
        prefix: replay && replay.prefix && !launch.captured
          ? { stdout: fromBase64(replay.prefix.stdout), stderr: fromBase64(replay.prefix.stderr) } : null,
        sent: { stdout: 0, stderr: 0 },
        pending: [],
        tape: null,
        readAt: 0,
        recordTape: false,
        replayedReads: 0,
      };
    },
    // \\\`whyNot\\\`: why the run cannot stop, when it cannot.
    arm(canStop, whyNot) {
      if (!run) return;
      run.armed = true;
      run.canStop = !!canStop;
      run.whyNot = whyNot || "cannot be stopped where it reads";
      if (run.canStop && (!run.abort || run.nonce.length < 16)) run.why = "runs where Nimbus cannot stop it";
      if (run.canStop || run.replay) installTape(run.replay ? run.replay.tape : null, run.canStop);
    },
    get armed() { return !!(run && run.armed); },
    // Whether this run's network goes through the session (which records what
    // it answers); without it any request makes the run unreplayable.
    get outbound() { return !!(run && run.outbound); },
    // A chunk of streamed output: the part to send, with its offset, or null.
    write(stream, bytes) {
      if (!run) return { b: bytes, at: undefined, run: undefined };
      const n = lengthOf(bytes);
      const off = run.sent[stream];
      run.sent[stream] = off + n;
      if (run.canStop && run.sent[stream] > PREFIX_MAX) unreplayable("printed more than " + PREFIX_MAX + " bytes to " + stream + " first, more than a second run is checked against");
      if (replaying() && run.prefix) {
        const prefix = run.prefix[stream];
        const have = lengthOf(prefix);
        if (off + n > have) {
          diverge("before the read it stopped at, it printed more to " + stream + " than the run before it had (" + (off + n) + " of " + have + " bytes)");
        }
        for (let i = 0; i < n; i++) {
          if (bytes[i] !== prefix[off + i]) diverge("it printed something else to " + stream + " (byte " + (off + i) + ")");
        }
        return null;
      }
      if (n === 0) return null;
      const chunk = { s: stream, b: bytes, at: off, run: run.number };
      run.pending[run.pending.length] = chunk;
      return chunk;
    },
    acked(chunk) {
      if (!run) return;
      const pending = run.pending;
      for (let i = 0; i < pending.length; i++) {
        if (pending[i] === chunk) {
          for (let j = i; j < pending.length - 1; j++) pending[j] = pending[j + 1];
          pending.length = pending.length - 1;
          return;
        }
      }
    },
    // A synchronous read of stdin that wants bytes and finds \\\`available\\\`
    // (\\\`ended\\\`: no more will come): how many it returns, or -1 when it has
    // to wait for more.
    readSome(available, ended) {
      if (!run || !run.tape) return available > 0 || ended ? available : -1;
      const idx = run.readAt;
      if (run.replay !== null && !run.boundaryPassed && idx === run.replay.stopAt) boundary();
      if (replaying() && idx < run.replayedReads) {
        const recorded = run.tape.reads[idx];
        if (recorded > available) diverge("its read of stdin found less than the run before it read there");
        run.readAt++;
        return recorded;
      }
      if (available === 0 && !ended) return -1;
      run.readAt++;
      if (recording()) {
        if (run.tape.reads.length >= READINGS_MAX) unreplayable("read stdin more than " + READINGS_MAX + " times first");
        else run.tape.reads[run.tape.reads.length] = available;
      }
      return available;
    },
    // A read of all of stdin (readFileSync) that found \\\`length\\\` bytes at its end.
    readAll(length) {
      if (!run || !run.tape) return;
      const idx = run.readAt;
      if (run.replay !== null && !run.boundaryPassed && idx === run.replay.stopAt) boundary();
      if (replaying() && idx < run.replayedReads && run.tape.reads[idx] !== length) {
        diverge("its read of stdin found " + length + " bytes where the run before it read " + run.tape.reads[idx]);
      }
      run.readAt++;
      if (recording() && run.tape.reads.length < run.readAt) run.tape.reads[run.tape.reads.length] = length;
    },
    // A read that needs input not there yet: the run stops (and never comes
    // back here), or this says why it cannot.
    block(until, syscall) {
      if (!run || !run.armed) return "had not started";
      if (replaying()) diverge("it waited for stdin at a read the run before it did not wait at");
      if (!run.canStop) return run.whyNot;
      if (run.why !== null) return run.why;
      // Captured output rides the stop, so a stop that cannot go on still
      // hands it back: bounded.
      if (capturedLength() > PREFIX_MAX) return "printed more than " + PREFIX_MAX + " bytes first, more than a stop can keep";
      const t = run.tape;
      stop(",\\"kind\\":\\"stdin\\",\\"until\\":" + str("" + until) + ",\\"stopAt\\":" + num(run.readAt)
        + ",\\"tape\\":{\\"seed\\":" + list(t.seed, num) + ",\\"now\\":" + pairs(t.now) + ",\\"perf\\":" + pairs(t.perf)
        + ",\\"random\\":" + str(b64(t.drawn)) + ",\\"reads\\":" + list(t.reads, num) + "}");
      return "could not be stopped";
    },
    finish() {
      if (!run || run.replay === null || run.boundaryPassed) return "";
      return "node: this program ended before the read of stdin it stopped at when Nimbus ran it again, so it did not retrace its run before; what it printed past that is not shown.\\n";
    },
    booted() {
      if (!run || run.replay === null || run.boundaryPassed) return "";
      return "node: this program finished starting before the read of stdin it stopped at when Nimbus booted it again, so it did not retrace its boot before";
    },
  };
})();
`;
