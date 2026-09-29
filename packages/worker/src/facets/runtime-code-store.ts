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
import {
  parseRuntimeCodeEntry,
  RUNTIME_CODE_MAX_BYTES,
  RUNTIME_CODE_MAX_ENTRIES,
  runtimeCodeCharge,
  runtimeCodeKey,
  type RuntimeCodeEntry,
} from '@nimbus-sh/core/_shared/commonjs-cell.js';

/** The part of Durable Object storage the store reads and writes. */
export interface RuntimeCodeStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

type IndexRow = [key: string, charge: number, chunks: number];

const INDEX_KEY = 'runtime-code-index';
const PROFILES_KEY = 'runtime-code-profiles';
const ENTRY_PREFIX = 'runtime-code:';
const PROFILE_PREFIX = 'runtime-code-profile:';
const CHUNK_CHARS = 512 * 1024;
/** Bundle keys with a profile, as the residency profiles bound theirs. */
const PROFILE_MAX_ENTRIES = 16;

export class RuntimeCodeStore {
  /** Key → [charge, chunks], in recording order; null until read. */
  private index: Map<string, [number, number]> | null = null;
  private charged = 0;
  /** Bundle keys with a profile, in recording order; null until read. */
  private profileKeys: string[] | null = null;
  private readonly profiles = new Map<string, Set<string>>();
  private readonly entries = new Map<string, RuntimeCodeEntry>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: RuntimeCodeStorage) {}

  /**
   * Record what a run of `bundleKey` reported. Resolves true when the
   * profile gained a key, which is when that bundle key's cached build is
   * stale. A reported entry that does not parse, or is larger than the whole
   * store, is dropped.
   */
  record(bundleKey: string, reported: readonly unknown[]): Promise<boolean> {
    return this.serial(() => this.recordNow(bundleKey, reported));
  }

  /** The code a launch of `bundleKey` carries, by key. */
  forLaunch(bundleKey: string): Promise<Map<string, RuntimeCodeEntry>> {
    return this.serial(() => this.forLaunchNow(bundleKey));
  }

  /** Resolves once every operation already asked for has finished. */
  settled(): Promise<void> {
    return this.serial(async () => {});
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Map<string, [number, number]>> {
    if (this.index !== null) return this.index;
    const rows = (await this.storage.get<IndexRow[]>(INDEX_KEY)) ?? [];
    this.index = new Map(rows.map(([key, charge, chunks]) => [key, [charge, chunks]]));
    this.charged = rows.reduce((sum, [, charge]) => sum + charge, 0);
    this.profileKeys = (await this.storage.get<string[]>(PROFILES_KEY)) ?? [];
    return this.index;
  }

  private async profile(bundleKey: string): Promise<Set<string>> {
    let profile = this.profiles.get(bundleKey);
    if (!profile) {
      profile = new Set((await this.storage.get<string[]>(PROFILE_PREFIX + bundleKey)) ?? []);
      this.profiles.set(bundleKey, profile);
    }
    return profile;
  }

  private async recordNow(bundleKey: string, reported: readonly unknown[]): Promise<boolean> {
    const index = await this.load();
    const profile = await this.profile(bundleKey);
    let learned = false;
    for (const raw of reported.slice(0, RUNTIME_CODE_MAX_ENTRIES)) {
      const entry = parseRuntimeCodeEntry(raw);
      if (entry === null) continue;
      const charge = runtimeCodeCharge(entry);
      if (charge > RUNTIME_CODE_MAX_BYTES) continue;
      const key = runtimeCodeKey(entry);
      const held = index.get(key);
      if (held) {
        index.delete(key);
        index.set(key, held);
      } else {
        const json = JSON.stringify(entry);
        const chunks = Math.max(1, Math.ceil(json.length / CHUNK_CHARS));
        for (let n = 0; n < chunks; n++) {
          await this.storage.put(`${ENTRY_PREFIX}${key}:${n}`, json.slice(n * CHUNK_CHARS, (n + 1) * CHUNK_CHARS));
        }
        index.set(key, [charge, chunks]);
        this.charged += charge;
        this.entries.set(key, entry);
      }
      if (!profile.has(key) && profile.size < RUNTIME_CODE_MAX_ENTRIES) {
        profile.add(key);
        learned = true;
      }
    }
    for (const [oldest, [charge, chunks]] of index) {
      if (this.charged <= RUNTIME_CODE_MAX_BYTES && index.size <= RUNTIME_CODE_MAX_ENTRIES) break;
      for (let n = 0; n < chunks; n++) await this.storage.delete(`${ENTRY_PREFIX}${oldest}:${n}`);
      index.delete(oldest);
      this.entries.delete(oldest);
      this.charged -= charge;
      // Out of every profile held in memory; a profile row read later drops
      // it when it is read (forLaunchNow).
      for (const [other, keys] of this.profiles) {
        if (other !== bundleKey && keys.delete(oldest)) await this.storage.put(PROFILE_PREFIX + other, [...keys]);
      }
      profile.delete(oldest);
    }
    const profileKeys = (this.profileKeys ?? []).filter((key) => key !== bundleKey);
    profileKeys.push(bundleKey);
    while (profileKeys.length > PROFILE_MAX_ENTRIES) {
      const oldest = profileKeys.shift()!;
      this.profiles.delete(oldest);
      await this.storage.delete(PROFILE_PREFIX + oldest);
    }
    this.profileKeys = profileKeys;
    await this.storage.put(INDEX_KEY, [...index].map(([key, [charge, chunks]]): IndexRow => [key, charge, chunks]));
    await this.storage.put(PROFILES_KEY, profileKeys);
    await this.storage.put(PROFILE_PREFIX + bundleKey, [...profile]);
    return learned;
  }

  private async forLaunchNow(bundleKey: string): Promise<Map<string, RuntimeCodeEntry>> {
    const index = await this.load();
    const staged = new Map<string, RuntimeCodeEntry>();
    if (!this.profileKeys?.includes(bundleKey)) return staged;
    const profile = await this.profile(bundleKey);
    let pruned = false;
    for (const key of [...profile]) {
      const held = index.get(key);
      let entry = held ? this.entries.get(key) ?? null : null;
      if (held && entry === null) {
        let json = '';
        for (let n = 0; n < held[1]; n++) json += (await this.storage.get<string>(`${ENTRY_PREFIX}${key}:${n}`)) ?? '';
        try {
          entry = parseRuntimeCodeEntry(JSON.parse(json));
        } catch {
          entry = null;
        }
        if (entry !== null) this.entries.set(key, entry);
      }
      if (entry === null) {
        profile.delete(key);
        pruned = true;
        continue;
      }
      staged.set(key, entry);
    }
    if (pruned) await this.storage.put(PROFILE_PREFIX + bundleKey, [...profile]);
    return staged;
  }
}
