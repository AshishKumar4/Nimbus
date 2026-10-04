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
import type { MessagePort } from 'node:worker_threads';
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
export type RealmOutcome = {
    readonly value: unknown;
} | {
    readonly error: RealmError;
};
/** A call's answer, as the guest receives it. */
export type RealmAnswer = RealmOutcome & {
    readonly id: number;
};
export interface RealmError {
    readonly name: string;
    readonly message: string;
    readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}
export declare function isRealmStart(value: unknown): value is RealmStart;
export declare function isRealmCall(value: unknown): value is RealmCall;
export declare function isRealmAnswer(value: unknown): value is RealmAnswer;
/**
 * The pipes of a process realm, by the guest's file descriptor: the answers
 * it waits for (read only synchronously), the host's events, what the guest
 * sends (its calls and events), and the answers it does not wait for.
 */
export declare const REALM_FDS: {
    readonly waited: 3;
    readonly events: 4;
    readonly toHost: 5;
    readonly answers: 6;
};
/**
 * The largest frame a process guest may send: the largest single value it
 * has reason to (a write, an answer), with room. It bounds one frame, not a
 * realm's memory: a frame is allocated once its length is known, a longer one
 * ends the realm before a byte of it is kept, and decoding a full frame can
 * cost a few times its size while the next arrives. A process guest shares
 * the host machine with the host, so it is not a memory boundary either.
 */
export declare const MAX_FRAME_BYTES: number;
/** What a process realm's guest sends: a call, or an event. */
export type GuestFrame = ({
    readonly kind: 'call';
} & RealmCall) | {
    readonly kind: 'event';
    readonly event: unknown;
};
export declare function isGuestFrame(value: unknown): value is GuestFrame;
/** A serialized message as a frame: its length (u32, little-endian), then the bytes. */
export declare function encodeFrame(serialized: Uint8Array): Uint8Array;
/** A frame announced longer than its reader takes. */
export declare class FrameTooLarge extends Error {
    readonly length: number;
    readonly limit: number;
    constructor(length: number, limit: number);
}
/**
 * The frames in a byte stream, as each completes; a partial one waits for its
 * rest. A frame is allocated once its length is in, and its bytes copied
 * into it as they come: a frame of megabytes (a wasm image) arrives in many
 * pieces, and a 4-byte header in up to four.
 */
export declare class FrameReader {
    private readonly limit;
    private readonly header;
    private headerAt;
    private frame;
    private frameAt;
    /** `limit`: the longest frame taken; a longer one throws {@link FrameTooLarge}, and nothing after it is read. */
    constructor(limit?: number);
    /** The frames `chunk` completes, each still serialized. */
    push(chunk: Uint8Array): Uint8Array[];
}
/** An error as data: its class name, message and own primitive properties (code, syscall, path, errno, dest, detail). */
export declare function realmError(error: unknown): RealmError;
/**
 * The error `error` was: a VfsError as a VfsError (node-compat's fs tells a
 * filesystem refusal by its class, as `rm(..., { force: true })` of a missing
 * path does), a standard class as itself, else an Error bearing its name; with
 * its message and own properties.
 */
export declare function fromRealmError(error: RealmError): Error;
/**
 * What `perform` came to, as an outcome the guest can be sent: its value, or
 * the error it raised; an error, too, for a value that cannot cross. Never
 * rejects.
 */
export declare function realmOutcome(perform: () => unknown): Promise<RealmOutcome>;
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
export declare function startRealm(options: RealmOptions): Promise<Realm | {
    readonly unavailable: string;
}>;
//# sourceMappingURL=realm.d.ts.map