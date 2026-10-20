/**
 * Warm facets: workers a runtime keeps between its processes, so a process
 * does not pay a cold isolate (its image loaded and compiled again).
 *
 * A warm facet belongs to one session. Its key is made from the session and
 * the runtime, and nothing else names one: a worker kept warm in a session
 * never serves another session's process, which would hand one user's
 * worker to another. One process runs on a key at a time, so two processes
 * never share a worker's memory or its limit; a key given back only after a
 * call that ended clean, and never one a call left in doubt, is how a crash
 * stays with the process that had it.
 */
/** A warm facet's key: one session's, one runtime's (FacetSpec.warm). */
export interface WarmFacetKey {
    readonly session: string;
    readonly name: string;
}
/**
 * How a call on a warm facet ended, as its next process cares: the facet's
 * own word that another process may run there (`reusable`, its WASI host's
 * __wasiReusable and the runtime's own rules), the call's error, and
 * whether its process was killed (the loader may still be running it).
 */
export interface WarmCallEnd {
    readonly reusable?: boolean;
    readonly error?: string;
    readonly killed: boolean;
}
/** A runtime's warm facet keys in one session. */
export interface WarmFacetKeys {
    /** An idle key, or a new one: the caller runs one process on it. */
    take(): WarmFacetKey;
    /**
     * `key` back among the idle ones when every call made on it (`ends`)
     * left it fit for another process: the facet said so, the call ended
     * without error, and its process was not killed. A key not given back is
     * never used again, nor one past `kept` idle.
     */
    give(key: WarmFacetKey, ...ends: readonly WarmCallEnd[]): void;
}
/**
 * The warm facet keys `runtime` uses in `session`, at most `kept` idle. A
 * key is never named twice, nor by another incarnation of the session: a
 * facet one left running is not this one's to enter.
 */
export declare function warmFacetKeys(session: string, runtime: string, kept: number): WarmFacetKeys;
/**
 * The scope a host keys a warm facet's worker by: the session first, so no
 * other session's key can name it. A key that names no session is refused
 * here, where every host reads one, however the key was made.
 */
export declare function warmFacetScope(key: WarmFacetKey): string;
//# sourceMappingURL=warm-facets.d.ts.map