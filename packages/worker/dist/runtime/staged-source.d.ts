/**
 * staged-source.ts — the one supervisor-side read of a build artifact a bundle
 * script staged under public/_assets/ instead of inlining it in the Worker
 * bundle (wasm modules, facet source texts).
 *
 * The staging script pins each artifact by sha-256 in a `.generated.ts`. This
 * module reads it through L2 (caches.default) under a key that changes with
 * the bytes, with ASSETS as the source of truth, and hands out nothing that
 * fails the pinned digest: a stale or partial asset never reaches workerd's
 * loader or a facet. L2 is written only with verified bytes read from ASSETS.
 *
 * Artifacts differ only in what they name in errors and in what a bad L2 entry
 * means to their caller (`poisonedCache`), so each passes those in.
 */
/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface StagedSourceEnv {
    ASSETS?: {
        fetch(req: Request): Promise<Response>;
    };
}
/** One staged artifact, as its `.generated.ts` pins it. */
export interface StagedAsset {
    /** Asset path ASSETS serves, e.g. `/_assets/runtime/node-shims-<buildId>.js`. */
    path: string;
    /** L2 key; carries the build id or version, so it changes with the bytes. */
    l2Key: string;
    /** Full digest the bytes must match. */
    sha256: string;
    /** Content-Type of the L2 copy, where the artifact has one. */
    contentType?: string;
    /**
     * An L2 entry that fails the digest: `reject` throws, `refetch` deletes the
     * entry and reads ASSETS instead (whose bytes then replace it).
     */
    poisonedCache: 'reject' | 'refetch';
    /** Message for a deploy with no ASSETS binding. */
    missingBinding: string;
    /** Message for a non-OK ASSETS response. */
    fetchFailed(res: Response): string;
    /** Message for bytes that do not match `sha256`. */
    integrityFailed(digest: string, from: 'L2 cache' | 'ASSETS'): string;
}
/** Fetch a staged artifact's bytes and verify them against its pinned digest. */
export declare function fetchStagedBytes(env: StagedSourceEnv, asset: StagedAsset): Promise<ArrayBuffer>;
/** {@link fetchStagedBytes}, decoded as UTF-8. */
export declare function fetchStagedText(env: StagedSourceEnv, asset: StagedAsset): Promise<string>;
/**
 * One load per isolate: every caller shares the first call's promise, and a
 * rejected one is dropped so the next call loads again instead of pinning the
 * error.
 */
export declare function memoizeUntilRejected<A, T>(load: (arg: A) => Promise<T>): (arg: A) => Promise<T>;
/**
 * The `StagedAsset` of a facet source text staged under
 * public/_assets/runtime/ by `stagedBy` and needed by `requiredBy`: a bad L2
 * entry is replaced from ASSETS, since every later fetch in the colo for the
 * build would otherwise fail on it.
 */
export declare function stagedRuntimeSource(source: {
    label: string;
    entry: string;
    buildId: string;
    sha256: string;
    stagedBy: string;
    requiredBy: string;
}): StagedAsset;
//# sourceMappingURL=staged-source.d.ts.map