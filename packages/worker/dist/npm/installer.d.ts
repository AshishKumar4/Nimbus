/**
 * npm/installer.ts — Unified npm installer for Nimbus.
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
 *   - The project is read and written through the invoking principal's view
 *     of the namespace; the bulk paths serve it at its engine key, and a
 *     mounted project's packages are put there through the view (see
 *     fetchIntoMount)
 */
import { type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { NpmCache } from './cache.js';
import { type EngineMismatch } from '@nimbus-sh/core/_shared/npm-arborist/engines.js';
import { type NpmLogEmitter } from '@nimbus-sh/core/substrate/lifo/commands/system/npm-log.js';
import type { NpmCacheMode } from '@nimbus-sh/core/_shared/npm-cache-mode.js';
import type { BundlePoolProvider } from '../facets/prebundle-pool.js';
import type { InstallPhase } from '@nimbus-sh/platform/install-phase.js';
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
export interface NpmInstallOptions {
    /** Explicit packages (`npm install react`). */
    packages?: string[];
    /** `--omit=dev` (`--production`): what only devDependencies reach is planned, not installed. */
    production?: boolean;
    /** `--omit=optional` / `--omit=peer`: likewise for what only optional, or only peer, dependencies reach. */
    omitOptional?: boolean;
    omitPeer?: boolean;
    /** npm ci: install exactly the tree package-lock.json records. */
    fromLockfile?: boolean;
    /** The invoking process: authorizes the batch facet's writes. */
    pid: number;
    /** Its credential: what the project is read and written as. */
    cred: VfsCred;
    /** npm-protocol log sink (see --loglevel). */
    npmLog?: NpmLogEmitter;
    /** Per-invocation progress: overrides the constructor's sink. */
    onProgress?: (msg: string) => void;
    /** The command's NPM_REGISTRY; default registry.npmjs.org. */
    registry?: string;
    /** How packuments are read: npm's cache mode (`--offline`, `--prefer-offline`, `--prefer-online`); 'default' when not given. */
    cache?: NpmCacheMode;
    /** `--save-dev` / `--save-optional`: where what is named is saved. */
    saveDev?: boolean;
    saveOptional?: boolean;
    /** False for `--no-save`: package.json is left as it is. */
    save?: boolean;
    /** What a saved range starts with ('' for `--save-exact`); '^' when not given. */
    savePrefix?: string;
    /** `--force`: a peer conflict the project owns is a warning, and node's engine is not checked. */
    force?: boolean;
    /** `--engine-strict`: a package whose engines exclude this node or npm fails the install, which changes nothing. */
    engineStrict?: boolean;
    /** `--strict-peer-deps`: any peer conflict is ERESOLVE unless forced. */
    strictPeerDeps?: boolean;
    /** `--legacy-peer-deps`: peers are neither installed nor checked. */
    legacyPeerDeps?: boolean;
    /** `--prefer-dedupe`: one copy serves every edge it can, an older one included. */
    preferDedupe?: boolean;
    /** A global prefix's install: npm's shallow layout, and only what is named is built and changed. */
    global?: boolean;
    /** The command's: an install it stops before publication changes nothing; one waiting for the tree never starts. */
    signal?: AbortSignal;
    /** Run under the install's hold, once it has installed; answers the bins it linked. */
    whileHeld?: (result: NpmInstallResult) => Promise<number>;
}
export interface NpmInstallResult {
    installed: string[];
    failed: string[];
    totalFiles: number;
    elapsed: number;
    cachedHits: number;
    phases: Record<string, number>;
    /** The bins `whileHeld` linked. */
    linkedBins?: number;
    /** Each EBADENGINE of the tree (npm's engine check): warnings, or under --engine-strict the install's failure. */
    engines?: EngineMismatch[];
}
export declare class NpmInstaller {
    /** The session's namespace: the project is reached through it as the invoking principal. */
    private readonly filesystem;
    private readonly store;
    /** What installs in this session are staging or copying now: a sweep leaves them. */
    private readonly placing;
    private cache;
    /**
     * The installed tree of each project's lockfile, by the lockfile's
     * revision (lockRevision): a lockfile revision is read from its records
     * once, or taken from the tree the install that wrote it planned. The
     * disk is not trusted from it: the diff reads each placement.
     */
    private readonly installedTrees;
    private esbuild;
    /** The session's esbuild facet pool, shared with the on-demand dev-server path. */
    private bundlePool;
    private ctx;
    private env;
    /** Where an install that names no progress sink of its own reports. */
    private readonly onProgress;
    /** The workspace's network: every resolve and install facet (here and in peers) goes out through it. */
    private readonly network;
    constructor(filesystem: ProcessFiles, sql: SqlStorage, opts?: {
        esbuild?: EsbuildService;
        bundlePool?: BundlePoolProvider;
        ctx?: DurableObjectState;
        env?: any;
        onProgress?: (msg: string) => void;
        /** The workspace's network (`workspace.network`). */
        network: WorkspaceNetwork;
    });
    /** Expose cache for external use (e.g., serveModule in vite-dev-server). */
    get npmCache(): NpmCache;
    /**
     * Install packages for a project. Handles:
     * - Lockfile-based fast path (no network if lock is valid)
     * - Full resolution + fetch + write pipeline
     * - Incremental: only fetches/writes what changed
     */
    install(projectDir: string, opts: NpmInstallOptions): Promise<NpmInstallResult>;
    private _installInner;
    /**
     * F-2 frontier-coordinator path. Replaces the single-resolve-facet
     * dispatch with a per-package fanout: each BFS layer becomes ONE
     * `Fanout.submitMany` call, layer N+1 builds from the
     * resolved metadata of layer N.
     *
     * Topology auto-routes per layer on the session's Dynamic Worker headroom
     * (Fanout): a layer the headroom holds runs on in-DO loaders, a wider one
     * on sibling NimbusSession DOs. Each layer's route is in its profile entry.
     *
     * The walk is the install engine's plan (core _shared/npm-arborist,
     * npm's arborist build over what the lockfile says is installed); a
     * placement is required when a path of required edges reaches it, its
     * failure then failing the install; an optional one that fails is
     * skipped with what it takes along.
     *
     * The supervisor answers the plan's layers and owns:
     *   - what cannot run here (a native binding or executable the ABI
     *     policy names), left out where the plan finds it optional,
     *   - W6 swap / warn / reject decisions (top-level enforcement; the
     *     per-package task ALSO checks these for transitive correctness);
     *     a refusal fails a required placement,
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
     * Batch install via two-tier fan-out (Fanout).
     *
     * Shard count is `min(tarballs, INSTALL_PEER_CAP)`; each shard is one
     * installPackagesInFacet task with internal pLimit(3). Fanout routes the
     * shards on the session's Dynamic Worker headroom: shards the headroom
     * holds run on in-DO loaders, one Dynamic Worker each; more shards than
     * that go one per sibling NimbusSession DO. The route taken is logged
     * with the dispatch line.
     *
     * Sharding strategy: round-robin (`pkgIdx % N`) so every shard
     *   receives roughly equal work. Stable-id router maps each
     *   `shard-${i}` task key deterministically (tests can predict
     *   placement).
     */
    private fetchViaBatchFacet;
    /**
     * A mounted project's packages. The batch facet writes only the engine,
     * so it extracts them into a staging directory in /tmp there, as the
     * invoking principal whose batch writes it authorizes. Each placed
     * package is then put in the mounted node_modules through the
     * principal's view whole or not at all (placeMountedPackage); a package
     * that cannot be put there fails alone. What an install cut short left in
     * /tmp or beside a package is swept by the next one.
     */
    private fetchIntoMount;
    /** Staging directories in `tmp` no install in this session is using: an install cut short left them. */
    private sweepStaging;
    /** Copies beside the packages in `dir` (on a mount) no install in this session is using. */
    private sweepCopies;
    /**
     * The package staged at `src` on the engine, put at `dst` on a mount. It is
     * copied beside `dst` and renamed into place, so `dst` holds the old
     * package or the whole new one; packages the old one held in its own
     * node_modules that the new one does not bring stay. On a mount that
     * cannot rename, the files go in place with package.json last, so a copy
     * cut short reads as not installed and the next install puts it there.
     */
    private placeMountedPackage;
    /** An artifact this installer wrote as root in an earlier release, handed to its directory's owner (see handKernelArtifact). */
    private handKernelArtifact;
    /**
     * The install's roots (core npm-tree.ts projectRoots): every declared
     * dependency, and the packages named on the command line (`npm install
     * react react-dom@18.2.0`), explicit requests saved where npm saves them
     * (namedPackages); a global prefix's roots are only what is named.
     * What cannot run here is named by the advisory pass below, and a
     * swap rewrites a root's range to its target (applyW6Registry); nothing a
     * project declares is quietly left out of node_modules.
     */
    private buildRoots;
    /**
     * W6: apply the PACKAGE_ABI_POLICY swap rewrites and reject deny list
     * to a top-level spec map. Emits `[swap]` notices through `log`.
     *
     * A swap rewrites the spec's RANGE to an npm alias of the swap target
     * (`esbuild` → `npm:esbuild-wasm@<range>`), never its key: the key names
     * the install directory, so `resolved`, node_modules, the bin links, the
     * lockfile and package.json all keep the name the user declared. The
     * resolver facet treats the alias as authoritative and does not announce
     * the swap a second time.
     *
     * G2: rejects are advisories — a listed package stays in the spec map
     * and installs like any other (npm parity: it cannot run here, but
     * install is the wrong place to say so). Each gets one `[npm] note:`
     * line per install and an `advisory` registry event; the require-side
     * refusal carries the reason when the artifact is invoked.
     * `advised` dedupes across the top-level pass and the walk (the
     * package still resolves and can surface transitively).
     *
     * Idempotent: running on already-swapped specs is a no-op.
     */
    private applyW6Registry;
    /**
     * A lockfile entry's record: its registry package's (the stable identity
     * an alias names), read once however often one install asks for it; null
     * where the cache holds none of that exact package. `entries`' records
     * are read together, up front.
     */
    private lockRecords;
    /**
     * Remove the placements of `previous` (the last install's lockfile, and
     * what an optional failure left out) that `plan` does not hold. Answers
     * how many were removed.
     */
    private pruneExtraneous;
    /**
     * Remove `placements`, with the bins they linked, as the invoking
     * principal; a placement inside another removed one goes with it, and a
     * bin a package of `plan` links stays. Answers the placements removed.
     */
    private removePlacements;
    /**
     * npm ci: the tree package-lock.json (or npm-shrinkwrap.json) records,
     * each placement as it is locked, and whether the lock is suspect: its
     * root declares other dependencies than package.json (lockRootMatches).
     * The ABI policy the resolver applies still holds: what cannot run here
     * is left out where the plan finds it optional and refused where it is
     * required, and a swapped package resolves its swap target at the locked
     * version.
     */
    private treeFromPackageLock;
    /**
     * Write lockfile to SQLite.
     */
    private writeLockfile;
    /**
     * The installed tree `lockfile` records: each placement's package from its
     * registry package's record, under the name it installs as. A placement
     * whose record the cache does not hold is left out, and so planned anew;
     * a revision every record answered is kept (installedTrees).
     */
    private installedTree;
    /**
     * Create node_modules/.bin/ entries for packages with "bin" fields: one
     * streamed batch through the engine as the invoking principal (`engine`,
     * at the project's engine key), or written one by one through the
     * principal's view (`fs`) for a mounted project. A shim the bin manifest
     * already records as it is, and that is there, is not written again; nor
     * is a manifest that does not change.
     */
    private linkBins;
    /**
     * package.json with what the command line named saved, as npm saves it
     * (core npm-tree.ts saveNamed): each under its save type, at `^version`
     * unless the range given is one that would widen. `resolved` is keyed by
     * the name the user typed — a swapped package resolves as an alias under
     * that name (applySwaps), so `esbuild` is saved as `esbuild`, never the
     * swap target. `version`: the version the tree holds under a name.
     */
    private updatePackageJson;
    /**
     * Warm the browser bundles of what the project's browser source imports
     * from the packages this install put in node_modules (npm/browser-prebundle.ts,
     * the dev server's path for the same rows), in the background, one at a
     * time: each slice is walked in the supervisor just before its build, so at
     * most one is held. Best effort: the dev server bundles on demand whatever
     * is not warm.
     */
    private prebundleUsedModules;
    /** Monotonic count of transactionSync calls this DO's VFS has executed. */
    private storageCommitCount;
    /**
     * P5 (production reliability) — deterministic supervisor-heap estimate in MiB.
     *
     * Routes through @nimbus-sh/platform/heap-estimate.js which sums KNOWN
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