/**
 * npm-installer.ts — Unified npm installer for Nimbus.
 *
 * Designed for bun/pnpm-level performance on Cloudflare DO + SQLite.
 *
 * Pipeline:
 *   Phase 0: Lock-check     — instant if lockfile valid
 *   Phase 1: Resolve        — pipelined, 12-wide concurrency, registry cached
 *   Phase 2: Hoist          — compute flat node_modules layout
 *   Phase 3: Diff           — skip packages already cached
 *   Phase 4: Fetch+Extract  — wave-based, 15 pkgs/wave, cache results
 *   Phase 5: Write          — bulk waves via writeBatchStream()
 *   Phase 6: Link bins      — create node_modules/.bin/ entries
 *   Phase 7: Pre-bundle     — scan source, esbuild used packages (background)
 *
 * Key invariants:
 *   - Bulk VFS writes use the explicit stream path (never individual writeFile)
 *   - Tarball cache is per-package (name, version) — no cross-package dedup
 *   - Lockfile stored in SQLite (not JSON file)
 *   - ESM pre-bundles cached in SQLite for /@modules/ serving
 */
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { NpmCache } from './cache.js';
import { type FetchFn } from './resolver.js';
import { type NpmLogEmitter } from './npm-log.js';
import type { InstallPhase } from '@nimbus-sh/core/_shared/install-phase.js';
export interface InstallProgress {
    phase: InstallPhase;
    resolved: number;
    totalToResolve: number;
    fetched: number;
    totalToFetch: number;
    written: number;
    totalToWrite: number;
    cachedHits: number;
    elapsed: number;
}
export interface NpmInstallResult {
    installed: string[];
    failed: string[];
    totalFiles: number;
    elapsed: number;
    cachedHits: number;
    phases: Record<string, number>;
}
export declare class NpmInstaller {
    private readonly store;
    private readonly vfs;
    private cache;
    private esbuild;
    private ctx;
    private env;
    private onProgress;
    /**
     * Injectable fetch function. Required because DO fetch() hangs in
     * wrangler local dev. The caller (NimbusSession) provides a function
     * that routes fetches through a facet worker. Used only by the resolve
     * path (packument JSON) — tarball fetches happen inside the facet pool
     * when the feature flag is on, using the facet's own global fetch.
     */
    private fetchFn;
    /**
     * npm-protocol log sink for the install in flight. Set per invocation
     * because `--loglevel` is a per-invocation flag; the no-op default is
     * what every caller that didn't pass one gets.
     */
    private npmLog;
    constructor(vfs: SqliteVFS, sql: SqlStorage, opts?: {
        esbuild?: EsbuildService;
        ctx?: DurableObjectState;
        env?: any;
        onProgress?: (msg: string) => void;
        fetchFn?: FetchFn;
    });
    /** Expose cache for external use (e.g., serveModule in vite-dev-server). */
    get npmCache(): NpmCache;
    /**
     * Install packages for a project. Handles:
     * - Lockfile-based fast path (no network if lock is valid)
     * - Full resolution + fetch + write pipeline
     * - Incremental: only fetches/writes what changed
     */
    install(projectDir: string, opts?: {
        packages?: string[];
        production?: boolean;
        pid?: number;
        npmLog?: NpmLogEmitter;
    }): Promise<NpmInstallResult>;
    private _installInner;
    /**
     * F-2 frontier-coordinator path. Replaces the single-resolve-facet
     * dispatch with a per-package fanout: each BFS layer becomes ONE
     * `NimbusFanoutPool.submitMany` call, layer N+1 builds from the
     * resolved metadata of layer N.
     *
     * Topology auto-routes per layer:
     *   width <  IN_DO_THRESHOLD (5)  → in-DO fanout in-DO loader-pool
     *   width >= IN_DO_THRESHOLD       → peer-DO fanout peer-DO (sibling NimbusSession DOs)
     *
     * The supervisor still owns:
     *   - cycle detection (`seen`),
     *   - X.5-F top-level / required-peer policy,
     *   - X.5-G G1 optional-native silent-skip,
     *   - X.5-drizzle best-effort tagging on optional-peer subtrees,
     *   - W6 swap / warn / reject decisions (top-level enforcement; the
     *     per-package task ALSO checks these for transitive correctness),
     *   - cache flushing (one batched putRegistryEntries at end).
     *
     * The per-package task (resolveOnePackumentInFacet) owns ONLY the
     * fetch + version pick + edge extraction. See
     *
     * Anti-requirements (cleanup-not-done charter): NO setTimeout
     * between layers, NO fallback to single-facet on missing bindings.
     */
    private resolveTreeViaFanout;
    /**
     * Batch install via two-tier fan-out (NimbusFanoutPool).
     *
     * Shard count is `min(specs.length, INSTALL_PEER_CAP)`, and the topology
     * follows from it:
     *   shardCount <  IN_DO_THRESHOLD (5)  → in-DO fanout in-DO
     *     1 NimbusLoaderPool with concurrency = shardCount, capped at
     *     4 by V8 invariant. Each shard is one facet running its own
     *     installPackagesInFacet.
     *   shardCount >= IN_DO_THRESHOLD       → peer-DO fanout peer-DO
     *     One peer NimbusSession sibling DO per shard, each running ONE
     *     installPackagesInFacet against its shard with internal pLimit(3).
     *
     * Sharding strategy: round-robin (`pkgIdx % N`) so every peer DO
     *   receives roughly equal work. Stable-id router maps each
     *   `shard-${i}` task key deterministically (tests can predict
     *   placement).
     *
     * Pre-fix lineage: this site previously ran ONE NimbusLoaderPool
     *   with concurrency=1, internal pLimit(3) — the explicit "collapses
     *   what was 4 concurrent dynamic workers (pool.map slots) into 1"
     *   Two-tier topology re-expands the fan-out without re-introducing
     *   the V8 cap risk.
     */
    private fetchViaBatchFacet;
    /**
     * Build the dependency specs from package.json + explicit packages.
     */
    /**
     * W11: framework detection at install time. Reads package.json from the
     * project root and runs detectFramework() against its deps + the basenames
     * we can see in node_modules-adjacent siblings.
     *
     * Returns true if the project is detected as one of {next, astro, nuxt,
     * remix, sveltekit, vite, wrangler}. False for 'unknown'.
     */
    private detectFrameworkAware;
    private buildSpecs;
    /**
     * W6: apply the PACKAGE_ABI_POLICY swap rewrites and reject deny list
     * to a top-level spec map. Emits `[swap]` notices via onProgress; throws
     * a multi-line error on any reject (with `transitive='warn'` rejects
     * also failing at top level — they only soften at depth>0).
     *
     * Idempotent: running on already-swapped specs is a no-op.
     */
    private applyW6Registry;
    /**
     * Check if a lockfile is still valid against current package.json specs.
     */
    private isLockfileValid;
    /**
     * Convert a lockfile back to resolved packages (for cache restore).
     */
    private lockfileToResolved;
    /**
     * Write lockfile to SQLite.
     */
    private writeLockfile;
    /**
     * Create node_modules/.bin/ entries for packages with "bin" fields.
     */
    private linkBins;
    private writeStreamPayload;
    private updatePackageJson;
    /**
     * Pre-bundle ESM modules that are actually imported by the project source.
     * Scans .ts/.tsx/.jsx/.js files for bare import specifiers (including
     * subpaths like `react/jsx-runtime`), then bundles each via esbuild.build()
     * with the VFS plugin.
     *
     * Critical: each bundle must externalize react / scheduler / jsx-runtime
     * as appropriate for the specifier being built. Without this, react-dom
     * and jsx-runtime each get their own embedded React copy and cross-bundle
     * JSX elements get rejected as "alien" — silent render failure.
     */
    private prebundleUsedModules;
    /**
     * Scan project source files for bare import specifiers.
     * Returns unique bare specifiers including subpaths (e.g., both `react`
     * AND `react/jsx-runtime` so each can be pre-bundled separately with the
     * correct externals for shared-runtime isolation).
     *
     * Also injects common JSX-runtime subpaths derived from esbuild's automatic
     * JSX transform: if `react` is imported, we also queue `react/jsx-runtime`
     * and `react/jsx-dev-runtime` because the compiled JSX output imports from
     * them even if the source never wrote `import ... from "react/jsx-runtime"`.
     */
    private scanBareImports;
    /**
     * Resolve a package's entry point to a VFS path.
     */
    /**
     * Resolve a specifier (possibly with subpath, e.g. "react/jsx-runtime" or
     * "react-dom/client") to an entry-point VFS path under node_modules.
     *
     * Algorithm:
     *   1. Split specifier into pkgName and subpath
     *      (e.g. "react-dom/client" → pkgName="react-dom", subpath="client";
     *       "@scope/pkg/sub" → pkgName="@scope/pkg", subpath="sub")
     *   2. Read node_modules/<pkgName>/package.json
     *   3. Use resolvePackageEntry(pkg, './' + subpath) to consult exports field
     *      with ESM conditions
     *   4. Try extensions and index-file fallbacks
     */
    private resolvePackageEntryPath;
    /** Monotonic count of transactionSync calls this DO's VFS has executed. */
    private storageCommitCount;
    /**
     * P5 (production reliability) — deterministic supervisor-heap estimate in MiB.
     *
     * Routes through observability/heap-estimate.ts which sums KNOWN
     * supervisor heap allocation sources from runtime counters that
     * ARE accurate inside a DO context (DiagCounters singleton +
     * SqliteVFS.getStats()). This replaces a previous use of
     * process.memoryUsage() which returned 0 for every field inside a
     * Durable Object class context, making the printed
     * "supervisor heap N MiB" lines actively misleading (they always
     * read 0.0 MiB regardless of actual heap state).
     *
     * The estimator is INTENTIONALLY conservative — peak-or-current
     * components, sum may overestimate — but it never under-reports.
     * Returns 0 if the estimator throws (defensive: a counter
     * regression must not block install completion).
     *
     * Same call shape used by /api/_diag/memory in
     * src/session/routes.ts:247, so the value printed in the
     * pre-bundle banner is comparable to the value the diag endpoint
     * reports for the same isolate.
     */
    private _estimateSupervisorHeapMiB;
}
//# sourceMappingURL=installer.d.ts.map