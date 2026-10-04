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
 * program runs after it, so the program cannot observe it. The abort's
 * reason reaches the caller whole, and carries the stop record: the output
 * the session has not acknowledged, and what the stopped run drew from the
 * outside — its random seed, the clock readings, the random bytes, the stdin
 * bytes and how much each read took. The supervisor waits for the input
 * (FacetManager.exec), then launches the same program on the same pid from
 * fresh module state. That run replays the record: the same draws in the same
 * order, the same reads, so the program takes the same path to the read,
 * printing the same bytes, which are checked against and dropped; then the
 * read finds its input and the program goes on. Output the replay prints
 * differently fails the process loudly rather than reaching anyone.
 *
 * A run can be replayed only while it has changed nothing outside itself: a
 * second run would change it again. The guest counts every call that could
 * (STOP_REPLAY_SOURCE's ledger, at the SUPERVISOR binding and at fetch), and
 * a read that finds its input missing in a run that made one fails with
 * ERR_NIMBUS_SYNC_STDIN naming it. A program that never reads stdin
 * synchronously, or finds its input there when it does, runs once and is
 * never held: no static guess about the code is made.
 */

/** What an abort's reason starts with when it is a stop record. */
export const STOP_RECORD_PREFIX = 'NIMBUS_STOP ';

/** How many times one process may stop before its read fails instead. */
export const STOP_LIMIT = 64;

/**
 * The most output per stream a run may have printed and still be replayed:
 * the next run is checked against all of it, so the stop carries it.
 */
export const REPLAY_PREFIX_MAX_BYTES = 1024 * 1024;

/** The most clock readings, and random bytes, a replayable run may draw. */
export const REPLAY_TAPE_MAX_READINGS = 65_536;
export const REPLAY_TAPE_MAX_RANDOM_BYTES = 1024 * 1024;

/**
 * SUPERVISOR calls that change nothing outside the process: reads, its own
 * output, what it learned for its next launch, and its own per-process state
 * (umask, a descriptor's position). Every other call counts as a change a
 * second run would repeat, including any name added to SupervisorRPC later.
 * `fsOpen` counts only when it opens for writing (STOP_REPLAY_SOURCE).
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
  /** How many bytes each synchronous read of stdin returned. */
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
  v: 1;
  /** `stdin`: a read needs input not there yet. `diverged`: a replay printed differently. */
  kind: 'stdin' | 'diverged';
  /** The run that stopped (1 for the first). */
  run: number;
  /** What the read waits for: the end of stdin, or any of it. */
  until?: 'end' | 'data';
  syscall?: string;
  /** The stdin bytes the run took from its channel before it started, base64. */
  taken?: string;
  out?: StoppedOutput[];
  /** Everything the run printed, per stream, base64: what the next run must print first. */
  prefix?: { stdout: string; stderr: string } | null;
  tape?: ReplayTape;
  /** `diverged`: which stream, and the first byte that differed. */
  stream?: 'stdout' | 'stderr';
  at?: number;
}

/** What a relaunch is handed (the runner's `args.replay`). */
export interface ReplayLaunch {
  run: number;
  tape: ReplayTape;
  prefix: { stdout: string; stderr: string } | null;
}

/** The stop record an error carries, or null for any other error. */
export function stopRecordOf(error: unknown): StopRecord | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const at = message.indexOf(STOP_RECORD_PREFIX);
  if (at < 0) return null;
  try {
    const record = JSON.parse(message.slice(at + STOP_RECORD_PREFIX.length)) as StopRecord;
    return record && record.v === 1 && typeof record.run === 'number' ? record : null;
  } catch {
    return null;
  }
}

export function decodeBase64(text: string | undefined): Uint8Array {
  if (!text) return new Uint8Array(0);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const EMPTY = new Uint8Array(0);

/**
 * The session's side of a process's output across its runs: each chunk a run
 * prints arrives tagged with the run and its offset, so a chunk the session
 * already has (it also rode a stop) is delivered once, and a stopped run's
 * late chunk is dropped (it rode the stop, or its run's successor prints it).
 */
export class ReplayOutputGate {
  run = 1;
  private received = { stdout: 0, stderr: 0 };

  /** The part of a chunk not yet delivered. */
  take(stream: 'stdout' | 'stderr', data: Uint8Array, at: number, run: number): Uint8Array {
    if (run !== this.run) return EMPTY;
    const skip = Math.max(0, this.received[stream] - at);
    if (skip >= data.byteLength) return EMPTY;
    this.received[stream] = Math.max(this.received[stream], at + data.byteLength);
    return skip > 0 ? data.subarray(skip) : data;
  }

  /**
   * Run `record.run` stopped: what its record carries that is not yet
   * delivered, in order. Its successor's output starts past the prefix, which
   * the session then holds whole.
   */
  stopped(record: StopRecord): { stream: 'stdout' | 'stderr'; bytes: Uint8Array }[] {
    const fresh: { stream: 'stdout' | 'stderr'; bytes: Uint8Array }[] = [];
    for (const chunk of record.out ?? []) {
      const bytes = this.take(chunk.s, decodeBase64(chunk.b), chunk.at, record.run);
      if (bytes.byteLength > 0) fresh.push({ stream: chunk.s, bytes });
    }
    this.run = record.run + 1;
    this.received = {
      stdout: decodeBase64(record.prefix?.stdout).byteLength,
      stderr: decodeBase64(record.prefix?.stderr).byteLength,
    };
    return fresh;
  }
}

/**
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `globalThis.__nimbusStopReplay`.
 *
 *   ledger(supervisor)  the SUPERVISOR binding, counting calls that change
 *                       something outside the process.
 *   begin(replay, abort, captured)  per run: the replay it was handed, how to
 *                       stop it (ctx.abort), and whether its output is
 *                       captured rather than streamed.
 *   arm(canStop, whyNot)  before the entry: records what the run draws when
 *                       it can stop, replays what the stopped run drew.
 *   write / acked       each chunk of output on its way to the supervisor.
 *   read(n)             how many bytes a synchronous read of stdin returns.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   stop(until, syscall, taken)  stops the run; returns the reason it cannot.
 *   finish()            at exit: a replay that printed less than its prefix.
 */
export const STOP_REPLAY_SOURCE = `
(() => {
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
  const realRandomValues = globalThis.crypto && globalThis.crypto.getRandomValues
    ? globalThis.crypto.getRandomValues.bind(globalThis.crypto) : null;
  let run = null;

  function unreplayable(why) {
    if (run && run.armed && run.why === null) run.why = why;
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
          if (writes) unreplayable("made a change outside itself first (" + name + (path ? " " + path : "") + "), which a second run would make again");
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
    const seed = tape ? tape.seed : Array.from(realRandomValues ? realRandomValues(new Uint32Array(4)) : [Date.now(), 1, 2, 3]);
    const now = tape ? tape.now.map((e) => e.slice()) : [];
    const perf = tape ? tape.perf.map((e) => e.slice()) : [];
    const given = tape ? fromBase64(tape.random) : new Uint8Array(0);
    const drawn = given.byteLength > 0 ? [given] : [];
    let drawnBytes = given.byteLength;
    let givenAt = 0;
    run.tape = { seed, now, perf, drawn, reads: tape ? tape.reads.slice() : [] };
    run.readAt = 0;
    run.recordTape = record;

    Math.random = seeded(seed);

    // Date, with the current time taken from the record: new Date(), Date()
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

  globalThis.__nimbusStopReplay = {
    ledger,
    unreplayable,
    effect(what) { unreplayable("made a change outside itself first (" + what + "), which a second run would make again"); },
    begin(replay, abort, captured) {
      run = {
        number: replay ? replay.run : 1,
        abort: typeof abort === "function" ? abort : null,
        captured: !!captured,
        replay: replay || null,
        armed: false,
        canStop: false,
        why: null,
        whyNot: null,
        prefix: replay && replay.prefix && !captured
          ? { stdout: fromBase64(replay.prefix.stdout), stderr: fromBase64(replay.prefix.stderr) } : null,
        sent: { stdout: 0, stderr: 0 },
        kept: { stdout: [], stderr: [] },
        pending: [],
        tape: null,
        readAt: 0,
        recordTape: false,
      };
    },
    // \`whyNot\`: why the run cannot stop, when it cannot.
    arm(canStop, whyNot) {
      if (!run) return;
      run.armed = true;
      run.canStop = !!canStop;
      run.whyNot = whyNot || "cannot be stopped where it reads";
      if (run.canStop && !run.abort) run.why = "runs where Nimbus cannot stop it";
      if (run.canStop || run.replay) installTape(run.replay ? run.replay.tape : null, run.canStop);
    },
    get armed() { return !!(run && run.armed); },
    run() { return run ? run.number : 1; },
    // A chunk of output: the part to send, with its offset, or null.
    write(stream, bytes) {
      if (!run) return { b: bytes, at: undefined, run: undefined };
      const off = run.sent[stream];
      run.sent[stream] = off + bytes.byteLength;
      if (run.canStop && !run.captured && run.why === null) {
        if (off + bytes.byteLength > PREFIX_MAX) unreplayable("printed more than " + PREFIX_MAX + " bytes to " + stream + " first, more than a second run is checked against");
        else run.kept[stream].push(bytes.slice());
      }
      let out = bytes, at = off;
      const prefix = run.prefix ? run.prefix[stream] : null;
      if (prefix && off < prefix.byteLength) {
        const n = Math.min(bytes.byteLength, prefix.byteLength - off);
        for (let i = 0; i < n; i++) {
          if (bytes[i] !== prefix[off + i]) this.diverged(stream, off + i);
        }
        out = bytes.subarray(n);
        at = off + n;
      }
      if (out.byteLength === 0) return null;
      const chunk = { s: stream, b: out, at, run: run.number };
      run.pending.push(chunk);
      return chunk;
    },
    acked(chunk) {
      if (!run) return;
      const i = run.pending.indexOf(chunk);
      if (i >= 0) run.pending.splice(i, 1);
    },
    // How many of \`n\` available bytes a synchronous read of stdin returns:
    // what the stopped run's read returned, then what is there.
    read(n) {
      if (!run || !run.tape) return n;
      const reads = run.tape.reads;
      if (run.readAt < reads.length) {
        const recorded = reads[run.readAt++];
        if (recorded <= n) return recorded;
        unreplayable("read stdin differently when it was run again");
        return n;
      }
      if (run.recordTape) { reads.push(n); run.readAt = reads.length; }
      return n;
    },
    stop(until, syscall, taken) {
      if (!run || !run.armed) return "had not started";
      if (!run.canStop) return run.whyNot;
      if (run.why !== null) return run.why;
      const record = {
        v: 1, kind: "stdin", run: run.number, until, syscall,
        taken: toBase64(taken || new Uint8Array(0)),
        out: run.captured ? [] : run.pending.map((c) => ({ s: c.s, at: c.at, b: toBase64(c.b) })),
        prefix: run.captured ? null : { stdout: toBase64(concat(run.kept.stdout)), stderr: toBase64(concat(run.kept.stderr)) },
        tape: {
          seed: run.tape.seed, now: run.tape.now, perf: run.tape.perf,
          random: toBase64(concat(run.tape.drawn)), reads: run.tape.reads,
        },
      };
      run.abort(new Error(PREFIX + JSON.stringify(record)));
      return "could not be stopped";
    },
    diverged(stream, at) {
      const record = {
        v: 1, kind: "diverged", run: run.number, stream, at,
        out: run.pending.map((c) => ({ s: c.s, at: c.at, b: toBase64(c.b) })),
      };
      if (run.abort) run.abort(new Error(PREFIX + JSON.stringify(record)));
      throw new Error("node: this program printed something different when Nimbus ran it again (" + stream + " byte " + at + ")");
    },
    finish() {
      if (!run || !run.prefix) return "";
      for (const stream of ["stdout", "stderr"]) {
        if (run.sent[stream] < run.prefix[stream].byteLength) {
          return "node: this program printed less when Nimbus ran it again to wait for stdin (" + stream + " stopped at byte "
            + run.sent[stream] + " of " + run.prefix[stream].byteLength + "), so its output past the read is not shown.\\n";
        }
      }
      return "";
    },
  };
})();
`;
