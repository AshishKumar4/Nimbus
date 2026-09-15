/**
 * require-resolver.ts — Server-side dependency graph resolver for Nimbus.
 *
 * Runs on the supervisor (which has synchronous VFS access) to trace
 * all require() calls and build a complete file bundle reachable from
 * the entry point. The output is consumed by `facet-manager.ts`'s
 * `buildPrefetchBundle` (W2.6a) to ship ONLY the reachable set into
 * the dynamic-worker module (rather than every file in node_modules
 * up to the legacy cap).
 *
 * Algorithm:
 *   1. Parse `require('xxx')` / `require("xxx")` / ``require(`xxx`)``
 *      and `require.resolve('xxx')` calls from entry code via regex.
 *   2. Resolve each via the SHARED `resolvePackageEntry` helper from
 *      src/_shared/exports-resolver.ts — same impl that node-shims
 *      and npm-resolver use, so prefetch and runtime always agree on
 *      which file `require('xyz')` means (W2.6a D6: no dual impls).
 *   3. Read the resolved file, recursively parse ITS requires.
 *   4. Return Record<string, string> of path → content.
 *
 * Static analysis still misses dynamic requires like `require(variable)`;
 * bounded greedy oversampling in facet-manager.ts:buildPrefetchBundle
 * compensates without limiting the statically-proven require closure.
 *
 * History: this file was ARC-A-P1 quarantined after W2 because the
 * legacy `buildVfsBundle` walked every file in node_modules. W2.6a
 * de-quarantines it as the primary content-bundle source.
 */
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
/**
 * Result of a prefetch walk: path → content for every reachable file.
 *
 * The walk is bounded at `VFS_BUNDLE_MAX_BYTES` of staged content. A
 * facet has no synchronous I/O primitive, so `require()` cannot fetch a
 * file it was not shipped — a closure that does not fit the bound can
 * never launch as a snapshot, and reading it in full is memory the
 * isolate may not survive. The walk therefore stats each required file
 * before reading and stops, without reading, on the file that would
 * cross the bound; the result is the typed `closure-exceeds-bound`
 * outcome below, never a partial closure passed off as complete.
 * Bounds for the optional enrichment passes live in facet-manager.ts,
 * which has a live async read path behind it.
 */
export interface PrefetchResult {
    bundle: Record<string, string>;
}
/**
 * The walk stopped at the snapshot bound. `bytesSeen` is content
 * already staged when the bound tripped; `lastPath` is the file whose
 * stat crossed it — it was never read.
 */
export interface ClosureBoundExceeded {
    kind: 'closure-exceeds-bound';
    entry: string;
    bytesSeen: number;
    bound: number;
    lastPath: string;
}
export type PrefetchOutcome = PrefetchResult | ClosureBoundExceeded;
/** Error form of `ClosureBoundExceeded` for callers that cannot return it. */
export declare class ClosureBoundExceededError extends Error {
    readonly outcome: ClosureBoundExceeded;
    constructor(outcome: ClosureBoundExceeded);
}
/** Resolve the complete dependency graph starting from entry code. */
export declare function prefetchForRequire(vfs: CredentialedVfs, entryCode: string, cwd: string, entryFile?: string, maxBundleBytes?: number): PrefetchOutcome;
//# sourceMappingURL=require-resolver.d.ts.map