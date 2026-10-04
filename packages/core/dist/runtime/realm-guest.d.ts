/**
 * realm-guest.ts — the guest's side of a realm (realm.ts), inside its worker.
 *
 * The host's first message carries what the guest started with and its
 * ports; it is taken before anything of the program's runs and the ports live
 * only in the closure this answers, never in `workerData` a program can
 * import.
 */
import type { MessagePort } from 'node:worker_threads';
export interface JoinedRealm {
    /** What the host started the realm with. */
    readonly payload: unknown;
    /** Calls the host and waits for its answer, holding this thread as a blocking syscall holds a process. */
    call(request: unknown): unknown;
    /** Calls the host; settles with its answer. */
    callAsync(request: unknown): Promise<unknown>;
    /** Posts an event to the host. */
    post(event: unknown): void;
    /** Where the host's events arrive. Held by default: the realm lives while it is. */
    readonly events: MessagePort;
}
/** Joins the realm the host started this worker as. Throws in a worker no host started. */
export declare function joinRealm(): Promise<JoinedRealm>;
//# sourceMappingURL=realm-guest.d.ts.map