/**
 * realm.ts — a program's realm of its own: a worker thread, and what crosses.
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
 *   - calls, guest to host, on `calls`: each names its id, and the host
 *     answers it there, value or error, then sets `wake` and notifies it. The
 *     guest may wait for an answer synchronously (Atomics.wait on `wake`, the
 *     answer taken with receiveMessageOnPort), which holds its thread as a
 *     blocking syscall holds a process, or asynchronously. Only answers travel
 *     guest-bound on `calls`, so nothing else can be taken for one;
 *   - events, either way, on `events`: whatever the realm's user says they
 *     are, each narrowed where it arrives.
 *
 * The guest is untrusted (the program shares its realm), so the ports reach
 * it by its first message, never through `workerData` a program can import,
 * and nothing it sends, no answer that cannot cross and no failed call ends
 * the host.
 *
 * Bun and Node both carry node:worker_threads, SharedArrayBuffer and
 * Atomics.wait in workers; workerd does not, and has isolates of its own.
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
/** A call the guest makes. */
export interface RealmCall {
    readonly id: number;
    readonly request: unknown;
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
    /** The guest module the worker runs (it calls realm-guest.ts's joinRealm). */
    readonly entry: URL;
    /** What the guest starts with: cloned to it with its ports. */
    readonly payload: unknown;
    /** Answers one call the guest makes: its value, or what it throws. Never called after the realm ended. */
    serve(request: unknown): unknown;
    /** Each event the guest posts, as it arrived; the user narrows it. Those it posted before it ended are delivered too. */
    onEvent(event: unknown): void;
}
/** How a realm ended. */
export interface RealmEnd {
    /** The worker's exit code. */
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
    /** Whether the realm (its worker and its ports) keeps the host's process alive: it does by default. */
    hold(on: boolean): void;
    /** Settles once the worker has ended and every event it posted was delivered. */
    readonly ended: Promise<RealmEnd>;
}
/**
 * Starts a realm running `options.entry`, or answers why this host has none:
 * one without node:worker_threads (workerd, which loads this module in the
 * hosted session, has isolates of its own).
 */
export declare function startRealm(options: RealmOptions): Promise<Realm | {
    readonly unavailable: string;
}>;
//# sourceMappingURL=realm.d.ts.map