/**
 * realm-guest.ts — the guest's side of a realm (realm.ts), inside its worker
 * thread or its process.
 *
 * What the host started the realm with is taken before anything of the
 * program's runs, and the channels live only in the closure this answers,
 * never in `workerData` a program can import.
 *
 * Both transports share one way of calling the host ({@link joinedRealm}):
 * a call names its id and whether it waits; answers go to the call that
 * waits for each, through one router, whichever channel brought them. Only
 * {@link JoinedRealm.call} holds the guest's thread; an asynchronous call
 * never does, so a guest can make a second call while its first is waiting
 * on it.
 */

import { createReadStream, readSync, writeSync } from 'node:fs';
import realmProcess from 'node:process';
import { deserialize, serialize } from 'node:v8';
import { parentPort, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import {
  encodeFrame, FrameReader, fromRealmError, isRealmAnswer, isRealmStart, REALM_FDS,
  type GuestFrame, type RealmAnswer, type RealmCall,
} from './realm.js';

/** Where the host's events arrive. */
export interface RealmEvents {
  on(event: 'message', listener: (value: unknown) => void): unknown;
}

export interface JoinedRealm {
  /** What the host started the realm with. */
  readonly payload: unknown;
  /** Calls the host and waits for its answer, holding this thread as a blocking syscall holds a process. */
  call(request: unknown): unknown;
  /** Calls the host; settles with its answer. Never holds this thread. */
  callAsync(request: unknown): Promise<unknown>;
  /** Posts an event to the host. */
  post(event: unknown): void;
  readonly events: RealmEvents;
  /**
   * Whether waiting for the host's events keeps the realm alive, as it does
   * by default. A process realm lives until its host ends it, whatever this
   * says.
   */
  hold(on: boolean): void;
}

/** Joins the realm the host started this worker or process as. Throws in one no host started. */
export async function joinRealm(): Promise<JoinedRealm> {
  return parentPort ? joinThreadRealm(parentPort) : joinProcessRealm();
}

// ── Calls, either transport ──────────────────────────────────────────────────

/** Each answer, to the call it answers: one waiting asynchronously, or one a blocked call takes. */
class AnswerRouter {
  private readonly waiting = new Map<number, (answer: RealmAnswer) => void>();
  private readonly arrived = new Map<number, RealmAnswer>();

  deliver(message: unknown): void {
    if (!isRealmAnswer(message)) return;
    const settle = this.waiting.get(message.id);
    if (settle === undefined) {
      this.arrived.set(message.id, message);
      return;
    }
    this.waiting.delete(message.id);
    settle(message);
  }

  /** Whether `id`'s answer has arrived and waits to be taken. */
  has(id: number): boolean {
    return this.arrived.has(id);
  }

  /** The answer to `id`, once it has arrived, taken. */
  take(id: number): RealmAnswer | undefined {
    const answer = this.arrived.get(id);
    this.arrived.delete(id);
    return answer;
  }

  expect(id: number): Promise<RealmAnswer> {
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  get pending(): number {
    return this.waiting.size;
  }
}

/** What a transport gives {@link joinedRealm}: its channels. */
interface GuestLink {
  readonly payload: unknown;
  send(call: RealmCall): void;
  /** Holds this thread until `router` has `id`'s answer, delivering every answer that comes meanwhile. */
  block(id: number, router: AnswerRouter): void;
  /** Whether an asynchronous call is waiting: a thread's call channel holds its realm meanwhile. */
  awaiting(on: boolean): void;
  post(event: unknown): void;
  readonly events: RealmEvents;
  hold(on: boolean): void;
}

function valueOf(answer: RealmAnswer): unknown {
  if ('error' in answer) throw fromRealmError(answer.error);
  return answer.value;
}

/** The realm a transport joined: one router for its answers, the same calls for both. */
function joinedRealm(link: GuestLink, router: AnswerRouter): JoinedRealm {
  let ids = 0;
  return {
    payload: link.payload,
    call(request) {
      const id = ++ids;
      link.send({ id, request, wait: true });
      link.block(id, router);
      const answer = router.take(id);
      if (answer === undefined) throw new Error('realm: the host answered no call');
      return valueOf(answer);
    },
    async callAsync(request) {
      const id = ++ids;
      const answered = router.expect(id);
      link.awaiting(true);
      link.send({ id, request, wait: false });
      try {
        return valueOf(await answered);
      } finally {
        if (router.pending === 0) link.awaiting(false);
      }
    },
    post: (event) => link.post(event),
    events: link.events,
    hold: (on) => link.hold(on),
  };
}

// ── A thread ─────────────────────────────────────────────────────────────────

/**
 * The host's first message: taken at once when it is already there, else
 * awaited. The worker can start before the host has posted it (a host
 * descheduled between starting the worker and posting). The listener goes
 * with it, so a program finds parentPort as it would in a worker of its own.
 */
async function firstMessage(port: MessagePort): Promise<unknown> {
  const ready = receiveMessageOnPort(port);
  if (ready) return ready.message;
  return new Promise((resolve) => {
    const take = (message: unknown) => {
      port.off('message', take);
      port.unref();
      resolve(message);
    };
    port.on('message', take);
  });
}

async function joinThreadRealm(parent: MessagePort): Promise<JoinedRealm> {
  const start = await firstMessage(parent);
  if (!isRealmStart(start)) throw new Error('realm: started without a realm');
  const { calls, events } = start;
  const flag = new Int32Array(start.wake);
  const router = new AnswerRouter();
  // Answers to asynchronous calls arrive while the event loop runs; held only while one waits.
  calls.on('message', (message) => router.deliver(message));
  calls.unref();
  return joinedRealm({
    payload: start.payload,
    send: (call) => calls.postMessage(call),
    block(id) {
      for (;;) {
        // Cleared, then every answer already there taken, then waited for: an
        // answer posted after the take sets the flag after it was cleared, so
        // the wait returns at once.
        Atomics.store(flag, 0, 0);
        for (let next = receiveMessageOnPort(calls); next; next = receiveMessageOnPort(calls)) router.deliver(next.message);
        if (router.has(id)) return;
        Atomics.wait(flag, 0, 0);
      }
    },
    awaiting(on) {
      if (on) calls.ref();
      else calls.unref();
    },
    post: (event) => events.postMessage(event),
    events,
    hold(on) {
      if (on) events.ref();
      else events.unref();
    },
  }, router);
}

// ── A process ────────────────────────────────────────────────────────────────

/** `length` bytes of `fd`, read synchronously; the host gone is an error. */
function readExactly(fd: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length;) {
    const read = readSync(fd, bytes, at, length - at, null);
    if (read === 0) throw new Error('realm: the host is gone');
    at += read;
  }
  return bytes;
}

/** The next frame on `fd`, read synchronously, deserialized. */
function readFrame(fd: number): unknown {
  const length = new DataView(readExactly(fd, 4).buffer).getUint32(0, true);
  return deserialize(readExactly(fd, length));
}

/** Each frame of `fd` as it comes, deserialized, to `listener`. */
function readFrames(fd: number, listener: (message: unknown) => void): void {
  const frames = new FrameReader();
  createReadStream('', { fd }).on('data', (chunk) => {
    for (const serialized of frames.push(chunk)) listener(deserialize(serialized));
  });
}

/**
 * A guest whose host is gone ends, with everything in its process group,
 * even while its own thread spins: a thread of its own compares its parent
 * with the host's pid, which the host gave it as its argument (a parent read
 * when the watch starts would already be the reaper's if the host died
 * first), at once and twice a second. It says when it has looked once; the
 * guest waits for that before it takes anything from the host.
 */
async function watchHost(hostPid: number): Promise<void> {
  const watch = new Worker(`const { parentPort } = require('node:worker_threads');
const check = () => { if (process.ppid !== ${hostPid}) process.kill(-process.pid, 'SIGKILL'); };
check();
parentPort.postMessage('watching');
setInterval(check, 500);`, { eval: true });
  watch.unref();
  await new Promise<void>((resolve) => watch.once('message', () => resolve()));
}

async function joinProcessRealm(): Promise<JoinedRealm> {
  const hostPid = Number(realmProcess.argv[realmProcess.argv.length - 1]);
  if (!Number.isSafeInteger(hostPid) || hostPid <= 1) throw new Error('realm: started without a realm');
  await watchHost(hostPid);
  let start: unknown;
  try {
    start = readFrame(REALM_FDS.events);
  } catch {
    throw new Error('realm: started without a realm');
  }
  if (typeof start !== 'object' || start === null || !('payload' in start)) throw new Error('realm: started without a realm');
  const router = new AnswerRouter();
  // The answers not waited for, as they come; those waited for are read only by the call that waits.
  readFrames(REALM_FDS.answers, (message) => router.deliver(message));
  const listeners: ((value: unknown) => void)[] = [];
  readFrames(REALM_FDS.events, (event) => { for (const listener of listeners) listener(event); });
  const send = (frame: GuestFrame) => {
    const bytes = encodeFrame(serialize(frame));
    for (let at = 0; at < bytes.byteLength;) at += writeSync(REALM_FDS.toHost, bytes, at, bytes.byteLength - at);
  };
  return joinedRealm({
    payload: start.payload,
    send: (call) => send({ kind: 'call', ...call }),
    block(id) {
      // Only answers to waited calls come on this pipe, and only one call waits at a time.
      while (!router.has(id)) router.deliver(readFrame(REALM_FDS.waited));
    },
    awaiting: () => {},
    post: (event) => send({ kind: 'event', event }),
    events: {
      on(_event, listener) {
        listeners.push(listener);
        return this;
      },
    },
    hold: () => {},
  }, router);
}
