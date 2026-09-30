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
import { parseRuntimeCodeEntry, RUNTIME_CODE_MAX_BYTES, RUNTIME_CODE_MAX_ENTRIES, runtimeCodeCharge, runtimeCodeKey, } from '@nimbus-sh/core/_shared/commonjs-cell.js';
const INDEX_KEY = 'runtime-code-index';
const ENTRY_PREFIX = 'runtime-code:';
const PROFILES_KEY = 'launch-profiles';
const PROFILE_PREFIX = 'launch-profile:';
const CHUNK_CHARS = 512 * 1024;
/**
 * The two stores this one replaced kept their profiles under these keys, each
 * index naming every profile row it kept. Deleted once, on first load; the
 * code entries (`runtime-code-index`, `runtime-code:*`) are this store's own.
 */
const LEGACY_PROFILE_INDEXES = [
    ['runtime-code-profiles', 'runtime-code-profile:'],
    ['residency-profile-index', 'residency-profile:'],
];
/** Bundle keys with a profile. */
export const LAUNCH_PROFILE_MAX_ENTRIES = 16;
/**
 * Paths per part of one profile. A program that reads a directory of data
 * files misses once per file, so the cap has to clear a real working set.
 * Past it the profile stops growing and the surplus stays loud.
 */
export const LAUNCH_PROFILE_MAX_PATHS = 4096;
export class LaunchLearningStore {
    storage;
    maxProfiles;
    maxPaths;
    /** Code key → [charge, chunks], in recording order; null until read. */
    index = null;
    charged = 0;
    /** Bundle keys with a profile, least recently recorded first; null until read. */
    profileKeys = null;
    /** Profiles of indexed bundle keys only. */
    profiles = new Map();
    entries = new Map();
    queue = Promise.resolve();
    constructor(storage, maxProfiles = LAUNCH_PROFILE_MAX_ENTRIES, maxPaths = LAUNCH_PROFILE_MAX_PATHS) {
        this.storage = storage;
        this.maxProfiles = maxProfiles;
        this.maxPaths = maxPaths;
    }
    /**
     * Record what a run of `bundleKey` reported. Resolves true when the
     * profile gained anything, which is when that key's cached build is
     * stale. A code entry that does not parse, or is larger than the whole
     * store, is dropped, and so is a path that is not a non-empty string.
     */
    record(bundleKey, report) {
        return this.serial(() => this.recordNow(bundleKey, report));
    }
    /** What a launch of `bundleKey` carries. */
    forLaunch(bundleKey) {
        return this.serial(() => this.forLaunchNow(bundleKey));
    }
    /** Resolves once every operation already asked for has finished. */
    settled() {
        return this.serial(async () => { });
    }
    /** The profiles this isolate holds, for diagnostics; storage may hold more. */
    cached() {
        return [...this.profiles].map(([key, p]) => ({
            key, executedModules: [...p.executedModules], dataReads: [...p.dataReads], codeKeys: [...p.codeKeys],
        }));
    }
    serial(operation) {
        const run = this.queue.then(operation);
        this.queue = run.catch(() => undefined);
        return run;
    }
    async load() {
        if (this.index !== null)
            return this.index;
        for (const [indexKey, prefix] of LEGACY_PROFILE_INDEXES) {
            const keys = await this.storage.get(indexKey);
            if (keys === undefined)
                continue;
            for (const key of keys)
                await this.storage.delete(prefix + key);
            await this.storage.delete(indexKey);
        }
        const rows = (await this.storage.get(INDEX_KEY)) ?? [];
        this.index = new Map(rows.map(([key, charge, chunks]) => [key, [charge, chunks]]));
        this.charged = rows.reduce((sum, [, charge]) => sum + charge, 0);
        this.profileKeys = (await this.storage.get(PROFILES_KEY)) ?? [];
        return this.index;
    }
    /** The profile of an indexed (or about to be indexed) bundle key. */
    async profile(bundleKey) {
        let profile = this.profiles.get(bundleKey);
        if (!profile) {
            const stored = (await this.storage.get(PROFILE_PREFIX + bundleKey)) ?? {};
            profile = {
                executedModules: new Set(stored.executedModules ?? []),
                dataReads: new Set(stored.dataReads ?? []),
                codeKeys: new Set(stored.codeKeys ?? []),
            };
            this.profiles.set(bundleKey, profile);
        }
        return profile;
    }
    putProfile(bundleKey, profile) {
        return this.storage.put(PROFILE_PREFIX + bundleKey, {
            executedModules: [...profile.executedModules],
            dataReads: [...profile.dataReads],
            codeKeys: [...profile.codeKeys],
        });
    }
    async recordNow(bundleKey, report) {
        const index = await this.load();
        const profile = await this.profile(bundleKey);
        let learned = false;
        let indexChanged = false;
        for (const raw of (report.code ?? []).slice(0, RUNTIME_CODE_MAX_ENTRIES)) {
            const entry = parseRuntimeCodeEntry(raw);
            if (entry === null)
                continue;
            const charge = runtimeCodeCharge(entry);
            if (charge > RUNTIME_CODE_MAX_BYTES)
                continue;
            const key = runtimeCodeKey(entry);
            const held = index.get(key);
            if (held) {
                index.delete(key);
                index.set(key, held);
            }
            else {
                const json = JSON.stringify(entry);
                const chunks = Math.max(1, Math.ceil(json.length / CHUNK_CHARS));
                for (let n = 0; n < chunks; n++) {
                    await this.storage.put(`${ENTRY_PREFIX}${key}:${n}`, json.slice(n * CHUNK_CHARS, (n + 1) * CHUNK_CHARS));
                }
                index.set(key, [charge, chunks]);
                this.charged += charge;
                this.entries.set(key, entry);
            }
            indexChanged = true;
            if (!profile.codeKeys.has(key) && profile.codeKeys.size < RUNTIME_CODE_MAX_ENTRIES) {
                profile.codeKeys.add(key);
                learned = true;
            }
        }
        for (const [paths, reported] of [
            [profile.executedModules, report.executedModules],
            [profile.dataReads, report.dataReads],
        ]) {
            for (const path of reported ?? []) {
                if (paths.size >= this.maxPaths)
                    break;
                if (typeof path !== 'string' || path === '' || paths.has(path))
                    continue;
                paths.add(path);
                learned = true;
            }
        }
        let changed = learned;
        for (const [oldest, [charge, chunks]] of index) {
            if (this.charged <= RUNTIME_CODE_MAX_BYTES && index.size <= RUNTIME_CODE_MAX_ENTRIES)
                break;
            for (let n = 0; n < chunks; n++)
                await this.storage.delete(`${ENTRY_PREFIX}${oldest}:${n}`);
            index.delete(oldest);
            this.entries.delete(oldest);
            this.charged -= charge;
            // Out of every profile held in memory; a profile row read later drops
            // it when it is read (forLaunchNow).
            for (const [other, held] of this.profiles) {
                if (other !== bundleKey && held.codeKeys.delete(oldest))
                    await this.putProfile(other, held);
            }
            if (profile.codeKeys.delete(oldest))
                changed = true;
        }
        const profileKeys = (this.profileKeys ?? []).filter((key) => key !== bundleKey);
        profileKeys.push(bundleKey);
        while (profileKeys.length > this.maxProfiles) {
            const oldest = profileKeys[0];
            profileKeys.shift();
            this.profiles.delete(oldest);
            await this.storage.delete(PROFILE_PREFIX + oldest);
        }
        this.profileKeys = profileKeys;
        if (indexChanged)
            await this.storage.put(INDEX_KEY, [...index].map(([key, [charge, chunks]]) => [key, charge, chunks]));
        await this.storage.put(PROFILES_KEY, profileKeys);
        if (changed)
            await this.putProfile(bundleKey, profile);
        return learned;
    }
    async forLaunchNow(bundleKey) {
        const index = await this.load();
        const code = new Map();
        if (!this.profileKeys?.includes(bundleKey))
            return { code, executedModules: [], dataReads: [] };
        const profile = await this.profile(bundleKey);
        let pruned = false;
        for (const key of [...profile.codeKeys]) {
            const held = index.get(key);
            let entry = held ? this.entries.get(key) ?? null : null;
            if (held && entry === null) {
                let json = '';
                for (let n = 0; n < held[1]; n++)
                    json += (await this.storage.get(`${ENTRY_PREFIX}${key}:${n}`)) ?? '';
                try {
                    entry = parseRuntimeCodeEntry(JSON.parse(json));
                }
                catch {
                    entry = null;
                }
                if (entry !== null)
                    this.entries.set(key, entry);
            }
            if (entry === null) {
                profile.codeKeys.delete(key);
                pruned = true;
                continue;
            }
            code.set(key, entry);
        }
        if (pruned)
            await this.putProfile(bundleKey, profile);
        return { code, executedModules: [...profile.executedModules], dataReads: [...profile.dataReads] };
    }
}
