/**
 * realm.ts — a program's realm of its own: a worker thread or a process, and
 * what crosses.
 *
 * The library host used to evaluate what it ran in its own realm, so a
 * program's globals and intrinsics were the host's: an inline `node` program
 * that rebound `Array` or installed fake timers changed them for the host,
 * and so did a Ruby program through its `js` bridge in a facet. A worker
 * thread is a realm and an event loop of its own, and `terminate()` ends it
 * even in a loop that never yields. A `vm` context is a realm too, but every
 * host object handed into it carries the host's prototypes, a sync loop in it
 * cannot be stopped, and a blocking read could only block the host's own
 * thread.
 *
 * This is the one mechanism both realms use: the inline `node`'s run
 * (substrate/lifo/commands/system/node-realm.ts) and a facet of the local
 * facet host (local-facet-host.ts). The guest's side is realm-guest.ts. What
 * crosses:
 *
 *   - calls, guest to host: each names its id and whether the guest waits
 *     for it (holding its thread, as a blocking syscall holds a process) or
 *     goes on and takes the answer when it comes; the host answers each,
 *     value or error, on the channel its kind is read from;
 *   - events, either way: whatever the realm's user says they are, each
 *     narrowed where it arrives.
 *
 * A realm is a worker thread (`isolation: 'thread'`) or, for a guest its
 * engine cannot end in a thread, a process of its own (`'process'`): Bun 1.4
 * does not terminate a worker that is running WebAssembly (`terminate()`
 * never settles and the thread spins on, a core for good, where Node ends it
 * at once; a worker running JavaScript, or WebAssembly that calls into
 * JavaScript, Bun ends), and a process ends at SIGKILL whatever it runs.
 *
 * In a thread, calls and their answers go on a MessagePort, `calls`; the host
 * sets `wake` and notifies it after each answer, and a waiting guest waits
 * with Atomics.wait on `wake`, taking answers with receiveMessageOnPort.
 * Events go on `events`. In a process, the same messages go as frames (a
 * length, then the message's v8 serialization) on pipes ({@link REALM_FDS}):
 * the answers a guest waits for on one it only ever reads synchronously, the
 * others on one it reads as they come, so a guest never blocks on an answer
 * it did not wait for.
 *
 * The guest is untrusted (the program shares its realm). Its channels reach
 * it by its first message, never through `workerData` a program can import.
 * It starts with nothing of the host's environment, and a process guest with
 * no .env, no config and no preload of where it runs. Nothing it sends ends
 * the host: no answer that cannot cross, no failed call, no frame larger than
 * {@link MAX_FRAME_BYTES} (which ends the realm). A process realm is a process
 * group of its own: ending it ends every process the guest started that
 * stayed in it, and its end waits for none that left (one that called
 * setsid left; only an OS sandbox contains that).
 *
 * Bun and Node both carry node:worker_threads, SharedArrayBuffer and
 * Atomics.wait in workers, and child processes; workerd has none, and
 * isolates of its own.
 */

import type * as ChildProcesses from 'node:child_process';
import type HostProcess from 'node:process';
import type * as V8 from 'node:v8';
import type * as WorkerThreads from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { isVfsErrorCode, VfsError } from '../vfs/vfs-error.js';
import { exitCodeForSignal, parseSignalName } from '../substrate/lifo/shell/signals.js';

// ── The protocol ──────────────────────────────────────────────────────────────

/** The guest's first message: what it was started with, and its ports. */
export interface RealmStart {
  readonly payload: unknown;
  readonly calls: MessagePort;
  readonly events: MessagePort;
  /** One Int32: set to 1 and notified when an answer is on `calls`. */
  readonly wake: SharedArrayBuffer;
}

/** A call the guest makes; `wait` when the guest holds its thread for the answer. */
export interface RealmCall {
  readonly id: number;
  readonly request: unknown;
  readonly wait: boolean;
}

/** What a call came to: its value, or the error it threw, as data. */
export type RealmOutcome = { readonly value: unknown } | { readonly error: RealmError };

/** A call's answer, as the guest receives it. */
export type RealmAnswer = RealmOutcome & { readonly id: number };

export interface RealmError {
  readonly name: string;
  readonly message: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function isRealmStart(value: unknown): value is RealmStart {
  return record(value) && 'payload' in value && value.wake instanceof SharedArrayBuffer && record(value.calls) && record(value.events);
}

export function isRealmCall(value: unknown): value is RealmCall {
  return record(value) && Number.isSafeInteger(value.id) && 'request' in value && typeof value.wait === 'boolean';
}

export function isRealmAnswer(value: unknown): value is RealmAnswer {
  return record(value) && Number.isSafeInteger(value.id)
    && ('value' in value || (record(value.error) && typeof value.error.message === 'string'));
}

// ── A process realm's frames ─────────────────────────────────────────────────

/**
 * The pipes of a process realm, by the guest's file descriptor: the answers
 * it waits for (read only synchronously), the host's events, what the guest
 * sends (its calls and events), and the answers it does not wait for.
 */
export const REALM_FDS = { waited: 3, events: 4, toHost: 5, answers: 6 } as const;

/**
 * The largest frame a process guest may send: the largest single value it
 * has reason to (a write, an answer), with room. It bounds one frame, not a
 * realm's memory: a frame is allocated once its length is known, a longer one
 * ends the realm before a byte of it is kept, and decoding a full frame can
 * cost a few times its size while the next arrives. A process guest shares
 * the host machine with the host, so it is not a memory boundary either.
 */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** What a process realm's guest sends: a call, or an event. */
export type GuestFrame =
  | ({ readonly kind: 'call' } & RealmCall)
  | { readonly kind: 'event'; readonly event: unknown };

export function isGuestFrame(value: unknown): value is GuestFrame {
  return record(value) && ((value.kind === 'call' && isRealmCall(value)) || (value.kind === 'event' && 'event' in value));
}

/** A serialized message as a frame: its length (u32, little-endian), then the bytes. */
export function encodeFrame(serialized: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + serialized.byteLength);
  new DataView(framed.buffer).setUint32(0, serialized.byteLength, true);
  framed.set(serialized, 4);
  return framed;
}

/** A frame announced longer than its reader takes. */
export class FrameTooLarge extends Error {
  constructor(readonly length: number, readonly limit: number) {
    super(`realm: a frame of ${length} bytes, over the ${limit} a realm may send`);
  }
}

/**
 * The frames in a byte stream, as each completes; a partial one waits for its
 * rest. A frame is allocated once its length is in, and its bytes copied
 * into it as they come: a frame of megabytes (a wasm image) arrives in many
 * pieces, and a 4-byte header in up to four.
 */
export class FrameReader {
  private readonly header = new Uint8Array(4);
  private headerAt = 0;
  private frame: Uint8Array | null = null;
  private frameAt = 0;

  /** `limit`: the longest frame taken; a longer one throws {@link FrameTooLarge}, and nothing after it is read. */
  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}

  /** The frames `chunk` completes, each still serialized. */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (let at = 0; at < chunk.byteLength || (this.frame !== null && this.frameAt === this.frame.byteLength);) {
      if (this.frame === null) {
        const used = Math.min(4 - this.headerAt, chunk.byteLength - at);
        this.header.set(chunk.subarray(at, at + used), this.headerAt);
        this.headerAt += used;
        at += used;
        if (this.headerAt < 4) break;
        this.headerAt = 0;
        const length = new DataView(this.header.buffer).getUint32(0, true);
        if (length > this.limit) throw new FrameTooLarge(length, this.limit);
        this.frame = new Uint8Array(length);
        this.frameAt = 0;
      }
      const used = Math.min(this.frame.byteLength - this.frameAt, chunk.byteLength - at);
      this.frame.set(chunk.subarray(at, at + used), this.frameAt);
      this.frameAt += used;
      at += used;
      if (this.frameAt < this.frame.byteLength) break;
      frames.push(this.frame);
      this.frame = null;
    }
    return frames;
  }
}

// ── Errors, either way across ─────────────────────────────────────────────────

/** An error as data: its class name, message and own primitive properties (code, syscall, path, errno, dest, detail). */
export function realmError(error: unknown): RealmError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error), properties: {} };
  const properties: Record<string, string | number | boolean | null> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'message' || key === 'stack') continue;
    const value = Reflect.get(error, key);
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') properties[key] = value;
  }
  return { name: error.name, message: error.message, properties };
}

/**
 * The error `error` was: a VfsError as a VfsError (node-compat's fs tells a
 * filesystem refusal by its class, as `rm(..., { force: true })` of a missing
 * path does), a standard class as itself, else an Error bearing its name; with
 * its message and own properties.
 */
export function fromRealmError(error: RealmError): Error {
  const text = (key: string): string | undefined => {
    const value = error.properties[key];
    return typeof value === 'string' ? value : undefined;
  };
  const code = error.properties.code;
  let rebuilt: Error;
  if (error.name === 'VfsError' && isVfsErrorCode(code)) {
    rebuilt = new VfsError(code, '', text('path'), { syscall: text('syscall'), dest: text('dest'), detail: text('detail') });
  } else {
    const Standard = error.name === 'TypeError' ? TypeError : error.name === 'RangeError' ? RangeError : error.name === 'SyntaxError' ? SyntaxError : Error;
    rebuilt = new Standard(error.message);
    if (rebuilt.name !== error.name) Object.defineProperty(rebuilt, 'name', { value: error.name, configurable: true, writable: true });
  }
  Object.defineProperty(rebuilt, 'message', { value: error.message, configurable: true, writable: true });
  for (const [key, value] of Object.entries(error.properties)) {
    if (key === 'name' || Object.hasOwn(rebuilt, key)) continue;
    Object.defineProperty(rebuilt, key, { value, configurable: true, enumerable: true, writable: true });
  }
  return rebuilt;
}

/**
 * What `perform` came to, as an outcome the guest can be sent: its value, or
 * the error it raised; an error, too, for a value that cannot cross. Never
 * rejects.
 */
export async function realmOutcome(perform: () => unknown): Promise<RealmOutcome> {
  try {
    const value = await perform();
    // Proven to cross before it is posted: a value that cannot is an error.
    structuredClone(value);
    return { value };
  } catch (error) {
    return { error: realmError(error) };
  }
}

// ── The host's side ───────────────────────────────────────────────────────────

export interface RealmOptions {
  /** The guest module the realm runs (it calls realm-guest.ts's joinRealm). */
  readonly entry: URL;
  /** A worker thread of this process (the default), or a process of its own, ended by SIGKILL. */
  readonly isolation?: 'thread' | 'process';
  /** What the guest starts with: cloned to it with its ports. */
  readonly payload: unknown;
  /** Answers one call the guest makes: its value, or what it throws. Never called after the realm ended. */
  serve(request: unknown): unknown;
  /** Each event the guest posts, as it arrived; the user narrows it. Those it posted before it ended are delivered too. */
  onEvent(event: unknown): void;
}

/** How a realm ended. */
export interface RealmEnd {
  /** The worker's or the process's exit code (a process ended by a signal: 128 + its number). */
  readonly code: number;
  /** The error that ended it, if one did. */
  readonly failure: Error | null;
  /** Whether {@link Realm.terminate} ended it. */
  readonly terminated: boolean;
}

export interface Realm {
  /** Posts `event` to the guest; false when it cannot be (it cannot cross, or the realm has ended). */
  post(event: unknown): boolean;
  /** Ends the realm now, even in a loop that never yields. Idempotent. */
  terminate(): void;
  /** Whether the realm (its worker or process, and its channels) keeps the host's process alive: it does by default. */
  hold(on: boolean): void;
  /** Settles once the realm has ended and every event it posted was delivered. */
  readonly ended: Promise<RealmEnd>;
}

/**
 * Starts a realm running `options.entry`, or answers why this host has none:
 * one without node:worker_threads or node:child_process (workerd, which loads
 * this module in the hosted session, has isolates of its own). A process
 * that cannot be started is a realm that ends at once, with the reason.
 */
export async function startRealm(options: RealmOptions): Promise<Realm | { readonly unavailable: string }> {
  // A call is served, and answered on its kind's channel, until the realm ends.
  let link: RealmLink | null = null;
  const onCall = (call: RealmCall) => {
    void realmOutcome(() => options.serve(call.request)).then((outcome) => link?.answer(call, outcome));
  };
  const started = options.isolation === 'process'
    ? await startProcessLink(options, onCall)
    : await startThreadLink(options, onCall);
  if ('unavailable' in started) return started;
  link = started;
  return realmOver(started);
}

// ── One realm's lifecycle, either transport ───────────────────────────────────

/**
 * How long, after its guest has exited or been killed, a realm waits for what
 * the guest sent before that to arrive (a program's last output, as a pipe
 * delivers a killed process's). A process guest's pipe closes at once, unless
 * a process it started left its group holding it open: its end does not wait
 * on that one longer than this.
 */
const DRAIN_MS = 1_000;

/** What a transport is: its channels, its end, and how it is ended. */
interface RealmLink {
  /** Sends an answer to `call` on the channel its kind is read from. */
  answer(call: RealmCall, outcome: RealmOutcome): void;
  post(event: unknown): boolean;
  /** Ends the guest now. */
  kill(): void;
  hold(on: boolean): void;
  /** Settles when the guest has exited (or never started), with its code and the failure that ended it. */
  readonly exited: Promise<{ readonly code: number; readonly failure: Error | null }>;
  /** Settles once everything the guest sent has been delivered. */
  readonly drained: Promise<void>;
  /** Closes the channels, and ends whatever of the guest is left. Idempotent. */
  close(): void;
}

/** The realm a link is: answers and events while it lives, then one end, the same for both transports. */
function realmOver(link: RealmLink): Realm {
  let over = false;
  let terminated = false;
  const ended = link.exited.then(async ({ code, failure }): Promise<RealmEnd> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([link.drained, new Promise<void>((resolve) => { timer = setTimeout(resolve, DRAIN_MS); })]);
    if (timer !== null) clearTimeout(timer);
    over = true;
    link.close();
    return { code, failure, terminated };
  });
  return {
    post: (event) => !over && link.post(event),
    terminate() {
      if (over || terminated) return;
      terminated = true;
      link.kill();
    },
    hold: (on) => link.hold(on),
    ended,
  };
}

// ── A thread ──────────────────────────────────────────────────────────────────

async function startThreadLink(options: RealmOptions, onCall: (call: RealmCall) => void): Promise<RealmLink | { readonly unavailable: string }> {
  let threads: typeof WorkerThreads;
  try {
    // Imported when a realm starts, not with the module: a platform module
    // workerd, which loads this module in the hosted session, does not have.
    threads = await import('node:worker_threads');
  } catch {
    return { unavailable: 'this host has no worker threads (Bun and Node have them)' };
  }
  const calls = new threads.MessageChannel();
  const events = new threads.MessageChannel();
  const wake = new SharedArrayBuffer(4);
  const flag = new Int32Array(wake);
  // Nothing of the host's environment: a worker's is a copy of it otherwise.
  const worker = new threads.Worker(options.entry, { env: {} });
  const start: RealmStart = { payload: options.payload, calls: calls.port2, events: events.port2, wake };
  worker.postMessage(start, [calls.port2, events.port2]);
  calls.port1.on('message', (call) => { if (isRealmCall(call)) onCall(call); });
  events.port1.on('message', (event) => options.onEvent(event));

  let failure: Error | null = null;
  worker.on('error', (error: Error) => { failure = error; });
  const exited = new Promise<{ code: number; failure: Error | null }>((resolve) => {
    worker.once('exit', (code) => resolve({ code, failure }));
  });
  let closed = false;
  return {
    answer(call, outcome) {
      if (closed) return;
      try {
        calls.port1.postMessage({ id: call.id, ...outcome });
      } catch (error) {
        try { calls.port1.postMessage({ id: call.id, error: realmError(error) }); } catch { /* the port is gone */ }
      }
      // A guest waiting on any call takes this answer, and its own when it comes.
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    },
    post(event) {
      try {
        events.port1.postMessage(event);
        return true;
      } catch {
        return false;
      }
    },
    kill: () => { void worker.terminate().catch(() => {}); },
    hold(on) {
      for (const handle of [worker, calls.port1, events.port1]) {
        if (on) handle.ref();
        else handle.unref();
      }
    },
    exited,
    // What the guest posted before it ended, its last output and its exit code
    // among it, may still be queued: the worker's exit does not wait for it.
    drained: exited.then(() => {
      for (let left = threads.receiveMessageOnPort(events.port1); left; left = threads.receiveMessageOnPort(events.port1)) {
        options.onEvent(left.message);
      }
    }),
    close() {
      if (closed) return;
      closed = true;
      calls.port1.close();
      events.port1.close();
    },
  };
}

// ── A process ─────────────────────────────────────────────────────────────────

/**
 * The engine's arguments before the guest's module: under Bun, no .env file
 * and no config (so no preload) from where the guest runs; Node loads
 * neither unless told to, and its own options come from the environment the
 * guest is not given.
 */
function engineArguments(): string[] {
  return Reflect.get(globalThis, 'Bun') === undefined ? [] : ['--no-env-file', '--config=/dev/null'];
}

async function startProcessLink(options: RealmOptions, onCall: (call: RealmCall) => void): Promise<RealmLink | { readonly unavailable: string }> {
  let children: typeof ChildProcesses;
  let v8: typeof V8;
  let host: typeof HostProcess;
  try {
    // Imported when a realm starts, not with the module: platform modules
    // workerd, which loads this module in the hosted session, does not have.
    [children, v8, { default: host }] = await Promise.all([import('node:child_process'), import('node:v8'), import('node:process')]);
  } catch {
    return { unavailable: 'this host cannot start a process (Bun and Node can)' };
  }
  const entry = decodeURIComponent(options.entry.pathname);
  // The same engine runs the guest, in a process group of its own, with no
  // environment, where its module is; told this process's pid, which it ends
  // itself without.
  const child = children.spawn(host.execPath, [...engineArguments(), entry, String(host.pid)], {
    cwd: entry.slice(0, entry.lastIndexOf('/')) || '/',
    env: {},
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'pipe', 'pipe'] as const,
  });
  // None when the process could not be started (under Bun; Node gives pipes to nothing).
  const [, , , waited, events, fromGuest, answers] = child.stdio;
  const pipes = [waited, events, fromGuest, answers].filter((pipe) => pipe !== null);
  // A pipe whose other end is gone (the guest ended, or never started) is what ending is.
  for (const pipe of pipes) pipe.on('error', () => {});
  let closed = false;
  const send = (pipe: ChildProcesses.Writable | null, message: unknown): boolean => {
    if (closed || pipe === null) return false;
    try {
      pipe.write(encodeFrame(v8.serialize(message)));
      return true;
    } catch {
      return false;
    }
  };
  // The first frame on the events pipe is what the guest starts with.
  send(events, { payload: options.payload });

  let failure: Error | null = null;
  let exit: (end: { code: number; failure: Error | null }) => void = () => {};
  const exited = new Promise<{ code: number; failure: Error | null }>((resolve) => { exit = resolve; });
  // The guest's process group: everything it started that stayed in it.
  const killGroup = () => {
    if (child.pid === undefined) return;
    try { host.kill(-child.pid, 'SIGKILL'); } catch { /* none of it is left */ }
  };
  const frames = new FrameReader(MAX_FRAME_BYTES);
  fromGuest?.on('data', (chunk) => {
    let complete: Uint8Array[];
    try {
      complete = frames.push(chunk);
    } catch (error) {
      // Too large to take: the realm ends here, and nothing more of it is read.
      failure = error instanceof Error ? error : new Error(String(error));
      fromGuest?.destroy();
      killGroup();
      return;
    }
    for (const serialized of complete) {
      let message: unknown;
      try { message = v8.deserialize(serialized); } catch { continue; }
      if (!isGuestFrame(message)) continue;
      if (message.kind === 'event') options.onEvent(message.event);
      else onCall({ id: message.id, request: message.request, wait: message.wait });
    }
  });
  child.on('error', (error: Error) => {
    failure = error;
    // Never started (the engine is gone, too many processes): no exit will come.
    if (child.pid === undefined) exit({ code: 127, failure });
  });
  // Ended by a signal: 128 + its number, as a shell reports it (signals.ts);
  // one the table does not know counts as 0.
  child.once('exit', (code, signal) => exit({ code: code ?? exitCodeForSignal(parseSignalName(signal ?? '') ?? '0'), failure }));
  const drained = fromGuest === null ? Promise.resolve()
    : new Promise<void>((resolve) => { fromGuest.once('close', () => resolve()); });
  return {
    answer: (call, outcome) => {
      if (!send(call.wait ? waited : answers, { id: call.id, ...outcome })) {
        send(call.wait ? waited : answers, { id: call.id, error: realmError(new Error('the answer cannot cross to the realm')) });
      }
    },
    post: (event) => send(events, event),
    kill: killGroup,
    hold(on) {
      for (const handle of [child, ...pipes]) {
        if (on) handle.ref?.();
        else handle.unref?.();
      }
    },
    exited,
    drained,
    close() {
      if (closed) return;
      closed = true;
      for (const pipe of pipes) pipe.destroy();
      // Whatever the guest started that is still in its group ends with it.
      killGroup();
    },
  };
}
