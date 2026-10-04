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
 * The stop is `ctx.abort()`, which terminates the isolate's JavaScript at
 * once (V8 TerminateExecution): no catch, finally, microtask or timer of the
 * program runs after it, so the program cannot observe it. The abort's reason
 * reaches the caller whole and carries the stop record: the output the
 * session has not acknowledged, and a tape of what the run drew from outside
 * itself — its random seed, clock readings and random bytes, how much each
 * synchronous read of stdin took, and a hash of everything it observed (each
 * file read, stat, listing and response body), in the order it asked. The
 * supervisor waits for the input (FacetManager.exec), then launches the same
 * program on the same pid from fresh module state with the stdin the stopped
 * run took, the new input after it, and the tape. That run replays the tape
 * up to the read the stopped run stopped at (the boundary): the same draws,
 * the same reads, the same observations, the same output on both streams,
 * which the session already showed and which is checked and dropped. At the
 * boundary both streams must have printed exactly what the stopped run had;
 * from there the program goes on with its input. A replay that observes,
 * prints or does anything else before the boundary is ended loudly
 * (`diverged`); nothing it did differently reaches anyone.
 *
 * A run can be replayed only while it has done nothing outside itself: a
 * second run would do it again. The guest counts every call that could (the
 * SUPERVISOR binding by default-deny, fetch, sockets, http clients), and a
 * read that finds its input missing in a run that made one fails with
 * ERR_NIMBUS_SYNC_STDIN naming it. A program that never reads stdin
 * synchronously, or finds its input there when it does, runs once and is
 * never held: no static guess about the code is made.
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

/** The most clock readings, observations and random bytes a replayable run may draw. */
export const REPLAY_TAPE_MAX_READINGS = 65_536;
export const REPLAY_TAPE_MAX_RANDOM_BYTES = 1024 * 1024;

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
  'getPackument', 'getCachedTarball', 'prefetch', 'transform',
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
  /** A hash of each observation (file read, stat, listing, response body), by the order it was asked for. */
  obs: (number | null)[];
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
  v: 2;
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
  /** A run whose output is captured, not streamed: what it had printed, base64. */
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
    && Array.isArray(tape.reads) && tape.reads.length <= REPLAY_TAPE_MAX_READINGS && tape.reads.every((n) => isCount(n, Number.MAX_SAFE_INTEGER))
    && Array.isArray(tape.obs) && tape.obs.length <= REPLAY_TAPE_MAX_READINGS && tape.obs.every((h) => h === null || isCount(h, 0xffffffff));
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
 * Nothing in a record is used before all of it is checked.
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
  if (r.v !== 2 || r.run !== run || !isOutput(r.out)) return null;
  if (r.captured !== undefined) {
    const captured = r.captured as Record<string, unknown> | null;
    if (typeof captured !== 'object' || captured === null
      || !isBase64Within(captured.stdout, REPLAY_PREFIX_MAX_BYTES) || !isBase64Within(captured.stderr, REPLAY_PREFIX_MAX_BYTES)) return null;
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
    this.run = record.run + 1;
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
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `const __nimbusStopReplay`, private to the runner module.
 *
 *   ledger(supervisor)   the SUPERVISOR binding, counting calls that do
 *                        something outside the process (default-deny).
 *   begin(launch)        per run: { replay, abort, captured, capturedText, nonce }.
 *   arm(canStop, whyNot) before the entry: records what the run draws when it
 *                        can stop, replays what the stopped run drew.
 *   write / acked        each streamed chunk of output on its way out.
 *   readSome / readAll   how many bytes a synchronous read of stdin returns.
 *   block(until, syscall)  a read cannot complete: stops the run, or says why it cannot.
 *   observe / observeLater / observeStream  what the program saw of a file,
 *                        a listing or a response.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   finish() / booted()  at exit, or when a resident is up: a replay that
 *                        never reached the read it stopped at.
 */
export const STOP_REPLAY_SOURCE = `
const __nimbusStopReplay = (() => {
  const QUIET = ${JSON.stringify(Object.fromEntries(SUPERVISOR_CALLS_WITHOUT_EFFECTS.map((name) => [name, true])))};
  const PREFIX = ${JSON.stringify(STOP_RECORD_PREFIX)};
  const PREFIX_MAX = ${REPLAY_PREFIX_MAX_BYTES};
  const READINGS_MAX = ${REPLAY_TAPE_MAX_READINGS};
  const RANDOM_MAX = ${REPLAY_TAPE_MAX_RANDOM_BYTES};
  const toBase64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (text) => {
    const s = atob(text || "");
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  };
  const concat = (chunks) => {
    let size = 0;
    for (const c of chunks) size += c.byteLength;
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  };
  // FNV-1a, 32 bits, over what an observation returned: bytes as bytes, text
  // as UTF-16 units, anything else as its JSON. Not a defence against a
  // chosen collision; an accident of content, a changed file, is what it is for.
  const fnv = (h, code) => Math.imul(h ^ code, 16777619) >>> 0;
  function hashStart(kind) {
    let h = 2166136261;
    for (let i = 0; i < kind.length; i++) h = fnv(h, kind.charCodeAt(i));
    return fnv(h, 0);
  }
  function hashMore(h, value) {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      for (let i = 0; i < bytes.length; i++) h = fnv(h, bytes[i]);
      return h;
    }
    const text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } })();
    for (let i = 0; i < text.length; i++) h = fnv(h, text.charCodeAt(i));
    return h;
  }
  const realRandomValues = globalThis.crypto && globalThis.crypto.getRandomValues
    ? globalThis.crypto.getRandomValues.bind(globalThis.crypto) : null;
  let run = null;

  function pendingOut() {
    return run.captured ? [] : run.pending.map((c) => ({ s: c.s, at: c.at, b: toBase64(c.b) }));
  }
  // What a captured run has printed, as the runner holds it.
  function capturedOut() {
    if (!run.captured || !run.canStop || typeof run.capturedText !== "function") return undefined;
    const text = run.capturedText();
    const encoder = new TextEncoder();
    return { stdout: toBase64(encoder.encode(text.stdout || "")), stderr: toBase64(encoder.encode(text.stderr || "")) };
  }
  function capturedBytes() {
    if (!run.captured || typeof run.capturedText !== "function") return 0;
    const text = run.capturedText();
    return (text.stdout || "").length + (text.stderr || "").length;
  }
  // A replay that does not retrace the run before it is ended before what it
  // does differently reaches anyone.
  function diverge(why) {
    const record = { v: 2, kind: "diverged", run: run.number, why: String(why).slice(0, 900), out: pendingOut(), captured: capturedOut() };
    if (run.abort) run.abort(new Error(PREFIX + run.nonce + " " + JSON.stringify(record)));
    throw new Error("node: this program did not retrace its run before when Nimbus ran it again to wait for stdin: " + why);
  }
  const replaying = () => run !== null && run.replay !== null && !run.boundaryPassed;
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
        if (typeof value !== "function" || typeof name !== "string" || Object.hasOwn(QUIET, name)) return value;
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
  function readings(entries, record) {
    let i = 0, used = 0;
    return (live) => {
      while (i < entries.length && used >= entries[i][1]) { i++; used = 0; }
      if (i < entries.length) { used++; return entries[i][0]; }
      const value = live();
      if (!record) return value;
      const last = entries[entries.length - 1];
      if (last && last[0] === value) last[1]++;
      else if (entries.length >= READINGS_MAX) unreplayable("read the clock more than " + READINGS_MAX + " times first, more than a second run is handed back");
      else entries.push([value, 1]);
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

  function installTape(tape, record) {
    const seed = tape ? tape.seed : Array.from(realRandomValues ? realRandomValues(new Uint32Array(4)) : [Date.now() >>> 0, 1, 2, 3]);
    const now = tape ? tape.now.map((e) => e.slice()) : [];
    const perf = tape ? tape.perf.map((e) => e.slice()) : [];
    const given = tape ? fromBase64(tape.random) : new Uint8Array(0);
    const drawn = given.byteLength > 0 ? [given] : [];
    let drawnBytes = given.byteLength;
    let givenAt = 0;
    run.tape = { seed, now, perf, drawn, reads: tape ? tape.reads.slice() : [], obs: tape ? tape.obs.slice() : [] };
    run.replayedReads = tape ? tape.reads.length : 0;
    run.recordTape = record;

    Math.random = seeded(seed);

    // Date, with the current time taken from the tape: new Date(), Date()
    // and Date.now(). Same prototype and statics, so instanceof and
    // subclasses are unchanged.
    const RealDate = globalThis.Date;
    const nowReading = readings(now, record);
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
      const perfReading = readings(perf, record);
      try { performance.now = () => perfReading(realPerfNow); } catch {}
    }

    const crypto = globalThis.crypto;
    if (crypto && realRandomValues) {
      const getRandomValues = function getRandomValues(view) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (bytes.byteLength <= 65536 && givenAt + bytes.byteLength <= given.byteLength) {
          bytes.set(given.subarray(givenAt, givenAt + bytes.byteLength));
          givenAt += bytes.byteLength;
          return view;
        }
        givenAt = given.byteLength;
        realRandomValues(view);
        if (record) {
          if (drawnBytes + bytes.byteLength > RANDOM_MAX) unreplayable("drew more than " + RANDOM_MAX + " random bytes first, more than a second run is handed back");
          else { drawn.push(bytes.slice()); drawnBytes += bytes.byteLength; }
        }
        return view;
      };
      const randomUUID = function randomUUID() {
        const b = getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        let h = "";
        for (const x of b) h += (x < 16 ? "0" : "") + x.toString(16);
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
      };
      try { crypto.getRandomValues = getRandomValues; crypto.randomUUID = randomUUID; } catch {}
    }
  }

  // The replay reached the read the run before it stopped at: by now it has
  // printed exactly what that run had, on both streams, and from here on its
  // output and what it does are its own.
  function boundary() {
    if (run.prefix) {
      for (const stream of ["stdout", "stderr"]) {
        if (run.sent[stream] !== run.prefix[stream].byteLength) {
          diverge("by the read it stopped at, the run before it had printed " + run.prefix[stream].byteLength
            + " bytes to " + stream + " and this one " + run.sent[stream]);
        }
      }
    }
    run.boundaryPassed = true;
  }
  function check(seq, kind, h) {
    if (!run || !run.tape) return;
    const was = run.tape.obs[seq];
    if (run.replay !== null && was !== undefined && was !== null) {
      if (was !== h) diverge(kind + " is not what the run before it saw there (a file or a response changed while it waited)");
      return;
    }
    if (!run.recordTape) return;
    if (seq >= READINGS_MAX) { unreplayable("looked at more than " + READINGS_MAX + " files and responses first, more than a second run is checked against"); return; }
    run.tape.obs[seq] = h;
  }

  return {
    ledger,
    unreplayable,
    effect,
    begin(launch) {
      const replay = launch.replay || null;
      run = {
        number: replay ? replay.run : 1,
        abort: typeof launch.abort === "function" ? launch.abort : null,
        nonce: String(launch.nonce || ""),
        captured: !!launch.captured,
        // The runner's accumulated output when it is captured, not streamed.
        capturedText: typeof launch.capturedText === "function" ? launch.capturedText : null,
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
        obsAt: 0,
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
    get observing() { return !!(run && run.tape); },
    // A chunk of streamed output: the part to send, with its offset, or null.
    write(stream, bytes) {
      if (!run) return { b: bytes, at: undefined, run: undefined };
      const off = run.sent[stream];
      run.sent[stream] = off + bytes.byteLength;
      if (run.canStop && run.sent[stream] > PREFIX_MAX) unreplayable("printed more than " + PREFIX_MAX + " bytes to " + stream + " first, more than a second run is checked against");
      if (replaying() && run.prefix) {
        const prefix = run.prefix[stream];
        if (off + bytes.byteLength > prefix.byteLength) {
          diverge("before the read it stopped at, it printed more to " + stream + " than the run before it had (" + (off + bytes.byteLength) + " of " + prefix.byteLength + " bytes)");
        }
        for (let i = 0; i < bytes.byteLength; i++) {
          if (bytes[i] !== prefix[off + i]) diverge("it printed something else to " + stream + " (byte " + (off + i) + ")");
        }
        return null;
      }
      if (bytes.byteLength === 0) return null;
      const chunk = { s: stream, b: bytes, at: off, run: run.number };
      run.pending.push(chunk);
      return chunk;
    },
    acked(chunk) {
      if (!run) return;
      const i = run.pending.indexOf(chunk);
      if (i >= 0) run.pending.splice(i, 1);
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
      if (run.recordTape) {
        if (run.tape.reads.length >= READINGS_MAX) unreplayable("read stdin more than " + READINGS_MAX + " times first");
        else run.tape.reads.push(available);
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
      if (run.recordTape && run.tape.reads.length < run.readAt) run.tape.reads.push(length);
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
      if (capturedBytes() > PREFIX_MAX) return "printed more than " + PREFIX_MAX + " bytes first, more than a stop can keep";
      const record = {
        v: 2, kind: "stdin", run: run.number, until, stopAt: run.readAt,
        out: pendingOut(), captured: capturedOut(),
        tape: {
          seed: run.tape.seed, now: run.tape.now, perf: run.tape.perf,
          random: toBase64(concat(run.tape.drawn)), reads: run.tape.reads, obs: Array.from(run.tape.obs, (h) => h ?? null),
        },
      };
      run.abort(new Error(PREFIX + run.nonce + " " + JSON.stringify(record)));
      return "could not be stopped";
    },
    // What the program saw: \\\`observe\\\` now; \\\`observeLater\\\` returns the
    // function that takes what an asynchronous one saw, in the order it was
    // asked for.
    observe(kind, value) {
      if (!run || !run.tape) return;
      check(run.obsAt++, kind, hashMore(hashStart(kind), value));
    },
    observeLater(kind) {
      if (!run || !run.tape) return null;
      const seq = run.obsAt++;
      return (value) => check(seq, kind, hashMore(hashStart(kind), value));
    },
    // What a stream handed over, piece by piece, as one observation.
    observeStream(kind) {
      if (!run || !run.tape) return null;
      const seq = run.obsAt++;
      let h = hashStart(kind), done = false;
      return {
        add(piece) { if (!done) h = hashMore(h, piece); },
        end(outcome) { if (done) return; done = true; check(seq, kind, outcome === undefined ? h : hashMore(h, outcome)); },
      };
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
