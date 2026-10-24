import { base64Decode } from '@nimbus-sh/core/_shared/crypto.js';
import { REPLAY_PREFIX_MAX_BYTES, REPLAY_TAPE_MAX_READINGS, REPLAY_TAPE_MAX_RANDOM_BYTES, STOP_RECORD_MAX_CHARS, STOP_RECORD_PREFIX, type ReplayTape, type StopRecord, type StoppedOutput } from './stop-replay-contracts.js';

/** A tape's bytes from their base64: none for an absent or empty entry. */
export function decodeBase64(text: string | undefined): Uint8Array {
  return text ? base64Decode(text) : new Uint8Array(0);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isBase64Within = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' && value.length <= Math.ceil(maxBytes / 3) * 4 && value.length % 4 === 0 && BASE64.test(value);
const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const isReadings = (value: unknown): value is [number, number][] =>
  Array.isArray(value) && value.length <= REPLAY_TAPE_MAX_READINGS
  && value.every((entry) => Array.isArray(entry) && entry.length === 2 && Number.isFinite(entry[0]) && isCount(entry[1], Number.MAX_SAFE_INTEGER) && entry[1] >= 1);

function isTape(tape: unknown): tape is ReplayTape {
  if (!isObject(tape)) return false;
  return Array.isArray(tape.seed) && tape.seed.length === 4 && tape.seed.every((word) => isCount(word, 0xffffffff))
    && isReadings(tape.now) && isReadings(tape.perf)
    && isBase64Within(tape.random, REPLAY_TAPE_MAX_RANDOM_BYTES)
    && Array.isArray(tape.reads) && tape.reads.length <= REPLAY_TAPE_MAX_READINGS && tape.reads.every((n) => isCount(n, Number.MAX_SAFE_INTEGER));
}

function isOutput(value: unknown): value is StoppedOutput[] {
  if (!Array.isArray(value) || value.length > 4096) return false;
  let bytes = 0;
  for (const chunk of value) {
    if (!isObject(chunk)) return false;
    const { s, at, b } = chunk;
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
  const seen = new Set<Error>();
  for (;;) {
    const record = parseStopRecord(error, nonce, run);
    if (record) return record;
    if (!(error instanceof Error) || seen.has(error)) return null;
    seen.add(error);
    error = error.cause;
  }
}

function parseStopRecord(error: unknown, nonce: string, run: number): StopRecord | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const marker = `${STOP_RECORD_PREFIX}${nonce} `;
  const at = message.indexOf(marker);
  if (nonce.length < 16 || at < 0 || message.length - at > STOP_RECORD_MAX_CHARS) return null;
  let r: unknown;
  try { r = JSON.parse(message.slice(at + marker.length)); } catch { return null; }
  if (!isObject(r) || r.v !== 3 || r.run !== run || !isOutput(r.out)) return null;
  let captured: { stdout: string; stderr: string } | undefined;
  if (r.captured !== undefined) {
    if (!isObject(r.captured)) return null;
    const { stdout, stderr } = r.captured;
    if (typeof stdout !== 'string' || typeof stderr !== 'string' || stdout.length + stderr.length > REPLAY_PREFIX_MAX_BYTES) return null;
    captured = { stdout, stderr };
  }
  const { catches } = r;
  if (catches !== undefined && (typeof catches !== 'string' || !/^(SIG[A-Z0-9]+(,SIG[A-Z0-9]+)*)?$/.test(catches) || catches.length > 400)) return null;
  const common = {
    run, out: r.out,
    ...(captured === undefined ? {} : { captured }),
    ...(catches === undefined ? {} : { catches }),
  };
  const { kind, tape } = r;
  if (kind === 'stdin') {
    const { until, stopAt } = r;
    if ((until !== 'end' && until !== 'data') || !isCount(stopAt, REPLAY_TAPE_MAX_READINGS) || !isTape(tape)) return null;
    return { v: 3, ...common, kind, until, stopAt, tape };
  }
  if (kind === 'listen') return isTape(tape) ? { v: 3, ...common, kind, tape } : null;
  if (kind === 'miss') {
    const { path } = r;
    return typeof path === 'string' && path.length > 0 && isTape(tape) ? { v: 3, ...common, kind, path, tape } : null;
  }
  if (kind === 'diverged') {
    const { why } = r;
    return typeof why === 'string' && why.length <= 1000 ? { v: 3, ...common, kind, why } : null;
  }
  return null;
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
  run: number;
  private received = { stdout: 0, stderr: 0 };
  private shown: Record<'stdout' | 'stderr', Uint8Array[]> = { stdout: [], stderr: [] };
  /** More than REPLAY_PREFIX_MAX_BYTES was shown on a stream: no run after a stop can be checked. */
  over = false;

  /** `run`: the run whose output it delivers first (a run from its start after one that stopped). */
  constructor(run = 1) {
    this.run = run;
  }

  /**
   * Run `run` starts over from its start, unchecked: all it prints is
   * delivered from its first byte, and an earlier run's late chunk is not.
   */
  restart(run: number): void {
    if (this.run === -1) return;
    this.run = run;
    this.received = { stdout: 0, stderr: 0 };
    this.shown = { stdout: [], stderr: [] };
    this.over = false;
  }

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
