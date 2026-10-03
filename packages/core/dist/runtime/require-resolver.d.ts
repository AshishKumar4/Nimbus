/**
 * require-resolver.ts — Server-side dependency graph resolver for Nimbus.
 *
 * Runs on the supervisor (which has synchronous VFS access) to trace
 * all require() calls and build a complete file bundle reachable from
 * the entry point. The output is consumed by worker `facets/manager.ts`
 * to ship the reachable set into
 * the dynamic-worker module (rather than every file in node_modules
 * up to the legacy cap).
 *
 * Algorithm:
 *   1. Parse `require('xxx')` / `require("xxx")` / ``require(`xxx`)``
 *      and `require.resolve('xxx')` calls from entry code via regex.
 *   2. Resolve each with require-resolution.ts, over the SHARED `resolvePackageEntry` helper from
 *      src/_shared/exports-resolver.ts — same impl that node-shims
 *      and npm-resolver use, so prefetch and runtime always agree on
 *      which file `require('xyz')` means (W2.6a D6: no dual impls).
 *   3. Read the resolved file, recursively parse ITS requires.
 *   4. Return Record<string, string> of path → content.
 *
 * Static analysis still misses dynamic requires like `require(variable)`;
 * The module-map construction in worker facets/manager.ts also admits learned
 * reads without limiting the statically-proven require closure.
 *
 * History: this file was ARC-A-P1 quarantined after W2 because the
 * legacy `buildVfsBundle` walked every file in node_modules. W2.6a
 * de-quarantines it as the primary content-bundle source.
 */
import { type RequireFs, type WalkProgress } from './require-resolution.js';
export { requireFsOverBridge, type BridgeRequireFs, type RequireFs } from './require-resolution.js';
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
 * Bounds for the optional enrichment passes live in worker facets/manager.ts,
 * which has a live async read path behind it.
 */
export interface PrefetchResult {
    bundle: Record<string, string>;
    /** Reached only via dynamic `import()`: staged after the static closure, evictable, never a refusal. */
    speculative: Set<string>;
    /** Original entry reachability, before learned roots; preserves package-main discovery. */
    entryPaths?: ReadonlySet<string>;
    /** A dependency closure's `import()` deferrals, which it does not walk: phase 2's queue order. */
    deferred?: DeferredImport[];
}
/** An `import()` a module defers, and how many its module defers (phase 2's order). */
export interface DeferredImport {
    specifier: string;
    fromDir: string;
    alternatives: number;
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
export interface DependencyClosurePolicy {
    purpose: 'dependency-closure';
    held: Readonly<Record<string, string | Uint8Array>>;
    maxAdditionalBytes: number;
    maxAdditionalFiles: number;
}
export interface DependencyClosureDeclined {
    kind: 'dependency-closure-declined';
    path: string;
    reason: 'bytes' | 'files' | 'unreadable';
}
export type DependencyClosureOutcome = PrefetchOutcome | DependencyClosureDeclined;
/** Error form of `ClosureBoundExceeded` for callers that cannot return it. */
export declare class ClosureBoundExceededError extends Error {
    readonly outcome: ClosureBoundExceeded;
    constructor(outcome: ClosureBoundExceeded);
}
/** An executable module already observed, including a deleted generated file. */
export interface RequiredModuleRoot {
    path: string;
    text?: string;
    /**
     * A tool's config file, which the tool runs: the installed packages it
     * names by a string (postcss.config.js's `plugins: { tailwindcss: {} }`)
     * are what the tool loads by name, and they join phase 2.
     */
    config?: boolean;
}
/** Resolve the complete dependency graph starting from entry code. */
export declare function prefetchForRequire(vfs: RequireFs, entryCode: string, cwd: string, entryFile?: string, maxBundleBytes?: number, progress?: WalkProgress, policy?: undefined, requiredRoots?: Iterable<RequiredModuleRoot>): Promise<PrefetchOutcome>;
export declare function prefetchForRequire(vfs: RequireFs, entryCode: string, cwd: string, entryFile: string | undefined, maxBundleBytes: number | undefined, progress: WalkProgress | undefined, policy: DependencyClosurePolicy, requiredRoots?: Iterable<RequiredModuleRoot>): Promise<DependencyClosureOutcome>;
/**
 * The file a deferral a dependency closure reported (PrefetchResult.deferred)
 * loads, or null; resolved as the walk resolves its own, staging nothing:
 * the closure that admits the file stages the package.json files it needs.
 */
export declare function resolveDeferredImport(vfs: RequireFs, deferral: DeferredImport, progress?: WalkProgress): Promise<string | null>;
/**
 * The package names a config spells as a string or a property key
 * (`plugins: { tailwindcss: {} }`, `plugins: ['prettier-plugin-x']`), less
 * its import and export sources, which the walk follows already. A config
 * acorn cannot parse (TypeScript) names none.
 */
export declare function configPackageNames(source: string): string[];
//# sourceMappingURL=require-resolver.d.ts.map