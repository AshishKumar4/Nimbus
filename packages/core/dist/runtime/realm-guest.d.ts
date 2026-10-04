/**
 * realm-guest.ts — the guest's side of a realm (realm.ts), inside its worker
 * thread or its process.
 *
 * What the host started the realm with is taken before anything of the
 * program's runs, and the channels live only in the closure this answers,
 * never in `workerData` a program can import.
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
    /** Calls the host; settles with its answer. */
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