/**
 * residency-profile-store.ts — what earlier runs of a build could not read,
 * kept in the session's storage.
 *
 * A resident process that reads a file synchronously that its launch did not
 * stage fails loudly, and its exit report names the path. The next launch of
 * the same build (same cred, cwd, script and entry code: the bundle key)
 * stages that path, and the loop closes. That only works if the next launch
 * still knows the path: a session Durable Object is evicted whenever it sits
 * idle (between two commands, while the user reads the failure), and an
 * in-memory profile died with the evicted isolate, so a relaunch after any
 * pause missed the same file again, forever. The store keeps each bundle
 * key's profile in storage, with the in-memory view as a cache.
 *
 * Bounded like the in-memory profile was: at most `maxEntries` bundle keys
 * (least recently recorded dropped first) and `maxPaths` paths per key.
 */
export interface ResidencyProfileStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
}
export declare class ResidencyProfileStore {
    private readonly storage;
    private readonly maxEntries;
    private readonly maxPaths;
    /** Bundle keys with a profile, least recently recorded first; null until read. */
    private keys;
    private readonly profiles;
    private queue;
    constructor(storage: ResidencyProfileStorage, maxEntries: number, maxPaths: number);
    /** The paths earlier runs of `bundleKey` missed, oldest first. */
    paths(bundleKey: string): Promise<string[]>;
    /**
     * Add what a run of `bundleKey` reported. Resolves true when the profile
     * gained a path, which is when that key's cached build is stale.
     */
    record(bundleKey: string, misses: readonly unknown[]): Promise<boolean>;
    /** What this isolate holds, for diagnostics; storage may hold more. */
    cached(): Array<{
        key: string;
        paths: string[];
    }>;
    private serial;
    private index;
    private profile;
}
//# sourceMappingURL=residency-profile-store.d.ts.map