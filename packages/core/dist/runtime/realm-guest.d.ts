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
export declare function joinRealm(): Promise<JoinedRealm>;
//# sourceMappingURL=realm-guest.d.ts.map