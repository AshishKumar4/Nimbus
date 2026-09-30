/**
 * launch-learning-store.ts — what the runs of a command learned for its next
 * launch, kept in the session's storage.
 *
 * A launch carries a module map and a set of staged files, fixed when it
 * starts. What a run needed and did not have is reported (commonjs-cell.ts,
 * RUNTIME CODE; the residency ledger in node-shims.ts) and learned here, per
 * bundle key (cred, cwd, script and entry code), in three typed parts:
 *
 *   executedModules  files the program tried to execute that the module map
 *                    lacked. The next launch's module map is built with them
 *                    as roots of the required graph, their imports included.
 *   dataReads        files the program read synchronously and did not have.
 *                    The next launch stages them as files, never as code: a
 *                    `.js` file a tool scans (Tailwind's content globs) is
 *                    not a module, and rooting it pulled its imports into the
 *                    required graph until the launch exceeded its bound.
 *   codeKeys         runtime code (commonjs-cell.ts, RUNTIME CODE) the runs
 *                    produced and could not compile.
 *
 * It lives in the session's Durable Object storage, whose key-value API is
 * stored in the object's SQLite database, because a session is evicted
 * whenever it sits idle between two commands, and a relaunch after a pause
 * must still know what the evicted isolate learned:
 *
 *   runtime-code-index           [key, charge, chunks][], least recently recorded first
 *   runtime-code:<key>:<n>       a code entry as JSON, in chunks
 *   launch-profiles              bundle keys with a profile, least recently recorded first
 *   launch-profile:<bundleKey>   { executedModules, dataReads, codeKeys }
 *
 * A key and its value may not exceed 2 MB together
 * (https://developers.cloudflare.com/durable-objects/platform/limits/), so a
 * code entry is written in chunks of CHUNK_CHARS UTF-16 units, at most 1 MiB
 * each however they serialize.
 *
 * Bounded by what it costs: code entries by RUNTIME_CODE_MAX_ENTRIES and
 * RUNTIME_CODE_MAX_BYTES of charge (runtimeCodeCharge), the least recently
 * recorded leaving first, and a code key that leaves leaves every profile;
 * profiles by one LRU index of `maxProfiles` bundle keys, each holding at
 * most `maxPaths` paths per part. Only indexed bundle keys are held in
 * memory, so asking about a command that never reported costs nothing that
 * stays. Each operation runs after the one before it, so a launch built
 * after a report is built with it.
 */
import { type RuntimeCodeEntry } from '@nimbus-sh/core/_shared/commonjs-cell.js';
/** The part of Durable Object storage the store reads and writes. */
export interface LaunchLearningStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
}
/** What one run reported, as the guest sent it; validated here. */
export interface LaunchReport {
    code?: readonly unknown[];
    executedModules?: readonly unknown[];
    dataReads?: readonly unknown[];
}
/** What the next launch of a bundle key carries. */
export interface LaunchLearning {
    /** Runtime code by key. */
    code: Map<string, RuntimeCodeEntry>;
    executedModules: string[];
    dataReads: string[];
}
/** Bundle keys with a profile. */
export declare const LAUNCH_PROFILE_MAX_ENTRIES = 16;
/**
 * Paths per part of one profile. A program that reads a directory of data
 * files misses once per file, so the cap has to clear a real working set.
 * Past it the profile stops growing and the surplus stays loud.
 */
export declare const LAUNCH_PROFILE_MAX_PATHS = 4096;
export declare class LaunchLearningStore {
    private readonly storage;
    private readonly maxProfiles;
    private readonly maxPaths;
    /** Code key → [charge, chunks], in recording order; null until read. */
    private index;
    private charged;
    /** Bundle keys with a profile, least recently recorded first; null until read. */
    private profileKeys;
    /** Profiles of indexed bundle keys only. */
    private readonly profiles;
    private readonly entries;
    private queue;
    constructor(storage: LaunchLearningStorage, maxProfiles?: number, maxPaths?: number);
    /**
     * Record what a run of `bundleKey` reported. Resolves true when the
     * profile gained anything, which is when that key's cached build is
     * stale. A code entry that does not parse, or is larger than the whole
     * store, is dropped, and so is a path that is not a non-empty string.
     */
    record(bundleKey: string, report: LaunchReport): Promise<boolean>;
    /** What a launch of `bundleKey` carries. */
    forLaunch(bundleKey: string): Promise<LaunchLearning>;
    /** Resolves once every operation already asked for has finished. */
    settled(): Promise<void>;
    /** The profiles this isolate holds, for diagnostics; storage may hold more. */
    cached(): Array<{
        key: string;
        executedModules: string[];
        dataReads: string[];
        codeKeys: string[];
    }>;
    private serial;
    private load;
    /** The profile of an indexed (or about to be indexed) bundle key. */
    private profile;
    private putProfile;
    private recordNow;
    private forLaunchNow;
}
//# sourceMappingURL=launch-learning-store.d.ts.map