/**
 * npm's cache mode for a registry read, as npm-registry-fetch's
 * getCacheMode names it for make-fetch-happen's cache:
 * - 'only-if-cached' (`--offline`): any cached copy answers, stale or not;
 *   with none the read fails (ENOTCACHED) and nothing goes to the network.
 * - 'force-cache' (`--prefer-offline`): any cached copy answers, stale or
 *   not; one with none is fetched.
 * - 'no-cache' (`--prefer-online`): a cached copy is asked of the registry
 *   again however fresh, on its validator (a 304 keeps it).
 * - 'default': a fresh copy answers; a stale one is asked again.
 */
export type NpmCacheMode = 'default' | 'no-cache' | 'force-cache' | 'only-if-cached';
/** npm's options a cache mode is read from (its flat options: `--offline`, `--prefer-offline`, `--prefer-online` and their aliases). */
export interface NpmCacheOptions {
    readonly offline?: unknown;
    readonly preferOffline?: unknown;
    readonly preferOnline?: unknown;
}
/** npm-registry-fetch getCacheMode: offline over prefer-offline over prefer-online. */
export declare function npmCacheMode(flat: NpmCacheOptions): NpmCacheMode;
/** make-fetch-happen's NotCachedError (code ENOTCACHED): `url` read in 'only-if-cached' with no cached copy. */
export declare function notCachedMessage(url: string): string;
//# sourceMappingURL=npm-cache-mode.d.ts.map