import { REPLAY_FETCH_MAX_BYTES, REPLAY_JOURNAL_MAX_ENTRIES, REPLAY_STALL_MS, type RecordedResponse } from './stop-replay-contracts.js';
export type { RecordedResponse } from './stop-replay-contracts.js';

import { operationPolicy } from './stop-replay-policy.js';
import { afterTurn } from '@nimbus-sh/core/_shared/after-turn.js';
import { STDIN_FILE_READ_PIECE_BYTES } from '@nimbus-sh/core/runtime/stdin-read.js';
export { SUPERVISOR_CALLS_WITHOUT_EFFECTS } from './stop-replay-policy.js';

/** What a call repeats outside the process; unknown names are never safe. */
export function supervisorCallEffect(op: string, args: readonly unknown[] | undefined): string | null {
  const policy = operationPolicy(op);
  if (policy?.kind === 'open') {
    const flags = args?.[1] as Record<string, unknown> | null | undefined;
    if (!(flags && (flags.write || flags.append || flags.create || flags.truncate))) return null;
    return describeCall(op, args) + ' for writing';
  }
  return policy && policy.kind !== 'effect' ? null : describeCall(op, args);
}

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
    if (depth > 64) throw new RangeError('supervisor answer is deeper than the replay digest can check');
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
      text(v.name);
      for (const key of Object.getOwnPropertyNames(v).sort()) {
        text(key);
        walk((v as unknown as Record<string, unknown>)[key], depth + 1);
      }
    } else {
      mix(14);
      for (const key of Object.keys(v as object).sort()) {
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
  private disqualified: string | null = null;
  private bodies = new Map<string, string>();
  /** Protocol replies are also digested; their replay is owned by the input/output tapes. */
  private protocolReplies: string[] = [];
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
  private boundaryWait: { release: () => void; fail: (e: Error) => void } | null = null;
  private effectsHeld: { what: string; release: () => void; fail: (e: Error) => void }[] = [];
  private stdinFile: { path: string; offset: number; limit: number } | null = null;
  private preparation: { run: string; at: number; remaining: number; pending: boolean } | null = null;
  private externalReads = new Map<string, { run: string | undefined; deliver: (result: { value?: unknown; failure?: unknown; failed?: boolean }) => void; done: Promise<unknown> }>();

  constructor(private readonly onDiverge: DivergeHandler, private readonly stallMs: number = REPLAY_STALL_MS) {}

  /** A run begins: the writer identity its calls carry. */
  start(run: string): void {
    this.run = run;
    this.preparation = this.stdinFile ? { run, at: this.stdinFile.offset, remaining: this.stdinFile.limit, pending: false } : null;
  }
  bindStdinFile(file: { path: string; offset: number; limit: number }): void { this.stdinFile = { ...file }; }
  prepared(run: string | undefined): void { if (this.admits(run)) this.preparation = null; }
  /** Approve external I/O before it starts; its real answer returns by ticket. */
  async externalRead(op: string, args: readonly unknown[] | undefined, run: string | undefined): Promise<{ ticket?: string; readOnly: boolean }> {
    if (!this.admits(run)) throw new Error('this run of the process has stopped');
    if (!this.recording) return { readOnly: false };
    const ticket = crypto.randomUUID();
    let planned!: (plan: { ticket: string; readOnly: boolean }) => void, refused!: (error: unknown) => void;
    const plan = new Promise<{ ticket: string; readOnly: boolean }>((resolve, reject) => { planned = resolve; refused = reject; });
    let deliver!: (result: { value?: unknown; failure?: unknown; failed?: boolean }) => void;
    const produced = new Promise<{ value?: unknown; failure?: unknown; failed?: boolean }>((resolve) => { deliver = resolve; });
    const done = this.answer(callKey(op, args), describeCall(op, args), async () => {
      planned({ ticket, readOnly: true });
      const result = await produced;
      if (result.failed) throw result.failure;
      return result.value;
    });
    this.externalReads.set(ticket, { run, deliver, done });
    done.catch((error) => { refused(error); this.externalReads.delete(ticket); });
    return plan;
  }
  async externalResult(ticket: string, result: { value?: unknown; failure?: unknown; failed?: boolean }, run: string | undefined): Promise<void> {
    const read = this.externalReads.get(ticket);
    if (!this.admits(run) || !read || read.run !== run) throw new Error('no such cache observation for this run');
    this.externalReads.delete(ticket); read.deliver(result); await read.done;
  }

  get unreplayable(): string | null {
    return this.disqualified ?? (this.bodies.size ? `received headers of ${this.bodies.values().next().value}, but its response body was still unfinished` : null);
  }

  bodyStarted(ticket: string, what: string): void { this.bodies.set(ticket, what); }
  bodyFinished(ticket: string): void { this.bodies.delete(ticket); }
  bodyBytes(n: number): void {
    this.recordedBytes += n;
    if (this.recordedBytes > REPLAY_FETCH_MAX_BYTES) this.disqualify(`received more than ${REPLAY_FETCH_MAX_BYTES / 1048576} MiB over the network first`);
  }

  /** What the guest must have received before it may consume new fd-0 bytes. */
  get observations(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [key, entries] of this.expected ?? []) {
      const op = key.slice(0, key.indexOf(' '));
      counts[op] = (counts[op] ?? 0) + entries.filter((e) => e?.completion !== null).length;
    }
    return counts;
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
    this.disqualified = null;
    this.bodies.clear();
    this.protocolReplies = [];
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

  /** RPC hops may deliver the post-read effect before its boundary notice. */
  async beforeEffect(what: string): Promise<Error | null> {
    if (!this.boundaryPassed) {
      await new Promise<void>((release, fail) => { this.effectsHeld.push({ what, release, fail }); this.watch(); });
    }
    return this.effect(what);
  }

  /** The current run cannot be replayed (D1: nothing more is recorded for it). */
  disqualify(why: string): void {
    if (this.disqualified === null) this.disqualified = why;
    this.entries = null;
  }

  /** A supervisor call from the process: answered through `dispatch`, journaled, ordered. */
  handle(op: string, args: readonly unknown[] | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown> {
    if (!this.admits(run)) return Promise.reject(new Error('this run of the process has stopped'));
    if (this.diverged !== null) return Promise.reject(new Error(this.diverged));
    const effect = supervisorCallEffect(op, args);
    if (effect !== null) {
      return this.beforeEffect(effect).then((refused) => refused ? Promise.reject(refused) : dispatch());
    }
    if (this.boundaryPassed && this.entries === null) return dispatch();
    const policy = operationPolicy(op)!;
    if (op === 'stdinFileRead') {
      const prep = this.preparation;
      const [path, offset, length] = args ?? [];
      const authorized = prep && prep.run === run && !prep.pending && path === this.stdinFile?.path && offset === prep.at
        && typeof length === 'number' && Number.isSafeInteger(length) && length > 0 && length <= Math.min(STDIN_FILE_READ_PIECE_BYTES, prep.remaining);
      if (!authorized) return this.answer(callKey(op, args), describeCall(op, args), dispatch);
      prep.pending = true;
      return dispatch().then((value) => {
        const reply = value as { data: Uint8Array; size: number };
        if (!(reply.data instanceof Uint8Array) || reply.data.length > (length as number)) throw new Error('invalid stdin preparation reply');
        prep.at += reply.data.length; prep.remaining -= reply.data.length; prep.pending = false;
        if (prep.at >= reply.size || prep.remaining === 0) this.preparation = null;
        this.protocolReplies.push(op + ' ' + answerDigest(value));
        return value;
      }, (error) => { prep.pending = false; throw error; });
    }
    if (policy.kind === 'input' || policy.kind === 'output' || policy.kind === 'control') {
      // Input packets are checked by the session-owned stdin account and
      // read tape; output acknowledgements by the output-prefix protocol.
      return dispatch().then((value) => {
        if (policy.kind === 'output' && value !== undefined) this.disqualify(`${op} returned an observable acknowledgement without a replay contract`);
        if (policy.kind === 'input' && value && typeof value === 'object') {
          const unsupported = Object.keys(value).find((key) => !policy.inputFields?.includes(key) && (value as Record<string, unknown>)[key] !== undefined);
          if (unsupported) this.disqualify(`${op} delivered ${unsupported}, which the stdin tape cannot replay`);
        }
        if (this.protocolReplies.length >= REPLAY_JOURNAL_MAX_ENTRIES) this.disqualify('received too many protocol replies');
        else this.protocolReplies.push(op + ' ' + answerDigest(value));
        return value;
      }, (error) => { this.disqualify(describeCall(op, args) + ' failed: ' + String(error)); throw error; });
    }
    const key = callKey(op, policy.args ? policy.args(args ?? []) : args);
    return this.answer(key, describeCall(op, args), dispatch, undefined, policy.answer);
  }

  /**
   * One journaled answer: `produce` yields it (and a recording to keep, for a
   * response); a run after a stop is answered as the run before it was, or it
   * strays. Resolves when the program may have it.
   */
  async answer<T>(key: string, what: string, produce: (expected?: Expected) => Promise<T>, record?: (value: T) => RecordedResponse | undefined, observe: (value: unknown) => unknown = (value) => value): Promise<T> {
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
    let failed = false;
    let digest: string;
    try {
      value = await produce(expected);
      try { digest = answerDigest(observe(value)); }
      catch (error) {
        const refused = this.effect(`${what} could not be checked for replay (${String(error)})`);
        if (refused) throw refused;
        digest = 'unrecordable';
      }
    } catch (error) {
      failed = true;
      failure = error;
      digest = 'error:' + answerDigest(error);
    }
    if (this.run !== asking) throw new Error('this run of the process has stopped');
    if (expected !== undefined && expected.digest !== undefined && expected.digest !== digest) {
      throw this.diverge(`${what} was answered differently from the run before it (it changed while the process waited)`);
    }
    if (expected !== undefined) await this.hold(expected.completion);
    if (this.run !== asking) throw new Error('this run of the process has stopped');
    // The next answer in the run before's order goes once this one has.
    if (expected !== undefined && expected.completion !== null) afterTurn(() => this.advance());
    if (entry !== null && this.entries !== null && this.entries === entries) {
      entry.digest = digest;
      entry.completion = this.completions++;
      if (record && !failed) {
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
    if (failed) throw failure;
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
  async boundary(run: string | undefined): Promise<void> {
    if (!this.admits(run)) throw new Error('this run of the process has stopped');
    if (this.diverged !== null) throw new Error(this.diverged);
    if (this.boundaryPassed) return;
    if (this.expectedAsked < this.expectedCompleted) {
      throw this.diverge(`it reached the read without asking for everything the run before it was answered before it (${this.expectedAsked} of ${this.expectedCompleted})`);
    }
    if (this.delivered < this.expectedCompleted) {
      await new Promise<void>((release, fail) => { this.boundaryWait = { release, fail }; this.watch(); });
    }
    this.boundaryPassed = true;
    this.expected = null;
    for (const held of this.atBoundary.splice(0)) held.release();
    for (const held of this.effectsHeld.splice(0)) held.release();
    this.watch();
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
    if (this.delivered === this.expectedCompleted && this.boundaryWait) {
      this.boundaryWait.release();
      this.boundaryWait = null;
    }
    this.watch();
  }

  private watch(): void {
    if (this.stall !== null) clearTimeout(this.stall);
    this.stall = null;
    if (this.waiting.size === 0 && this.boundaryWait === null && this.effectsHeld.length === 0) return;
    this.stall = setTimeout(() => {
      this.stall = null;
      if (this.waiting.size > 0 || this.boundaryWait !== null) {
        this.diverge(`it did not ask again for what the run before it was answered next (answer ${this.delivered + 1} of ${this.expectedCompleted})`);
      } else if (this.effectsHeld.length) {
        this.diverge(`it did something outside itself before the read, which the run before it did not (${this.effectsHeld[0].what}); no completed replay boundary was delivered`);
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
    this.boundaryWait?.fail(error);
    this.boundaryWait = null;
    for (const held of this.effectsHeld.splice(0)) held.fail(error);
    for (const read of this.externalReads.values()) read.deliver({ failed: true, failure: error });
    this.externalReads.clear();
  }
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
