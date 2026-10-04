import { STOP_RECORD_PREFIX, REPLAY_PREFIX_MAX_BYTES, REPLAY_TAPE_MAX_READINGS, REPLAY_TAPE_MAX_RANDOM_BYTES } from './stop-replay-contracts.js';
import { SUPERVISOR_CALLS_WITHOUT_EFFECTS, REPLAY_OBSERVATION_CALLS } from './stop-replay-policy.js';

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
  const OBSERVATIONS = ${JSON.stringify(Object.fromEntries(REPLAY_OBSERVATION_CALLS.map((name) => [name, true])))};
  const PromiseThen = Promise.prototype.then;
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
        if (typeof value !== "function" || typeof name !== "string") return value;
        return (...args) => {
          const flags = name === "fsOpen" ? args[1] : null;
          const writes = name === "fsOpen" ? !!(flags && (flags.write || flags.append || flags.create || flags.truncate)) : !ObjectHasOwn(QUIET, name);
          const path = args.find((a) => typeof a === "string");
          if (writes) effect(name + (path ? " " + path : ""));
          const result = ReflectApply(value, target, args);
          if (!writes && ObjectHasOwn(OBSERVATIONS, name) && result && typeof result.then === "function") {
            return ReflectApply(PromiseThen, Promise.resolve(result), [
              (answer) => { observed(name); return answer; },
              (error) => { observed(name); throw error; },
            ]);
          }
          return result;
        };
      },
    });
  }

  function observed(op) {
    if (run) run.observed[op] = (run.observed[op] || 0) + 1;
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
    // A synchronous JS frame cannot await an RPC. If it raced a floating
    // observation, fail before exposing new input, naming the missing reply.
    const expected = run.replay.observations || {};
    for (const op of Object.keys(expected)) {
      if ((run.observed[op] || 0) < expected[op]) {
        diverge("reached fd 0 before the recorded answer to " + op + " was delivered (" + (run.observed[op] || 0) + " of " + expected[op] + ")");
      }
    }
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
    observed,
    bodyStarted(what) { const id = run.bodies.length; run.bodies[id] = what; return id; },
    bodyFinished(id) { run.bodies[id] = null; },
    unreplayable,
    effect,
    begin(launch) {
      const replay = launch.replay || null;
      const ctxAbort = launch.abort || null;
      run = {
        observed: {},
        bodies: [],
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
      for (const body of run.bodies) if (body !== null) return "received headers of " + body + ", but its response body was still unfinished";
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
