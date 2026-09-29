/**
 * runtime-code-store.ts — the code node processes produced while they ran and
 * could not compile, kept for the next launch of the same command
 * (core/_shared/commonjs-cell.ts, RUNTIME CODE).
 *
 * It lives in the session's Durable Object storage, whose key-value API is
 * stored in the object's SQLite database, so a launch after the isolate was
 * evicted or hibernated still gets what an earlier run reported:
 *
 *   runtime-code-index                  [key, charge, chunks][], least recently recorded first
 *   runtime-code:<key>:<n>              the entry as JSON, in chunks
 *   runtime-code-profiles               bundle keys with a profile, least recently recorded first
 *   runtime-code-profile:<bundleKey>    the keys that bundle key's runs produced
 *
 * A key and its value may not exceed 2 MB together
 * (https://developers.cloudflare.com/durable-objects/platform/limits/), so an
 * entry is written in chunks of CHUNK_CHARS UTF-16 units, at most 1 MiB each
 * however they serialize.
 *
 * Bounded by what it costs, not only by text: at most RUNTIME_CODE_MAX_ENTRIES
 * entries and RUNTIME_CODE_MAX_BYTES of charge (runtimeCodeCharge: the text
 * plus a fixed per-entry overhead), the least recently recorded leaving
 * first; a report is read up to RUNTIME_CODE_MAX_ENTRIES entries and a
 * profile holds as many keys. A key that leaves the store leaves every
 * profile with it. The in-memory maps are a cache of the rows; each operation
 * runs after the one before it, so a launch built after a report is built
 * with it.
 */
import { type RuntimeCodeEntry } from '@nimbus-sh/core/_shared/commonjs-cell.js';
/** The part of Durable Object storage the store reads and writes. */
export interface RuntimeCodeStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
}
export declare class RuntimeCodeStore {
    private readonly storage;
    /** Key → [charge, chunks], in recording order; null until read. */
    private index;
    private charged;
    /** Bundle keys with a profile, in recording order; null until read. */
    private profileKeys;
    private readonly profiles;
    private readonly entries;
    private queue;
    constructor(storage: RuntimeCodeStorage);
    /**
     * Record what a run of `bundleKey` reported. Resolves true when the
     * profile gained a key, which is when that bundle key's cached build is
     * stale. A reported entry that does not parse, or is larger than the whole
     * store, is dropped.
     */
    record(bundleKey: string, reported: readonly unknown[]): Promise<boolean>;
    /** The code a launch of `bundleKey` carries, by key. */
    forLaunch(bundleKey: string): Promise<Map<string, RuntimeCodeEntry>>;
    /** Resolves once every operation already asked for has finished. */
    settled(): Promise<void>;
    private serial;
    private load;
    private profile;
    private recordNow;
    private forLaunchNow;
}
//# sourceMappingURL=runtime-code-store.d.ts.map