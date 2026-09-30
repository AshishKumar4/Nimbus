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

const INDEX_KEY = 'residency-profile-index';
const PROFILE_PREFIX = 'residency-profile:';

export class ResidencyProfileStore {
  /** Bundle keys with a profile, least recently recorded first; null until read. */
  private keys: string[] | null = null;
  private readonly profiles = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: ResidencyProfileStorage,
    private readonly maxEntries: number,
    private readonly maxPaths: number,
  ) {}

  /** The paths earlier runs of `bundleKey` missed, oldest first. */
  paths(bundleKey: string): Promise<string[]> {
    return this.serial(async () => [...(await this.profile(bundleKey))]);
  }

  /**
   * Add what a run of `bundleKey` reported. Resolves true when the profile
   * gained a path, which is when that key's cached build is stale.
   */
  record(bundleKey: string, misses: readonly unknown[]): Promise<boolean> {
    return this.serial(async () => {
      const keys = await this.index();
      const profile = await this.profile(bundleKey);
      let learned = false;
      for (const path of misses) {
        if (profile.size >= this.maxPaths) break;
        if (typeof path !== 'string' || path === '' || profile.has(path)) continue;
        profile.add(path);
        learned = true;
      }
      const at = keys.indexOf(bundleKey);
      if (at >= 0) keys.splice(at, 1);
      keys.push(bundleKey);
      for (const oldest of keys.splice(0, Math.max(0, keys.length - this.maxEntries))) {
        this.profiles.delete(oldest);
        await this.storage.delete(PROFILE_PREFIX + oldest);
      }
      if (learned) await this.storage.put(PROFILE_PREFIX + bundleKey, [...profile]);
      await this.storage.put(INDEX_KEY, keys);
      return learned;
    });
  }

  /** What this isolate holds, for diagnostics; storage may hold more. */
  cached(): Array<{ key: string; paths: string[] }> {
    return [...this.profiles].map(([key, paths]) => ({ key, paths: [...paths] }));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async index(): Promise<string[]> {
    this.keys ??= (await this.storage.get<string[]>(INDEX_KEY)) ?? [];
    return this.keys;
  }

  private async profile(bundleKey: string): Promise<Set<string>> {
    let profile = this.profiles.get(bundleKey);
    if (!profile) {
      profile = new Set((await this.storage.get<string[]>(PROFILE_PREFIX + bundleKey)) ?? []);
      this.profiles.set(bundleKey, profile);
    }
    return profile;
  }
}
