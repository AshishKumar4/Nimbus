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
 * Limits (sub-agent §Q1 caveats — extended regex still misses dynamic
 * requires like `require(variable)` and ESM `import` statements; greedy
 * oversampling in facet-manager.ts:buildPrefetchBundle compensates).
 *
 * History: this file was ARC-A-P1 quarantined after W2 because the
 * legacy `buildVfsBundle` walked every file in node_modules. W2.6a
 * de-quarantines it as the primary content-bundle source.
 */
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
/**
 * Result of a prefetch walk.
 *   - bundle:  path → content for every reachable file.
 *   - visited: set of pkgDirs (e.g. 'home/user/app/node_modules/fastify')
 *              encountered during the walk. Caller uses this to drive
 *              greedy oversampling — every visited package gets its
 *              package.json + main file forced into the bundle, even
 *              if the dynamic-require they're behind wasn't caught by
 *              the regex.
 *   - truncated: true if MAX_FILES or MAX_BYTES fired.
 */
export interface PrefetchResult {
    bundle: Record<string, string>;
    visitedPkgDirs: Set<string>;
    truncated: boolean;
}
/**
 * Resolve the complete dependency graph starting from entry code.
 * Returns Record<path, content> + the set of package directories
 * referenced (for greedy oversampling).
 */
export declare function prefetchForRequire(vfs: CredentialedVfs, entryCode: string, cwd: string, entryFile?: string): PrefetchResult;
//# sourceMappingURL=require-resolver.d.ts.map