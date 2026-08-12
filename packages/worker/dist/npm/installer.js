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
import { CRED_KERNEL } from '../runtime/os-contracts.js';
import { BUNDLER_VERSION } from '../runtime/esbuild-service.js';
import { NpmCache } from './cache.js';
import { computeHoistPlan, } from './resolver.js';
import { packumentUrl } from './r2-cache.js';
import { npmAddedLine, npmHttpCacheLine, npmHttpFetchLine, npmTitleLine, } from './npm-log.js';
import { applySwaps, findRejects, lookupSwap, lookupReject, shouldSkipPackage, shouldWarnSkipTransitive, isOptionalNativeBinding, formatSwapNotice, RegistryRejectError, emitRegistryEvent, } from '../facets/wasm-swap-registry.js';
import { resolvePackageEntry } from '../_shared/exports-resolver.js';
import { encodeWriteBatchStream } from '../_shared/w7-frame.js';
import { NimbusLoaderPool } from '../loaders/loader-pool.js';
import { NimbusFanoutPool, IN_DO_THRESHOLD } from '../loaders/fanout-pool.js';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE } from '../loaders/generated-workers.js';
import { installPackagesInFacet, } from './install-batch-facet.js';
import { setInstallPhase, recordInstallFacetCounters, recordPreBundleSummary, recordR2RaceCounters, recordCacheStatEvents, readDiagCounters, } from '../observability/diag-counters.js';
import { estimateSupervisorHeap } from '../observability/heap-estimate.js';
import { describeError } from '../observability/oom-classify.js';
import { resolveOnePackumentInFacet, } from './resolve-one-facet.js';
import { NPM_RESOLVE_PREAMBLE } from '../loaders/npm-resolve-preamble.js';
import { prebundleOne, buildSliceForSpecifierWithCap, externalsForSpecifier, } from './pre-bundle-facet.js';
import { PRE_BUNDLE_PREAMBLE } from '../loaders/pre-bundle-preamble.js';
import { fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';
import { CHUNK_SIZE, PRE_BUNDLE_CONCURRENCY, PRE_BUNDLE_SLICE_CAP_BYTES, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, } from '../constants.js';
import { acquireSupervisorAllocation } from '../observability/heavy-alloc-coord.js';
import { countPackageFiles, BARREL_PKG_FILE_THRESHOLD, packageNameFromSpecifier } from '../runtime/barrel-detect.js';
import { scanNamedImports, namedImportSignature, buildSyntheticEntry, buildScopedSliceForSynthetic, syntheticEntryPath, } from '../runtime/barrel-synthesizer.js';
import { enc } from '../_shared/bytes.js';
import { createNpmBinManifest, createNpmBinShim, npmBinManifestPath, packageBinEntries, } from './bin-links.js';
// ── NpmInstaller ────────────────────────────────────────────────────────
export class NpmInstaller {
    store;
    vfs;
    cache;
    esbuild;
    ctx;
    env;
    onProgress;
    /**
     * Injectable fetch function. Required because DO fetch() hangs in
     * wrangler local dev. The caller (NimbusSession) provides a function
     * that routes fetches through a facet worker. Used only by the resolve
     * path (packument JSON) — tarball fetches happen inside the facet pool
     * when the feature flag is on, using the facet's own global fetch.
     */
    fetchFn;
    /**
     * npm-protocol log sink for the install in flight. Set per invocation
     * because `--loglevel` is a per-invocation flag; the no-op default is
     * what every caller that didn't pass one gets.
     */
    npmLog = () => { };
    constructor(vfs, sql, opts) {
        this.store = vfs;
        this.vfs = vfs.as(CRED_KERNEL);
        this.cache = new NpmCache(sql);
        this.esbuild = opts?.esbuild ?? null;
        this.ctx = opts?.ctx;
        this.env = opts?.env;
        this.onProgress = opts?.onProgress;
        this.fetchFn = opts?.fetchFn;
    }
    /** Expose cache for external use (e.g., serveModule in vite-dev-server). */
    get npmCache() { return this.cache; }
    // ── Main entry point ──────────────────────────────────────────────────
    /**
     * Install packages for a project. Handles:
     * - Lockfile-based fast path (no network if lock is valid)
     * - Full resolution + fetch + write pipeline
     * - Incremental: only fetches/writes what changed
     */
    async install(projectDir, opts) {
        const start = Date.now();
        const projDir = projectDir.replace(/^\/+/, '').replace(/\/+$/, '');
        const nmDir = projDir + '/node_modules';
        const log = (msg) => this.onProgress?.(msg);
        this.npmLog = opts?.npmLog ?? (() => { });
        // Reset phase to 'idle' on any exit path so /api/_diag/memory
        // never reports a stale phase after a crash unwound the install.
        // The DO reboot would zero this anyway; finally is defense against
        // a non-fatal mid-install throw.
        try {
            return await this._installInner(projDir, nmDir, opts, log, start);
        }
        finally {
            setInstallPhase('idle');
            this.npmLog = () => { };
        }
    }
    async _installInner(projDir, nmDir, opts, log, start) {
        const phases = {};
        const installed = [];
        const failed = [];
        let totalFiles = 0;
        let cachedHits = 0;
        // ── Phase 0: Lock-check ─────────────────────────────────────────
        setInstallPhase('idle');
        this.npmLog('verbose', npmTitleLine(opts?.packages ?? []));
        let phaseStart = Date.now();
        log('Checking lockfile...');
        const specs = await this.buildSpecs(projDir, opts?.packages, opts?.production);
        if (Object.keys(specs).length === 0) {
            log('No dependencies to install.');
            return { installed, failed, totalFiles: 0, elapsed: Date.now() - start, cachedHits: 0, phases: {} };
        }
        // W11: framework detection. If the project depends on a framework
        // (next/astro/nuxt/remix/sveltekit) or generic vite, we exempt
        // FRAMEWORK_REQUIRED_PACKAGES (vite, ...) from the SKIP_PACKAGES set
        // so the framework's CLI can `import 'vite'` from node_modules.
        const frameworkAware = await this.detectFrameworkAware(projDir);
        if (frameworkAware) {
            log(`Framework detected — installing framework-required packages (vite, …).`);
        }
        const lockfile = this.cache.readLockfile(projDir);
        let resolved;
        let usedLockfile = false;
        if (lockfile && !opts?.packages && this.isLockfileValid(lockfile, specs)) {
            log(`Lockfile valid (${lockfile.size} packages). Skipping resolution.`);
            resolved = this.lockfileToResolved(lockfile);
            usedLockfile = true;
            phases['lock-check'] = Date.now() - phaseStart;
        }
        else {
            if (lockfile && !opts?.packages) {
                log('Lockfile outdated. Re-resolving...');
            }
            phases['lock-check'] = Date.now() - phaseStart;
            // ── Phase 1: Resolve ──────────────────────────────────────────
            // Frontier-coordinator path. Each BFS layer dispatches to
            // NimbusFanoutPool.submitMany — width <5 in-DO (in-DO fanout),
            // width ≥5 peer-DO (peer-DO fanout). Per-package task body is
            // self-contained (resolveOnePackumentInFacet), supervisor builds
            // layer N+1 from layer N's edges. Missing env.LOADER throws at
            // construction; missing env.NIMBUS_SESSION throws at the first
            // wide-layer submitMany.
            phaseStart = Date.now();
            setInstallPhase('resolve');
            log(`Resolving ${Object.keys(specs).length} dependencies (path: fanout, fetch: ${this.fetchFn ? 'facet-proxy' : 'global'})...`);
            const tree = await this.resolveTreeViaFanout(specs, log, { frameworkAware });
            resolved = tree.resolved;
            phases['resolve'] = Date.now() - phaseStart;
            // A dependency the walk could not resolve is missing from the
            // install and from every subtree beneath it. Name it and its
            // reason, and carry it into `failed` so the command exits non-zero.
            for (const [name, reason] of tree.unresolved) {
                failed.push(name);
                log(`npm ERR! could not resolve ${name}: ${reason}`);
            }
            if (resolved.size === 0) {
                log('No packages resolved.');
                for (const name of Object.keys(specs)) {
                    if (!tree.unresolved.has(name))
                        failed.push(name);
                }
                return {
                    installed, failed,
                    totalFiles: 0, elapsed: Date.now() - start, cachedHits: 0, phases,
                };
            }
            log(`Resolved ${resolved.size} packages.`);
        }
        // ── Phase 2: Hoist ────────────────────────────────────────────────
        phaseStart = Date.now();
        setInstallPhase('hoist');
        const hoistPlan = computeHoistPlan(resolved);
        phases['hoist'] = Date.now() - phaseStart;
        // ── Phase 3: Diff (cache check) ─────────────────────────────────
        phaseStart = Date.now();
        setInstallPhase('diff');
        const toFetch = [];
        for (const [, pkg] of resolved) {
            if (!pkg.tarballUrl) {
                // Resolved metadata with no tarball cannot be installed. Silently
                // dropping it here left the package absent from node_modules and
                // absent from both outcome lists.
                failed.push(`${pkg.name}@${pkg.version}`);
                log(`npm ERR! ${pkg.name}@${pkg.version}: resolved metadata carries no tarball URL`);
                continue;
            }
            // Check if already installed at the correct path
            const pkgJsonPath = nmDir + '/' + pkg.name + '/package.json';
            if (this.vfs.exists(pkgJsonPath)) {
                try {
                    const existing = JSON.parse(this.vfs.readFileString(pkgJsonPath));
                    if (existing.version === pkg.version) {
                        // Already installed at correct version — skip
                        installed.push(`${pkg.name}@${pkg.version}`);
                        cachedHits++;
                        continue;
                    }
                }
                catch { /* corrupt package.json — reinstall */ }
            }
            // Not present in the VFS at the right version — fetch it. The batch
            // facet consults the shared L2 (caches.default) + L3 (R2) tarball
            // tiers itself, so a cross-DO warm cache still lands here.
            toFetch.push(pkg);
        }
        phases['diff'] = Date.now() - phaseStart;
        log(`To fetch: ${toFetch.length}, already installed: ${cachedHits}`);
        // ── Phase 4+5: Fetch + Write (wave-based) ───────────────────────
        phaseStart = Date.now();
        setInstallPhase('fetch');
        // Fetch + extract + write new packages.
        //
        // Single fetch path: one NimbusLoaderPool isolate (the batch facet)
        // runs the entire install. The facet streams tarballs through gunzip+tar
        // and coalesces package-owned paths into shared writeBatchStream waves;
        // every owner awaits each wave it contributed to.
        //
        // No fallback paths: env.LOADER + ctx are platform requirements
        // (their absence is a deploy bug, not a runtime branch). Per-package
        // pool.map and the legacy in-supervisor fetchWaves loop were both
        // removed in Phase 2 A'.1 — they re-introduced the supervisor-heap
        // pressure the facet path eliminates.
        // The shards write through the supervisor's VFS, so every transactionSync
        // they cause runs on this DO's only thread. Only the count is reported:
        // a DO's clock advances at I/O, never across synchronous work, so timing
        // a transactionSync from inside it measures zero by construction (60,673
        // transactions once summed to 0.0 ms with a 0.0 ms maximum). The count is
        // still the honest scale signal for the staged-write protocol.
        const commitsBefore = this.storageCommitCount();
        if (toFetch.length > 0) {
            log(`Fetching ${toFetch.length} packages... (path: batch-facet)`);
            const batchResult = await this.fetchViaBatchFacet(toFetch, hoistPlan, nmDir, opts?.pid);
            totalFiles += batchResult.filesWritten;
            for (const name of batchResult.installed)
                installed.push(name);
            for (const name of batchResult.failed)
                failed.push(name);
        }
        phases['fetch+write'] = Date.now() - phaseStart;
        const commitCount = this.storageCommitCount() - commitsBefore;
        // ── Phase 6: Link bins ──────────────────────────────────────────
        phaseStart = Date.now();
        setInstallPhase('link-bins');
        await this.linkBins(resolved, nmDir);
        phases['link-bins'] = Date.now() - phaseStart;
        // ── Write lockfile ──────────────────────────────────────────────
        if (!usedLockfile || opts?.packages) {
            this.writeLockfile(projDir, resolved, hoistPlan, nmDir);
        }
        // ── Update package.json if explicit packages were added ─────────
        if (opts?.packages && opts.packages.length > 0) {
            this.updatePackageJson(projDir, opts.packages, resolved);
        }
        // ── Phase 7: Pre-bundle (TRULY fire-and-forget) ─────────────────
        // The install command resolves IMMEDIATELY. Pre-bundle dispatches
        // its facet work in the background.
        //
        // Why true fire-and-forget (not await + try/catch):
        //   1. A try/catch cannot save us from a workerd-level isolate kill
        //      (e.g. wasm-compile disallowed errors, OOM, eval blocks).
        //      Verified on prod: when the pre-bundle facet threw at request
        //      time, the await unwound but the WS had already been torn
        //      down by the runtime. The catch ran AFTER damage was done.
        //   2. Pre-bundling is a best-effort optimisation — every miss is
        //      recovered by the on-demand bundler at
        //      src/vite-dev-server.ts:1466 (serveModule()), which compiles
        //      a single module in the supervisor's EsbuildService at
        //      page-load time. No correctness dependency.
        //   3. Decoupling install success from pre-bundle success means a
        //      future pre-bundle bug never fails an install. Single
        //      responsibility per phase.
        //
        // phases['bundle'] now reflects DISPATCH time, not bundle-completion
        // time. The total install elapsed reflects user-perceived completion
        // (immediate after fetch+write+link-bins+lockfile).
        if (this.esbuild) {
            phaseStart = Date.now();
            setInstallPhase('bundle');
            // ── Bug 1 (production reliability P4) — late-progress gating ───────────────
            //
            // Background:
            //   The install command MUST resolve immediately (see the long
            //   note above re: workerd isolate-kill paths that defeat
            //   try/catch on awaits). We keep that invariant intact.
            //
            // Symptom we are fixing:
            //   prebundleUsedModules's `finally` block emits a "Pre-bundle
            //   complete:" line via this.onProgress (installer.ts:1548).
            //   onProgress is the closure
            //   `(msg) => ctx.stdout.write('[npm] ' + msg + '\n')` captured
            //   from the npm registry handler in
            //   src/session/init.ts:1228 / :1723. After install() returns,
            //   the npm command-handler returns to the shell, the shell
            //   prints its prompt, and THEN the orphan promise's safeProgress
            //   fires — visually corrupting the freshly-rendered prompt
            //   ("user@nimbus:~/app$ [npm] Pre-bundle complete: ...").
            //
            // Fix:
            //   Suppress writes to ctx.stdout once install() has returned.
            //   Pre-bundle progress is still observable via wrangler dev
            //   console (console.log) and via /api/_diag/memory's
            //   recordPreBundleSummary aggregate, but it does NOT touch the
            //   user's interactive terminal after the prompt has redrawn.
            //
            // Why a flag instead of swapping `this.onProgress`:
            //   ensureNpmInstaller (nimbus-session.ts:892) caches the
            //   installer on `this.npmInstaller` for the DO's lifetime. A
            //   subsequent `npm install` invocation has a different ctx,
            //   so the persistent onProgress reference is doubly wrong:
            //   it's stale-after-this-invocation AND it would clobber the
            //   next install's progress channel. Gating without mutating
            //   keeps the swap simple and idempotent.
            const installInvocationActive = { v: true };
            // Replace this.onProgress (the persistent ctx.stdout closure)
            // with a wrapper for the duration of pre-bundle. While the
            // outer install() call is on the stack the wrapper forwards to
            // the original; once we flip the flag in the cleanup below,
            // the wrapper drops to a console.log fallback so traces aren't
            // lost but ctx.stdout never sees them.
            const persistentProgress = this.onProgress;
            this.onProgress = (msg) => {
                if (installInvocationActive.v) {
                    persistentProgress?.(msg);
                }
                else {
                    // Late progress — pre-bundle finished AFTER install()
                    // returned. Surface to the wrangler dev console only so
                    // the user's shell prompt isn't corrupted.
                    try {
                        console.log('[npm:late] ' + msg);
                    }
                    catch { }
                }
            };
            // Fire-and-forget. Capture rejections so the orphan promise
            // never raises an "unhandled rejection" warning. We do NOT
            // await here — see Phase 7 design note above for why.
            const prebundlePromise = this.prebundleUsedModules(projDir, resolved)
                .catch((e) => {
                // Routes through the installInvocationActive gate above,
                // so this is safe to call from after-return: it lands on
                // console.log instead of ctx.stdout.
                log(`pre-bundle skipped: ${e?.message || String(e)}`);
            })
                .finally(() => {
                // Always restore the persistent reference so a subsequent
                // ensureNpmInstaller call (which doesn't reconstruct the
                // installer) can still wire a fresh ctx.stdout closure.
                this.onProgress = persistentProgress;
            });
            // Mark `void` so the linter / human reader knows we intentionally
            // don't await this. The promise outlives the install command.
            void prebundlePromise;
            phases['bundle'] = Date.now() - phaseStart;
            // The flag flip happens AFTER install() returns its result.
            // We schedule it inline by closing over the same object;
            // the `finally` at install()'s top level (line 173) gets us
            // to the right boundary. We piggyback there via a deferred
            // microtask: when the outer try{} returns the result object,
            // the microtask flips the flag; pre-bundle's safeProgress
            // calls after this point land on console.log.
            queueMicrotask(() => {
                installInvocationActive.v = false;
            });
        }
        setInstallPhase('done');
        const elapsed = Date.now() - start;
        if (failed.length > 0) {
            // Never claim success for a partial install: the next command is
            // where the missing package surfaces, as an unrelated-looking error.
            log(`npm ERR! install incomplete — ${installed.length} installed, ` +
                `${failed.length} missing: ${failed.join(', ')}`);
        }
        else {
            log(`Done! ${installed.length} packages, ${totalFiles} files in ${(elapsed / 1000).toFixed(1)}s`);
            // npm's own summary line, unstyled: the styled one the command site
            // prints carries a colour prefix that no log parser matches. Carried
            // at `http` — the level from which this stream is machine-readable —
            // so a caller reading prose never sees the summary twice.
            this.npmLog('http', npmAddedLine(installed.length, elapsed));
        }
        if (cachedHits > 0) {
            log(`  (${cachedHits} from cache)`);
        }
        // The per-phase timings were computed on every install and then
        // dropped, so "install took 60s" carried no information about which
        // phase owned the 60s. Emit the breakdown next to the total it
        // decomposes. `bundle` is dispatch-only (Phase 7 is fire-and-forget).
        log('  phases: ' +
            Object.entries(phases)
                .map(([name, ms]) => `${name}=${fmtPhaseMs(ms)}`)
                .join(' '));
        log(`  storage: ${commitCount} transactions during fetch+write`);
        return { installed, failed, totalFiles, elapsed, cachedHits, phases };
    }
    // ── Single-resolver / single-fetcher invariant ───────────────────────
    //
    // The resolver and fetcher each run in exactly one facet path with no
    // in-supervisor fallback, so the supervisor heap stays flat:
    //   Resolver: per-package fanout (resolve-one-facet.ts), driven by
    //             resolveTreeViaFanout below.
    //   Fetcher : install-batch-facet.ts, driven by fetchViaBatchFacet below.
    //
    // env.LOADER and ctx are platform requirements; if either is
    // missing the install fails loud at the first await on the facet
    // pool — that's a deploy bug, not a runtime branch.
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
    async resolveTreeViaFanout(specs, log, opts = {}) {
        const t0 = Date.now();
        const frameworkAware = !!opts.frameworkAware;
        const __f2Diag = (globalThis.process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');
        // Per-walk state — supervisor side.
        const resolved = new Map();
        // Dependencies the walk asked for and could not resolve, name → reason.
        // A name lands here at most once: the frontier marks it `seen` before
        // dispatch, so no later parent re-enqueues it.
        const unresolved = new Map();
        const seen = new Set();
        const topLevelNames = new Set(Object.keys(specs));
        const optionalNames = new Set(); // X.5-G G1
        const bestEffortNames = new Set(); // X.5-drizzle
        let queue = Object.entries(specs);
        const cacheWritesPending = [];
        let totalPackumentBytes = 0;
        let totalPackumentsDecoded = 0;
        let layerN = 0;
        let totalLayers = 0;
        let r2Wins = 0;
        let r2Losses = 0;
        // Layers are a hard barrier: layer N+1 cannot be built until every
        // task in layer N returns. `width@ms` per layer is what separates
        // "resolution is slow because there are many packuments" from
        // "resolution is slow because there are many barriers".
        const layerProfile = [];
        // Every layer additionally splits into peer-DO dispatch phases, each its
        // own barrier, so the walk's real serialization is the barrier total
        // rather than the layer count.
        let dispatchBarriers = 0;
        // cache-obs-2: accumulator for per-tier cache events across all
        // resolve-one tasks in this fanout walk. Drained at end-of-walk
        // into the DO singleton via recordCacheStatEvents.
        const fanoutCacheStatEvents = [];
        // Counter for diagnostics — peak in-flight inside a layer = layer
        // width (parallelism mirrors the in-DO/peer-DO pool's task count).
        let inFlightPeak = 0;
        // Peers one resolve layer may spread across. Mirrors INSTALL_PEER_CAP on
        // the write side (fetchViaBatchFacet), for the same reason and at the same
        // width: eight is where added peers stop buying throughput and start
        // buying sibling-DO cold starts.
        const RESOLVE_PEER_CAP = 8;
        // F-2 fanout pool. One construction reused across every layer; the
        // pool is stateless across submitMany calls.
        const fanoutPool = new NimbusFanoutPool(this.env, this.ctx, {
            tag: 'npm-resolve-fanout',
            // 5 minutes per layer is generous; typical layers complete in
            // 1-3 s. Per-task this gates each packument fetch + R2 race.
            timeoutMs: 5 * 60_000,
            preamble: NPM_RESOLVE_PREAMBLE,
            onDispatchPhase: () => { dispatchBarriers++; },
            // One peer per package is what this dispatched before, and resolving a
            // package is one cached-packument read — far too little work to pay a
            // sibling DO start for. A 123-package install walked 8 layers as 23
            // barriers (33-wide layer: 8.2 s to serve 33 reads that all hit the
            // cache), because a layer of width W costs ⌈min(W,32)/FANOUT_PHASE_SIZE⌉
            // of them. Capping peers here is the same fix INSTALL_PEER_CAP already
            // applies to the write side, and it does not cost concurrency: each peer
            // runs its bucket at concurrency 4, so 8 peers still resolve 32 at once.
            maxPeers: RESOLVE_PEER_CAP,
        });
        // Frontier loop. Each iteration = ONE BFS layer dispatched as ONE
        // submitMany batch.
        while (queue.length > 0) {
            // Dedupe + filter the layer up front. The task body also filters
            // (defensive), but doing it here avoids dispatching wasted RPC
            // for already-seen names.
            const layer = [];
            const layerSeenLocal = new Set();
            for (const [name, range] of queue) {
                if (seen.has(name) || layerSeenLocal.has(name))
                    continue;
                layerSeenLocal.add(name);
                seen.add(name);
                layer.push([name, range]);
            }
            queue = [];
            if (__f2Diag) {
                log(`[f2-frontier] N=${layerN} width=${layer.length} resolved-so-far=${resolved.size} seen=${seen.size}`);
            }
            if (layer.length === 0)
                break;
            // Track peak — the layer is dispatched in parallel inside the pool.
            if (layer.length > inFlightPeak)
                inFlightPeak = layer.length;
            totalLayers++;
            // Build per-package tasks. Each task gets its own pre-loaded
            // cache slice (only entries for THIS name) so the per-task RPC
            // stays small. Bounded to 16 versions per name — enough to cover
            // ~2 majors of typical packages, well under any RPC arg size cap.
            const tasks = layer.map(([name, range]) => {
                const cachedRows = this.cache.getRegistryVersions(name).slice(0, 16);
                const cachedEntries = cachedRows.map((e) => ({
                    name: e.name,
                    version: e.version,
                    tarballUrl: e.tarballUrl,
                    integrity: e.integrity,
                    depsJson: e.depsJson,
                    peerDepsJson: e.peerDepsJson,
                    exportsJson: e.exportsJson,
                    main: e.main,
                    moduleField: e.moduleField,
                    binJson: e.binJson,
                    platformJson: e.platformJson,
                    optionalDepsJson: e.optionalDepsJson,
                    fetchedAt: e.fetchedAt,
                }));
                const taskSpec = {
                    name,
                    range,
                    cachedEntries,
                    topLevel: topLevelNames.has(name),
                    isOptional: optionalNames.has(name),
                    frameworkAware,
                    fetchTimeoutMs: 15_000,
                    retries: 3,
                };
                return { key: name, args: taskSpec };
            });
            // Dispatch the layer. NimbusFanoutPool routes:
            //   <5 → in-DO fanout in-DO (NimbusLoaderPool), concurrency = layer.length (capped at 4)
            //   ≥5 → peer-DO fanout peer-DO, N peers = min(layer.length, 32)
            let results;
            const layerT0 = Date.now();
            try {
                results = await fanoutPool.submitMany(tasks, resolveOnePackumentInFacet);
                layerProfile.push(`${layer.length}@${Date.now() - layerT0}ms`);
            }
            catch (e) {
                // Per anti-requirement: no fallback. Log + propagate.
                const msg = `${describeError(e)} (layer width ${layer.length}, ${fanoutPool.topologyFor(layer.length)})`;
                log(`  resolver-fanout layer ${layerN} failed: ${msg}`);
                throw new Error(`resolver-fanout failed at layer ${layerN}: ${msg}`, { cause: e });
            }
            // Stitch per-package results into supervisor state. The dispatched
            // layer — not the returned array — drives the loop, so a result the
            // fanout failed to deliver is recorded instead of skipped.
            for (let i = 0; i < layer.length; i++) {
                const res = results[i];
                const [taskName] = layer[i];
                if (!res) {
                    unresolved.set(taskName, `resolver fanout returned no result at layer ${layerN}`);
                    continue;
                }
                // Forward messages + events.
                for (const m of res.messages)
                    log(m);
                for (const ev of res.events) {
                    try {
                        emitRegistryEvent(ev);
                    }
                    catch { /* swallow sink errors */ }
                }
                // Accumulate cache writes for end-of-walk flush.
                for (const cw of res.cacheWrites)
                    cacheWritesPending.push(cw);
                // cache-obs-2: harvest per-task cache events for end-of-walk fold.
                if (res.cacheStatEvents)
                    fanoutCacheStatEvents.push(...res.cacheStatEvents);
                // One `npm http` line per packument, reporting the tier that actually
                // served it. A skipped task issued no request, so it gets no line.
                if (res.packumentSource === 'network') {
                    this.npmLog('http', npmHttpFetchLine(packumentUrl(taskName), res.packumentElapsedMs));
                }
                else if (res.packumentSource !== 'skipped') {
                    this.npmLog('http', npmHttpCacheLine(packumentUrl(taskName)));
                }
                totalPackumentBytes += res.packumentBytesDecoded;
                if (res.packumentSource === 'r2-cache')
                    r2Wins++;
                else if (res.packumentSource === 'network')
                    r2Losses++;
                if (res.packumentBytesDecoded > 0)
                    totalPackumentsDecoded++;
                // W6 reject error handling.
                if (res.error && res.error.type === 'w6-reject') {
                    if (bestEffortNames.has(taskName)) {
                        // X.5-drizzle: silent-skip inside best-effort optional-peer
                        // subtree.
                        const reason = `inside best-effort optional-peer subtree (X.5-drizzle): ${res.error.reason}`;
                        log(`[resolve-fanout] [skip] ${taskName} — ${reason}`);
                        emitRegistryEvent({ type: 'transitive-skip', from: taskName, reason });
                        continue;
                    }
                    // Real reject: throw RegistryRejectError to abort install.
                    const rejectEntry = {
                        from: res.error.from,
                        reason: res.error.reason,
                        suggest: res.error.suggest,
                        transitive: 'fail',
                    };
                    throw new RegistryRejectError([rejectEntry]);
                }
                // Resolution failure. Optional (X.5-G G1) and best-effort
                // optional-peer (X.5-drizzle) edges are allowed to disappear;
                // anything else is a dependency the project asked for and did
                // not get, so it is recorded and surfaced as an install failure.
                if (res.error && res.error.type === 'unresolved') {
                    if (optionalNames.has(taskName) || bestEffortNames.has(taskName)) {
                        const reason = `optional dep unresolved: ${res.error.reason}`;
                        log(`[resolve-fanout] [skip] ${taskName} — ${reason}`);
                        emitRegistryEvent({ type: 'transitive-skip', from: taskName, reason });
                        continue;
                    }
                    unresolved.set(taskName, res.error.reason);
                    continue;
                }
                const pkg = res.pkg;
                if (!pkg) {
                    // Every deliberate skip reports 'skipped'. Anything else that
                    // returns no package is a resolver bug, and dropping it here is
                    // how a required dependency plus its whole subtree used to
                    // vanish from an install that then reported success.
                    if (res.packumentSource !== 'skipped') {
                        unresolved.set(taskName, 'resolver returned no package and no reason');
                    }
                    continue;
                }
                // X.5-G G1: silent-skip platform-native bindings sourced from
                // optionalDependencies. The task returns the pkg raw; the
                // supervisor classifies it against the package ABI policy.
                if (optionalNames.has(taskName)) {
                    if (isOptionalNativeBinding({
                        name: pkg.name,
                        os: pkg.os, cpu: pkg.cpu, libc: pkg.libc,
                        main: pkg.main,
                    })) {
                        const reason = `optional native binding (os=${pkg.os ?? '*'}, cpu=${pkg.cpu ?? '*'}, libc=${pkg.libc ?? '*'}, main=${pkg.main || '?'})`;
                        log(`[resolve-fanout] [skip] ${taskName} — ${reason}`);
                        emitRegistryEvent({ type: 'transitive-skip', from: taskName, reason });
                        continue;
                    }
                }
                if (resolved.has(pkg.name))
                    continue;
                resolved.set(pkg.name, pkg);
                // Edge extraction.
                const inheritBestEffort = bestEffortNames.has(pkg.name);
                for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
                    if (resolved.has(depName) || seen.has(depName))
                        continue;
                    if (inheritBestEffort)
                        bestEffortNames.add(depName);
                    queue.push([depName, depRange]);
                }
                const optDeps = pkg.optionalDependencies;
                if (optDeps) {
                    for (const [depName, depRange] of Object.entries(optDeps)) {
                        if (resolved.has(depName) || seen.has(depName))
                            continue;
                        optionalNames.add(depName);
                        if (inheritBestEffort)
                            bestEffortNames.add(depName);
                        queue.push([depName, depRange]);
                    }
                }
                if (pkg.peerDependencies) {
                    for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies)) {
                        if (resolved.has(peerName) || seen.has(peerName))
                            continue;
                        topLevelNames.add(peerName);
                        if (inheritBestEffort)
                            bestEffortNames.add(peerName);
                        queue.push([peerName, peerRange]);
                    }
                }
                // X.5-F R2.5 + X.5-J: optional peers when THIS pkg is the
                // user's top-level. Filter through the policy reject list.
                if (topLevelNames.has(pkg.name)) {
                    const allPeers = pkg.__allPeerDependencies;
                    if (allPeers) {
                        for (const [peerName, peerRange] of Object.entries(allPeers)) {
                            if (resolved.has(peerName) || seen.has(peerName))
                                continue;
                            const peerFail = lookupReject(peerName);
                            const peerWarn = shouldWarnSkipTransitive(peerName);
                            const peerReject = peerFail || peerWarn;
                            if (peerReject) {
                                const reason = `optional peer in REJECT_INSTALL: ${peerName} — ${peerReject.reason}`;
                                log(`[resolve-fanout] [skip] ${peerName} — ${reason}`);
                                emitRegistryEvent({ type: 'transitive-skip', from: peerName, reason });
                                continue;
                            }
                            topLevelNames.add(peerName);
                            bestEffortNames.add(peerName);
                            queue.push([peerName, peerRange]);
                        }
                    }
                }
            }
            layerN++;
        }
        // End-of-walk: flush all cache writes in one RPC-equivalent call
        // (this.cache is a SQLite handle; one putRegistryEntries call =
        // O(N) prepared statements within a single DO event-loop turn,
        // atomically committed by the storage layer).
        let cacheWriteCount = 0;
        if (cacheWritesPending.length > 0) {
            const r = this.cache.putRegistryEntries(cacheWritesPending);
            cacheWriteCount = r.written;
            if (r.failed > 0)
                log(`  resolver-fanout cache write: ${r.failed} entries failed`);
        }
        // Diag/counters: same shape the supervisor's r2-race telemetry expects.
        recordR2RaceCounters({
            pipelinedTarballRaceWins: 0,
            pipelinedTarballRaceLosses: 0,
            pipelinedPackumentRaceWins: r2Wins,
            pipelinedPackumentRaceLosses: r2Losses,
        });
        // cache-obs-2: fold all per-tier cache events from this walk into
        // the DO singleton. Visible at /api/_diag/cache.
        recordCacheStatEvents(fanoutCacheStatEvents);
        const r2WinSuffix = r2Wins > 0 ? `, R2 packument cache wins=${r2Wins}/${r2Wins + r2Losses}` : '';
        log(`  resolver-fanout: ${resolved.size} resolved, ` +
            `${totalPackumentsDecoded} packuments fetched (` +
            `${(totalPackumentBytes / (1024 * 1024)).toFixed(1)} MiB), ` +
            `peak in-flight=${inFlightPeak}, ` +
            `cache writes=${cacheWriteCount}` +
            r2WinSuffix +
            `, layers=${totalLayers} [${layerProfile.join(' ')}]` +
            `, dispatch barriers=${dispatchBarriers}, ` +
            `elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s` +
            (unresolved.size > 0 ? `, unresolved=${unresolved.size}` : ''));
        return { resolved, unresolved };
    }
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
    async fetchViaBatchFacet(toFetch, hoistPlan, nmDir, pid) {
        const log = (msg) => this.onProgress?.(msg);
        const installed = [];
        const failed = [];
        let filesWritten = 0;
        const mtime = Date.now();
        // Every entry in `toFetch` has a tarball URL — the diff phase fails
        // the ones that don't rather than dropping them.
        const specs = toFetch
            .map((p) => ({
            name: p.name,
            version: p.version,
            tarballUrl: p.tarballUrl,
            integrity: p.integrity || '',
            pkgDir: nmDir + '/' + p.name,
            installRoot: nmDir,
            mtime,
            chunkSize: CHUNK_SIZE,
        }));
        // hoistPlan is intentionally unused: the current installer maps
        // every package to `${nmDir}/${name}` (flat hoisting). Accepting
        // the plan as a parameter keeps the caller agnostic of the hoist
        // strategy and lets a future nested-install variant slot in
        // without changing the call site.
        void hoistPlan;
        if (specs.length === 0) {
            return { installed, failed, filesWritten };
        }
        // One shard per package up to the peer cap, which is monotonic
        // non-decreasing in package count by construction. Previously a
        // 200-package threshold selected between a 32-shard cap and an 8-shard
        // cap, which ran backwards — 199 packages got 32 shards while 201 got 8,
        // so the smaller install paid the larger fan-out, and a 123-package
        // install spent its whole fetch+write phase in six dispatch barriers of
        // ~6 packages each.
        //
        // Each shard does substantial tarball decode and VFS write work, and eight
        // is where added shards stop buying throughput and start buying peer-DO
        // cold starts. Deliberately not tied to FANOUT_PHASE_SIZE: that width
        // bounds how many peers start *at once* under account-wide concurrency,
        // while this bounds how many a single install starts at all. Collapsing
        // the two made the phase width control install parallelism, so widening it
        // for latency widened the cold-start burst along with it.
        const INSTALL_PEER_CAP = 8;
        const shardCount = Math.min(specs.length, INSTALL_PEER_CAP);
        // Round-robin assignment: spec at pkgIdx → shard pkgIdx % shardCount.
        // This produces ⌈specs.length / shardCount⌉ specs per shard at
        // most, with the imbalance bounded to ±1.
        const shards = Array.from({ length: shardCount }, () => []);
        specs.forEach((spec, idx) => {
            shards[idx % shardCount].push(spec);
        });
        const nonEmptyShards = shards.filter((s) => s.length > 0);
        const topology = nonEmptyShards.length < IN_DO_THRESHOLD ? 'in-do (in-DO fanout)' : 'peer-do (peer-DO fanout)';
        log(`Dispatching ${specs.length} packages across ${nonEmptyShards.length} ` +
            `shard${nonEmptyShards.length === 1 ? '' : 's'} (${topology}, internal pLimit=3)...`);
        // Peer shards dispatch in bounded phases and each phase is a barrier, so
        // the phase profile is what distinguishes shard work from barrier count.
        const phaseProfile = [];
        const fanoutPool = new NimbusFanoutPool(this.env, this.ctx, {
            tag: 'npm-install-batch',
            // Whole-batch timeout. With per-shard parallelism of N=8 peer
            // DOs each running pLimit(3), Mossaic-class 456 packages
            // typical 30-60 s wall clock. 10 min covers pathological cases.
            timeoutMs: 10 * 60_000,
            // W7: tar-stream + W7-frame preambles concatenated. Forwarded
            // to every facet (in-DO and per-peer) so each shard's facet
            // can encode its own write-batch stream.
            preamble: TAR_STREAM_PREAMBLE + '\n' + W7_FRAME_PREAMBLE,
            // Authorize each facet's writeBatchStream under the invoking
            // process credential; without a positive pid the supervisor
            // rejects the write (S2a cred enforcement).
            supervisorPid: pid,
            onDispatchPhase: (width, elapsedMs) => phaseProfile.push(`${width}@${elapsedMs}ms`),
        });
        const tasks = nonEmptyShards.map((shardSpecs, shardIdx) => ({
            // Stable-id router key. Same shardIdx → same peer DO across
            // runs. Tests can predict placement via NimbusFanoutPool's
            // `peerSiblingId(key, peerCount)` helper.
            key: `shard-${shardIdx}`,
            args: { packages: shardSpecs, concurrency: 3 },
        }));
        let shardResults;
        try {
            try {
                shardResults = await fanoutPool.submitMany(tasks, installPackagesInFacet);
            }
            catch (e) {
                const msg = `${describeError(e)} (${tasks.length} shard${tasks.length === 1 ? '' : 's'}, ${fanoutPool.topologyFor(tasks.length)})`;
                log(`  [batch-fanout] aborted: ${msg}`);
                // Mark all packages failed; surface to caller to set non-zero exit.
                for (const s of specs)
                    failed.push(`${s.name}@${s.version}`);
                throw new Error(`batch-fanout install failed: ${msg}`, { cause: e });
            }
            // Merge per-shard InstallBatchResult into a single result for
            // the rest of the function. Maintain input order: the
            // round-robin sharding means perPackage entries are NOT in
            // input order, but the rest of fetchViaBatchFacet uses set
            // semantics (installed/failed are unordered string lists,
            // filesWritten is summed) so we don't need to re-order.
            const result = {
                perPackage: shardResults.flatMap((r) => r.perPackage),
                elapsed: Math.max(...shardResults.map((r) => r.elapsed)),
                facetCounters: mergeFacetCounters(shardResults.map((r) => r.facetCounters)),
                // cache-obs-2: merge per-shard cacheStatEvents (flat
                // concatenation). Each shard's events are independent.
                cacheStatEvents: shardResults.flatMap((r) => r.cacheStatEvents),
            };
            let okCount = 0;
            let failCount = 0;
            const reported = new Set();
            const specByPackage = new Map(specs.map((s) => [`${s.name}@${s.version}`, s]));
            for (const r of result.perPackage) {
                reported.add(`${r.name}@${r.version}`);
                // One `npm http` line per tarball, reporting the tier that served it.
                const spec = specByPackage.get(`${r.name}@${r.version}`);
                if (spec && r.tarballSource) {
                    this.npmLog('http', r.tarballSource === 'registry'
                        ? npmHttpFetchLine(spec.tarballUrl, r.tarballElapsedMs ?? 0)
                        : npmHttpCacheLine(spec.tarballUrl, spec.integrity || undefined));
                }
                if (r.errorText) {
                    failed.push(`${r.name}@${r.version}`);
                    log(`  [warn] ${r.name}@${r.version}: ${r.errorText}`);
                    failCount++;
                    continue;
                }
                installed.push(`${r.name}@${r.version}`);
                filesWritten += r.fileCount;
                if (r.warnings && r.warnings.length > 0) {
                    for (const w of r.warnings) {
                        log(`  [warn] ${r.name}@${r.version}: ${w}`);
                    }
                }
                okCount++;
            }
            // Every dispatched spec must come back with a verdict. A shard that
            // returns short would otherwise leave its packages in neither list,
            // which is the same silent partial one layer down.
            for (const s of specs) {
                const id = `${s.name}@${s.version}`;
                if (reported.has(id))
                    continue;
                failed.push(id);
                failCount++;
                log(`  [warn] ${id}: install shard returned no result for this package`);
            }
            // Fold facet counters into the supervisor's diagnostic state.
            recordInstallFacetCounters(result.facetCounters);
            // [W4] Fold tarball R2 race outcomes into supervisor diag.r2.
            const fc = result.facetCounters;
            recordR2RaceCounters({
                pipelinedTarballRaceWins: fc.pipelinedTarballRaceWins ?? 0,
                pipelinedTarballRaceLosses: fc.pipelinedTarballRaceLosses ?? 0,
                // Resolver counters folded separately at resolveTreeViaFanout().
                pipelinedPackumentRaceWins: 0,
                pipelinedPackumentRaceLosses: 0,
            });
            // cache-obs-2: fold per-tier tarball cache events into DO singleton.
            recordCacheStatEvents(result.cacheStatEvents);
            const r2WinSuffix = (fc.pipelinedTarballRaceWins ?? 0) > 0
                ? `, R2 cache wins=${fc.pipelinedTarballRaceWins}/${(fc.pipelinedTarballRaceWins ?? 0) + (fc.pipelinedTarballRaceLosses ?? 0)}`
                : '';
            log(`Batch-facet complete: ${okCount}/${specs.length} packages, ` +
                `${filesWritten} files, ` +
                `${(result.facetCounters.cumulativeBytesDecoded / (1024 * 1024)).toFixed(1)} MiB tarball bytes, ` +
                `peak in-flight=${result.facetCounters.peakInFlight}` +
                r2WinSuffix +
                `, R2 wait max=${fc.r2WaitMsMax ?? 0}ms` +
                `, registry fetches=${fc.speculativeFetches ?? 0}/${specs.length}` +
                `, write waves=${fc.sharedWaves} (worst shard stalled ` +
                `${(fc.sharedWaveMs / 1000).toFixed(1)}s)` +
                `, slowest shard ${(result.elapsed / 1000).toFixed(1)}s` +
                (phaseProfile.length > 0
                    ? `, dispatch phases=${phaseProfile.length} [${phaseProfile.join(' ')}]`
                    : '') +
                (failCount > 0 ? ` (${failCount} failed)` : ''));
            return { installed, failed, filesWritten };
        }
        catch (e) {
            // Final catch — preserved from the pre-fix shape so the error
            // log line shape stays consistent. NimbusFanoutPool's internal
            // pools dispose themselves at the end of each submitMany call,
            // so no explicit dispose() is needed here.
            // The earlier inner-catch already logged + threw; if we reach
            // here, the throw bubbled — re-throw to preserve the install
            // command's failure semantics.
            throw e instanceof Error ? e : new Error(describeError(e));
        }
    }
    // ── Spec building ─────────────────────────────────────────────────────
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
    async detectFrameworkAware(projDir) {
        try {
            const pkgPath = projDir + '/package.json';
            if (!this.vfs.exists(pkgPath))
                return false;
            const pkg = JSON.parse(this.vfs.readFileString(pkgPath));
            // Lazy-load the detector to avoid a hard dep cycle.
            const { detectFramework } = await import('../runtime/framework-detect.js');
            // Snapshot root files. Best-effort — if readdir throws we proceed
            // with an empty set (still detects via deps for most frameworks).
            const files = new Set();
            try {
                for (const e of this.vfs.readdir(projDir))
                    files.add(e.name);
            }
            catch { /* tolerate */ }
            // Optional file contents — read only the vite.config.* if present
            // (used by the Remix gate).
            const fileContents = {};
            for (const c of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
                if (files.has(c)) {
                    try {
                        fileContents[c] = this.vfs.readFileString(projDir + '/' + c);
                    }
                    catch { }
                }
            }
            const result = detectFramework({
                pkg: { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, scripts: pkg.scripts },
                files,
                fileContents,
            });
            return result.framework !== 'unknown';
        }
        catch {
            return false;
        }
    }
    async buildSpecs(projDir, explicitPackages, production) {
        const specs = {};
        if (explicitPackages && explicitPackages.length > 0) {
            // Explicit packages: npm install react react-dom@18.2.0
            for (const pkg of explicitPackages) {
                const parsed = parseExplicitPackageSpec(pkg);
                specs[parsed.name] = parsed.range;
            }
            return this.applyW6Registry(specs);
        }
        // Read from package.json
        const pkgJsonPath = projDir + '/package.json';
        if (!this.vfs.exists(pkgJsonPath))
            return specs;
        // Which names only a devDependency asked for, so a reject can say whether
        // anything this project RUNS actually needs the package it refused.
        const devOnly = new Set();
        try {
            const pkgJson = JSON.parse(this.vfs.readFileString(pkgJsonPath));
            // Always include dependencies
            for (const [name, range] of Object.entries(pkgJson.dependencies || {})) {
                if (!shouldSkipPackage(name)) {
                    specs[name] = range;
                }
            }
            // Include devDeps unless production mode, skipping build-only
            for (const [name, range] of Object.entries(pkgJson.devDependencies || {})) {
                if (shouldSkipPackage(name) || name in specs)
                    continue;
                if (production)
                    continue;
                specs[name] = range;
                devOnly.add(name);
            }
        }
        catch { /* corrupt package.json */ }
        return this.applyW6Registry(specs, devOnly);
    }
    /**
     * W6: apply the PACKAGE_ABI_POLICY swap rewrites and reject deny list
     * to a top-level spec map. Emits `[swap]` notices via onProgress; throws
     * a multi-line error on any reject (with `transitive='warn'` rejects
     * also failing at top level — they only soften at depth>0).
     *
     * Idempotent: running on already-swapped specs is a no-op.
     */
    applyW6Registry(specs, devOnly = new Set()) {
        const { specs: swapped, swaps } = applySwaps(specs);
        for (const s of swaps) {
            // onProgress is unguarded everywhere else in this file (rg the
            // pattern); singling it out for try/catch here would be inconsistent
            // and could mask real bugs in the progress hook.
            this.onProgress?.(formatSwapNotice(s));
            // W6.5: telemetry — fire-and-forget; sink swallows its own errors.
            emitRegistryEvent({ type: 'swap', from: s.from, to: s.to, ctx: 'top' });
        }
        const rejects = findRejects(swapped, 'top');
        if (rejects.length > 0) {
            // W6.5: emit one reject event per offending package BEFORE throwing,
            // so the telemetry sink sees them even if the install aborts.
            for (const r of rejects) {
                emitRegistryEvent({
                    type: 'reject',
                    from: r.from,
                    reason: r.reason,
                    suggest: r.suggest,
                    ctx: 'top',
                });
            }
            throw new RegistryRejectError(rejects, devOnly);
        }
        return swapped;
    }
    // ── Lockfile ──────────────────────────────────────────────────────────
    /**
     * Check if a lockfile is still valid against current package.json specs.
     */
    isLockfileValid(lockfile, specs) {
        // Every spec must be in the lockfile
        for (const name of Object.keys(specs)) {
            if (shouldSkipPackage(name))
                continue;
            if (!lockfile.has(name))
                return false;
        }
        // X.5-F R2: every locked package's REQUIRED peerDependencies must
        // also be in the lockfile. Lockfiles built before X.5-F lack peer
        // entries; we invalidate them so the next install re-resolves and
        // picks up peers (e.g. radix-react-dialog needs react+react-dom in
        // the tree, ts-jest needs typescript). The peer info comes from
        // the registry cache — if the cache miss happens too, we play it
        // safe and invalidate (forcing a fresh resolve which is correct).
        for (const [, entry] of lockfile) {
            const cached = this.cache.getRegistryEntry(entry.name, entry.resolvedVer);
            if (!cached) {
                // Registry cache miss for this locked entry — can't verify
                // peers. Invalidate to be safe (next install will repopulate
                // the registry cache while resolving).
                return false;
            }
            const peers = safeJsonParse(cached.peerDepsJson || '{}', {});
            for (const peerName of Object.keys(peers)) {
                if (!lockfile.has(peerName))
                    return false;
            }
        }
        return true;
    }
    /**
     * Convert a lockfile back to resolved packages (for cache restore).
     */
    lockfileToResolved(lockfile) {
        const resolved = new Map();
        for (const [name, entry] of lockfile) {
            // Reconstruct from registry cache
            const cached = this.cache.getRegistryEntry(name, entry.resolvedVer);
            if (cached) {
                resolved.set(name, {
                    name: cached.name,
                    version: cached.version,
                    tarballUrl: cached.tarballUrl,
                    integrity: cached.integrity,
                    dependencies: safeJsonParse(cached.depsJson, {}),
                    exports: safeJsonParse(cached.exportsJson, null),
                    main: cached.main,
                    module: cached.moduleField,
                    bin: safeJsonParse(cached.binJson, {}),
                });
            }
            else {
                // Registry cache miss — create minimal entry
                resolved.set(name, {
                    name,
                    version: entry.resolvedVer,
                    tarballUrl: '',
                    integrity: entry.integrity,
                    dependencies: safeJsonParse(entry.depsJson, {}),
                    exports: null,
                    main: '',
                    module: '',
                    bin: {},
                });
            }
        }
        return resolved;
    }
    /**
     * Write lockfile to SQLite.
     */
    writeLockfile(projDir, resolved, _hoistPlan, nmDir) {
        const entries = new Map();
        for (const [name, pkg] of resolved) {
            entries.set(name, {
                name,
                resolvedVer: pkg.version,
                integrity: pkg.integrity,
                depsJson: JSON.stringify(pkg.dependencies),
                hoistedPath: nmDir + '/' + name,
            });
        }
        this.cache.writeLockfile(projDir, entries, this.ctx);
    }
    // ── Bin linking ───────────────────────────────────────────────────────
    /**
     * Create node_modules/.bin/ entries for packages with "bin" fields.
     */
    async linkBins(resolved, nmDir) {
        const binDir = nmDir + '/.bin';
        const manifestEntries = [];
        for (const [, pkg] of resolved) {
            for (const binEntry of packageBinEntries(pkg, nmDir)) {
                manifestEntries.push(binEntry);
            }
        }
        if (manifestEntries.length === 0)
            return;
        const manifest = createNpmBinManifest(manifestEntries);
        const binEntries = [];
        const binChunks = [];
        const mtime = Date.now();
        for (const binEntry of Object.values(manifest.bins)) {
            const data = enc.encode(createNpmBinShim(binEntry));
            const linkPath = binDir + '/' + binEntry.name;
            binEntries.push({
                path: linkPath,
                parentPath: binDir,
                isDir: false,
                size: data.length,
                mtime,
                mode: 0o755,
                chunkCount: 1,
            });
            binChunks.push({ path: linkPath, chunkId: 0, data });
        }
        const manifestPath = npmBinManifestPath(nmDir);
        const manifestData = enc.encode(JSON.stringify(manifest, null, 2) + '\n');
        binEntries.push({
            path: manifestPath,
            parentPath: binDir,
            isDir: false,
            size: manifestData.length,
            mtime,
            mode: 0o644,
            chunkCount: 1,
        });
        binChunks.push({ path: manifestPath, chunkId: 0, data: manifestData });
        binEntries.push({
            path: binDir,
            parentPath: parentOf(binDir),
            isDir: true,
            size: 0,
            mtime,
            mode: 0o755,
            chunkCount: 0,
        });
        await this.writeStreamPayload({ inodes: binEntries, chunks: binChunks });
    }
    async writeStreamPayload(payload) {
        const result = await this.vfs.writeStream(encodeWriteBatchStream(payload));
        if (!result.ok) {
            throw new Error(`writeBatchStream failed after group ${result.committedGroupSequence} ` +
                `(${result.committedPathCount} committed paths): ${result.error.message}`);
        }
        return result;
    }
    // ── Package.json update ───────────────────────────────────────────────
    updatePackageJson(projDir, explicitPackages, resolved) {
        const pkgJsonPath = projDir + '/package.json';
        if (!this.vfs.exists(pkgJsonPath))
            return;
        try {
            const pkgJson = JSON.parse(this.vfs.readFileString(pkgJsonPath));
            if (!pkgJson.dependencies)
                pkgJson.dependencies = {};
            for (const spec of explicitPackages) {
                // Find the resolved package matching this spec
                const { name } = parseExplicitPackageSpec(spec);
                // W6: if a swap fired, the user typed `name` but `resolved` is
                // keyed by the swap target (e.g. user typed 'esbuild', resolved
                // has 'esbuild-wasm'). Look up via lookupSwap to bridge the
                // gap; write the user's original key into package.json so the
                // file remains the user's source-of-truth and isn't silently
                // mutated to the swap target (which would break cross-environment
                // pushes).
                let pkg = resolved.get(name);
                if (!pkg) {
                    const swap = lookupSwap(name);
                    if (swap)
                        pkg = resolved.get(swap.to);
                }
                if (pkg) {
                    pkgJson.dependencies[name] = '^' + pkg.version;
                }
            }
            this.vfs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
        }
        catch { /* skip if package.json is corrupt */ }
    }
    // ── Pre-bundling ──────────────────────────────────────────────────────
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
    async prebundleUsedModules(projDir, installed) {
        // Pre-bundle now runs in NimbusLoaderPool isolates (src/pre-bundle-facet.ts);
        // each facet ships its own bundled esbuild-wasm via the preamble. The
        // supervisor's EsbuildService is no longer on the bundle path — it
        // still serves the transform path (TS/JSX → JS) which is small and
        // fits in the supervisor's heap.
        //
        // We gate on this.esbuild presence purely as a feature flag: a caller
        // that constructs the installer without esbuild (e.g. minimal
        // headless test) opts out of pre-bundling entirely. ctx and env must
        // also be present because the facet pool needs them.
        if (!this.esbuild || !this.ctx || !this.env)
            return;
        const usedSpecifiers = this.scanBareImports(projDir);
        // Vite plugins / postcss plugins / build-time tools NEVER ship to the
        // browser — they're invoked server-side by vite's own plugin
        // pipeline. Pre-bundling them as browser modules is wasted work
        // and, for some plugins, fatal: e.g. @tailwindcss/vite (Tailwind
        // v4) triggers a `readdir(".")` inside esbuild's WASM during its
        // own init, hitting esbuild's "not implemented on js" fs shim.
        // The error is caught at the result.errorText layer, but the
        // surrounding heap churn from N concurrent pre-bundle attempts on a
        // 248-dep project pushes a shared isolate over the soft cap and
        // crashes the supervisor (Mini-PRD: DO shared isolate issues).
        //
        // Pattern matched against the package name (specifier root). Cases:
        //   - @vitejs/plugin-* — official vite plugins (react, vue, etc.)
        //   - vite-plugin-* — community vite plugins
        //   - @tailwindcss/vite, @tailwindcss/postcss — Tailwind v4
        //   - postcss, postcss-* — PostCSS pipeline
        //   - autoprefixer, cssnano — common postcss plugins
        //   - @rollup/plugin-* — vite uses rollup internally
        //   - lightningcss, esbuild, esbuild-* — bundlers themselves
        const isServerPluginPkg = (pkgName) => {
            if (pkgName === '@tailwindcss/vite' || pkgName === '@tailwindcss/postcss')
                return true;
            if (pkgName === 'postcss' || pkgName === 'autoprefixer' || pkgName === 'cssnano')
                return true;
            if (pkgName === 'lightningcss' || pkgName === 'esbuild' || pkgName === 'esbuild-wasm')
                return true;
            if (pkgName.startsWith('@vitejs/plugin-'))
                return true;
            if (pkgName.startsWith('vite-plugin-'))
                return true;
            if (pkgName.startsWith('postcss-'))
                return true;
            if (pkgName.startsWith('@rollup/plugin-'))
                return true;
            if (pkgName.startsWith('rollup-plugin-'))
                return true;
            return false;
        };
        // Determine which specifiers can actually be resolved to an installed package.
        const toBuild = usedSpecifiers.filter(spec => {
            const pkgName = spec.startsWith('@')
                ? spec.split('/').slice(0, 2).join('/')
                : spec.split('/')[0];
            if (isServerPluginPkg(pkgName))
                return false;
            return installed.has(pkgName);
        });
        if (toBuild.length === 0)
            return;
        const nmDir = projDir + '/node_modules';
        const pending = [];
        // Scan once up front; reused across barrel packages.
        const namedImports = scanNamedImports(this.vfs, projDir);
        for (const specifier of toBuild) {
            const existing = this.cache.getEsmBundle(specifier);
            const entryPath = this.resolvePackageEntryPath(specifier, nmDir);
            if (!entryPath)
                continue;
            if (/\.(wasm|node)$/i.test(entryPath)) {
                this.onProgress?.(`  skipped pre-bundle for ${specifier} (native/WASM)`);
                continue;
            }
            // Barrel-package heuristic. Count files under nmDir/<pkgName>
            // (excluding nested node_modules — those are deps walked
            // separately). Cheap: VFS readdir is sync + chunk-cached.
            const pkgName = packageNameFromSpecifier(specifier);
            const fileCount = countPackageFiles(this.vfs, nmDir + '/' + pkgName);
            const isBarrel = fileCount > BARREL_PKG_FILE_THRESHOLD;
            if (isBarrel && specifier === pkgName) {
                // Top-level barrel import. Synthesize.
                const names = namedImports.get(pkgName);
                const inputHash = namedImportSignature(pkgName, names);
                if (!names || names.size === 0) {
                    // No statically-resolvable imports. We refuse to bundle the
                    // whole barrel (would OOM) AND we refuse to CDN-fallback
                    // (contract). Skip pre-bundle here; the on-demand path will
                    // hard-error with a remediation message if a request comes
                    // in for it. Users who hit this need to add a static named
                    // import for the icons they reference dynamically.
                    this.onProgress?.(`  skipped pre-bundle for ${specifier}: barrel (${fileCount} files) ` +
                        `with no static named imports detected. Add explicit imports to enable bundling.`);
                    continue;
                }
                if (existing &&
                    existing.bundleHash === BUNDLER_VERSION &&
                    existing.inputHash === inputHash) {
                    continue;
                }
                const synth = buildSyntheticEntry(this.vfs, nmDir, pkgName, names);
                if (!synth)
                    continue;
                const entryPath = syntheticEntryPath(projDir, pkgName);
                try {
                    this.vfs.mkdir(entryPath.substring(0, entryPath.lastIndexOf('/')), { recursive: true });
                    this.vfs.writeFile(entryPath, synth.code);
                }
                catch (e) {
                    this.onProgress?.(`  failed to write synthetic entry for ${specifier}: ${e?.message || e}`);
                    continue;
                }
                this.onProgress?.(`  synthesized entry for ${specifier} (barrel: ${fileCount} files; ` +
                    `${names.size} static imports → tree-shaken bundle)`);
                pending.push({
                    specifier,
                    entryPath,
                    synthetic: true,
                    syntheticReferencedFiles: synth.referencedFiles,
                    inputHash: inputHash ?? '',
                });
                continue;
            }
            if (existing && existing.bundleHash === BUNDLER_VERSION && existing.inputHash === '')
                continue;
            pending.push({ specifier, entryPath });
        }
        if (pending.length === 0)
            return;
        // Log heap pressure entering pre-bundle so /api/_diag/memory's peak
        // tracker captures the supervisor baseline before the facet pool
        // takes over. After A′ lands the supervisor heap should stay flat
        // through this phase; if a future regression brings esbuild back
        // onto the supervisor we'll see it spike here.
        //
        // P5 (production reliability): switched from process.memoryUsage() to the
        // C'.1 deterministic estimator. process.memoryUsage() returns 0
        // for every field inside a Durable Object class context (only
        // dynamic-worker isolates under nodejs_compat get the real
        // implementation — see src/observability/diag-counters.ts:4 and
        // heap-estimate.ts:6). The previous "supervisor heap 0.0 MiB"
        // line was actively misleading: it printed every time, regardless
        // of what was actually in the heap, and could not be used to
        // verify the A′ memory-containment work the message claims to
        // surface. estimateSupervisorHeap sums known supervisor-side
        // allocation sources from runtime counters that ARE accurate
        // (DiagCounters singleton + SqliteVFS.getStats()).
        const memBefore = this._estimateSupervisorHeapMiB();
        this.onProgress?.(`Pre-bundling ${pending.length} modules... (supervisor heap ${memBefore.toFixed(1)} MiB)`);
        // ── Phase B+C: lazy slice + dispatch (memory-bounded) ─────────────
        //
        // CRITICAL: slices are built JUST BEFORE dispatch, NOT all at once.
        // Each slice can be up to SLICE_CAP_BYTES (28 MiB); with 8 pending
        // specs, a naïve "build all then map" would peak at 224 MiB in the
        // supervisor — well over the DO cap. Instead we run a hand-rolled
        // `concurrency`-way worker loop that picks the next pending spec,
        // builds its slice, submits to a facet, writes the result, then
        // frees both slice and result before picking the next.
        //
        // Peak supervisor footprint during this phase:
        //   max-in-flight = PRE_BUNDLE_CONCURRENCY (= 1)
        //   per-in-flight = up to SLICE_CAP_BYTES (28 MiB) slice + few-MiB
        //                   bundle output + spec metadata ≈ ~34 MiB
        //   peak ≈ 1 × 34 = 34 MiB worst case across ALL slots,
        //   plus ~30 MiB supervisor baseline = ~64 MiB.
        //
        // Why concurrency=1 (was 2 — see Mossaic crash repro):
        //   The previous concurrency=2 calculation assumed a strict 128 MiB
        //   per-DO budget. The Mini-PRD "DO shared isolate issues"
        //   documents resets at <128 MiB on shared isolates: multiple
        //   DOs from the same script can land in the same V8 isolate,
        //   sharing its 128 MiB cap. On a Mossaic-scale project (248 deps,
        //   31 pre-bundle specs, 12206 files), concurrency=2 + ongoing
        //   install/dev work pushed a shared isolate over the soft cap and
        //   crashed the supervisor (samples regression 9 -> 1 at t=24s
        //   reproduced on prod cde155f).
        //
        //   Cutting concurrency to 1 halves the peak slice footprint
        //   (28 MiB vs 56 MiB) at the cost of doubled wall-clock time —
        //   acceptable because pre-bundle is fire-and-forget and runs in
        //   the background. The user-visible install-command latency is
        //   unchanged. The on-demand bundler still serves any spec whose
        //   pre-bundle takes longer than the dev-server-needs-it window.
        //
        // Why SLICE_CAP_BYTES = 28 MiB:
        //   - 28 MiB × 1 concurrency = 28 MiB peak slice memory in the
        //     supervisor, + ~30 MiB baseline = ~58 MiB. Plenty of
        //     headroom under a shared-isolate budget.
        //   - 28 MiB also fits within workerd's 32 MiB RPC arg limit
        //     (structured-clone overhead measured ~6% on prior installs;
        //     28 + ~2 MiB overhead ≈ 30 MiB, under cap).
        //   - Cap was 16 MiB previously; lucide-react's 1500-file source
        //     tree exceeded that and got skipped from pre-bundle, then
        //     fell to the on-demand bundler which OOM'd the supervisor
        //     with CF error 1101 on /preview/@modules/lucide-react.
        //     Raising to 28 MiB lets lucide-react pre-bundle cleanly so
        //     the on-demand path is bypassed entirely for it. (Now
        //     lucide-react is barrel-skipped at af8de12 and the cap
        //     mostly applies to non-barrel large packages.)
        //
        // esbuild's WASM linear memory is per-FACET (~30–80 MiB) and lives
        // outside the supervisor. Per-slot try/catch handles failures —
        // /preview/@modules/ on-demand bundling recovers.
        // Fetch the esbuild-wasm bytes from the static-assets layer.
        // The supervisor briefly holds the 12 MiB ArrayBuffer between this
        // line and the LOADER hand-off below; after pool construction
        // returns, the only reference is inside workerd's loader cache
        // (where it should live). No supervisor-side caching — see
        // src/esbuild-wasm-bytes.ts for the full architectural rationale.
        //
        // Bytes are shipped into each facet via NimbusLoaderPool's
        // `wasmModules` option which workerd registers in the LOADER
        // `modules` map as `{ wasm: ArrayBuffer }`. Workerd compiles at
        // module-load (startup phase, where wasm code generation is
        // permitted), and the pool's generated worker.js exposes the
        // resulting WebAssembly.Module on globalThis.__NIMBUS_WASM
        // for the user fn (prebundleOne) to read at request time.
        //
        // Why this works when previous attempts didn't:
        //   - inlining bytes in preamble: 16 MiB per dispatch OOM'd
        //     supervisor (commit dead0e3 fixed by removing it)
        //   - WebAssembly.compile at request time: blocked by workerd
        //     ("Wasm code generation disallowed by embedder")
        //   - RPC of pre-compiled WebAssembly.Module: structured-clone
        //     refuses ("Unable to deserialize cloned data")
        //   - LOADER modules-map: bytes ride INSIDE the worker code blob
        //     before workerd compiles it; bypasses all three failure modes.
        //
        // Defensive logger: onProgress is user-supplied and can throw
        // (downstream WS write, JSON.stringify on a circular value, etc.).
        // A throw here would unwind through the iteration, drop other
        // slots' settled work, and surface in the supervisor as an
        // unhandled rejection. Swallow with a console.error so the
        // pre-bundle phase keeps running. Same pattern is used in the
        // pool dispose finally block below.
        const safeProgress = (msg) => {
            try {
                this.onProgress?.(msg);
            }
            catch (e) {
                try {
                    console.error('[pre-bundle] onProgress threw:', e?.message || e);
                }
                catch { }
            }
        };
        let pool;
        let retainedWasmRelease = null;
        const setupAllocation = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
        try {
            // No fallback: a missing wasm asset is a deploy bug. Surface loudly via
            // the thrown fetch error so this background phase aborts cleanly.
            const wasmBytes = await fetchEsbuildWasmBytes(this.env);
            const maxRetainedWasmBytes = SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES - PRE_BUNDLE_SLICE_CAP_BYTES;
            if (wasmBytes.byteLength > maxRetainedWasmBytes) {
                throw new RangeError(`pre-bundle wasm payload ${wasmBytes.byteLength} exceeds the ${maxRetainedWasmBytes}-byte retained budget`);
            }
            // NimbusLoaderPool keeps the constructor-time module bytes until
            // dispose(), so retain their exact credit rather than treating
            // construction as a handoff that immediately frees the ArrayBuffer.
            setupAllocation.shrinkTo(wasmBytes.byteLength);
            try {
                pool = new NimbusLoaderPool(this.env, this.ctx, {
                    concurrency: PRE_BUNDLE_CONCURRENCY,
                    timeoutMs: 60_000,
                    retries: 0,
                    tag: 'pre-bundle',
                    preamble: PRE_BUNDLE_PREAMBLE,
                    wasmModules: { 'esbuild.wasm': wasmBytes },
                });
                retainedWasmRelease = setupAllocation.release;
            }
            catch (e) {
                // Pool construction failures remain best-effort pre-bundle failures,
                // not npm install failures.
                safeProgress(`Pre-bundle skipped: failed to construct facet pool: ${e?.message || e}`);
                return;
            }
        }
        finally {
            if (!retainedWasmRelease)
                setupAllocation.release();
        }
        const queue = pending.slice(); // copy; will shift
        let okCount = 0;
        let attempted = 0;
        let errorCount = 0;
        let skippedCount = 0;
        // Per-module error map for THIS batch. Replaces (not aggregates)
        // diag-counters.preBundleFacet.errorsByModule on phase end so
        // /api/_diag/memory surfaces "which modules failed THIS time" —
        // critical for distinguishing lucide-react vs framer-motion vs
        // others when investigating supervisor crashes. Bounded by
        // pending.length.
        const errorsByModule = {};
        const runSlot = async (slotIndex) => {
            while (true) {
                const next = queue.shift();
                if (!next)
                    return;
                // Hold the slice's worst-case supervisor footprint until its facet
                // RPC and cache write settle. FIFO byte credit prevents VFS reads,
                // streamed install writes, or cirrus boot from independently claiming
                // the same shared-isolate headroom.
                const allocationLease = await acquireSupervisorAllocation(PRE_BUNDLE_SLICE_CAP_BYTES);
                try {
                    attempted++;
                    // Build slice for THIS spec only. Released by explicit nulling
                    // at the end of every code path through this iteration so the
                    // bytes are GC-eligible before pool.submit's RPC layer has
                    // finished tearing down its own references for the previous
                    // slot. With concurrency=1 and 28 MiB caps, peak supervisor
                    // slice memory is ~34 MiB (slice + spec metadata).
                    //
                    // Defensive: buildSliceForSpecifierWithCap performs sync VFS
                    // reads that COULD throw on a corrupted inode tree, an unread-
                    // able chunk, or any other VFS-layer surprise. Without this
                    // try/catch, a slice-walker throw escapes runSlot, rejects the
                    // Promise.all, drops every other in-flight slot's settled
                    // work, and surfaces in the supervisor as an unhandled
                    // rejection — which workerd can promote to a DO restart on a
                    // shared isolate. Catch and treat as "skip this spec, log,
                    // continue."
                    let slice = null;
                    try {
                        if (next.synthetic && next.syntheticReferencedFiles) {
                            // SCOPED slice: only the files the synthetic entry directly
                            // references + their transitive relative imports + the
                            // package's package.json. Skips the full package walk so
                            // icon-libraries with thousands of files don't blow the
                            // 28 MiB cap. (lucide-react@0.460 ships ~5-15 MiB across
                            // 3940 files; full walk hits cap on Mossaic-scale projects
                            // with 70+ imported icons.)
                            const scoped = buildScopedSliceForSynthetic(this.vfs, nmDir, packageNameFromSpecifier(next.specifier), next.syntheticReferencedFiles);
                            const built = { slice: scoped.entries, totalBytes: scoped.totalBytes };
                            // Append the synthetic entry file itself (lives outside
                            // the package dir; the scoped walker doesn't pick it up).
                            const bytes = this.vfs.readFile(next.entryPath);
                            const parentDir = next.entryPath.substring(0, next.entryPath.lastIndexOf('/'));
                            built.slice.push({
                                path: '/' + parentDir.replace(/^\/+/, ''),
                                isDir: true,
                            });
                            built.slice.push({
                                path: '/' + next.entryPath.replace(/^\/+/, ''),
                                bytes,
                                isDir: false,
                            });
                            built.totalBytes += bytes.length + next.entryPath.length;
                            slice = built;
                        }
                        else {
                            slice = buildSliceForSpecifierWithCap(this.vfs, next.specifier, nmDir, PRE_BUNDLE_SLICE_CAP_BYTES);
                        }
                    }
                    catch (e) {
                        const msg = e?.message || String(e);
                        safeProgress(`  pre-bundle slice walk threw for ${next.specifier}: ${msg}`);
                        errorCount++;
                        errorsByModule[next.specifier] = msg;
                        continue;
                    }
                    if (!slice) {
                        safeProgress(`  skipped pre-bundle for ${next.specifier}: slice exceeded ${(PRE_BUNDLE_SLICE_CAP_BYTES / (1024 * 1024)).toFixed(0)} MiB cap`);
                        skippedCount++;
                        continue;
                    }
                    // externalsForSpecifier is pure JS over a small list — extremely
                    // unlikely to throw, but cheap to guard since we're hardening
                    // this path comprehensively.
                    let externals;
                    try {
                        externals = externalsForSpecifier(next.specifier);
                    }
                    catch (e) {
                        const msg = e?.message || String(e);
                        safeProgress(`  pre-bundle externals threw for ${next.specifier}: ${msg}`);
                        errorCount++;
                        errorsByModule[next.specifier] = msg;
                        continue;
                    }
                    let spec = {
                        specifier: next.specifier,
                        entryPath: next.entryPath,
                        externals,
                        slice: slice.slice,
                        bundlerVersion: BUNDLER_VERSION,
                    };
                    // Drop our supervisor-side reference to the slice array as soon
                    // as it's owned by `spec`. `spec` is the only thing that needs
                    // to keep it alive until the RPC structured-clone completes.
                    slice = null;
                    let result = null;
                    try {
                        // pool.submit is per-task (no auto slot pinning). All slots
                        // share slot index 0 in the underlying #dispatchSlot — that's
                        // fine for our use (we don't need stable warm slots beyond
                        // "esbuild compiled once per slot's lifetime"; for pre-bundle
                        // the slot HAS to compile esbuild on first call regardless).
                        result = await pool.submit(prebundleOne, spec);
                    }
                    catch (e) {
                        const msg = describeError(e);
                        safeProgress(`  pre-bundle failed for ${next.specifier}: ${msg}`);
                        errorCount++;
                        errorsByModule[next.specifier] = msg;
                    }
                    finally {
                        // Drop the spec reference (which transitively held slice.slice)
                        // immediately after the RPC settles, regardless of outcome.
                        // pool.submit's facet-pool fix (timer leak) ensures the rejected
                        // promise's `args` aren't pinned by a 60s timer; this finally
                        // releases our supervisor-side handle the moment the await
                        // resolves so the next iteration starts from a low-water-mark
                        // heap. Combined defense — see commit msg.
                        spec = null;
                    }
                    if (!result || !result.ok) {
                        const why = result?.errorText || 'pool returned null';
                        if (result) {
                            safeProgress(`  pre-bundle failed for ${next.specifier}: ${why}`);
                            errorCount++;
                            errorsByModule[next.specifier] = why;
                        }
                        result = null;
                        continue;
                    }
                    if (result.warnings && result.warnings.length > 0) {
                        for (const w of result.warnings) {
                            safeProgress(`  [warn] ${next.specifier}: ${w}`);
                        }
                    }
                    // Stamp into pkg_esm_bundles. Cache is supervisor-side SQLite,
                    // so the write happens here (not via writeBatch — that's VFS).
                    // Defensive: SQL writes can throw on schema mismatch / disk-full
                    // / closed-storage-handle. A throw here would unwind through the
                    // loop and rejected the Promise.all wrapper. Treat the failure
                    // as "pre-bundle succeeded but cache write failed" — okCount is
                    // not bumped, the spec falls through to on-demand bundling on
                    // first request, and the loop continues.
                    try {
                        this.cache.putEsmBundle({
                            specifier: next.specifier,
                            bundleHash: BUNDLER_VERSION,
                            esmCode: result.esmCode,
                            builtAt: Date.now(),
                            inputHash: next.inputHash ?? '',
                        });
                        okCount++;
                    }
                    catch (e) {
                        const msg = e?.message || String(e);
                        safeProgress(`  pre-bundle cache-write failed for ${next.specifier}: ${msg}`);
                        errorCount++;
                        errorsByModule[next.specifier] = msg;
                    }
                    // result.esmCode is now durably in SQLite; drop our heap copy
                    // before the next iteration's slice walk allocates.
                    result = null;
                }
                finally {
                    allocationLease.release();
                }
                void slotIndex;
            }
        };
        try {
            // Promise.all rejects on the first slot rejection. Every per-slot
            // failure mode that can throw inside runSlot is caught above
            // (slice walk, externals, pool.submit, putEsmBundle) — but a
            // future regression that adds an unguarded throw to runSlot
            // would bubble out here. The outer try/finally guarantees
            // pool.dispose() runs and the diag counters get updated for
            // whatever partial run completed; the catch below additionally
            // logs so the failure mode is visible in supervisor logs.
            await Promise.all(Array.from({ length: PRE_BUNDLE_CONCURRENCY }, (_, i) => runSlot(i)));
        }
        catch (e) {
            const msg = e?.message || String(e);
            safeProgress(`Pre-bundle aborted: ${msg}`);
        }
        finally {
            // Fold pre-bundle outcomes into the diag counter singleton so
            // /api/_diag/memory surfaces them (commit 3 observability).
            // Aggregates across the DO's lifetime. Wrapped because
            // recordPreBundleSummary is a global-state mutator and a future
            // regression there could throw.
            try {
                recordPreBundleSummary({
                    attempted,
                    bundlesCompleted: okCount,
                    errors: errorCount,
                    skipped: skippedCount,
                    errorsByModule,
                });
            }
            catch (e) {
                try {
                    console.error('[pre-bundle] recordPreBundleSummary threw:', e?.message || e);
                }
                catch { }
            }
            // P5 (production reliability): switched both `memBefore` and `memAfter`
            // to the C'.1 deterministic estimator (see entry-point note
            // above). Both are floats in MiB; delta is post − pre.
            try {
                const memAfter = this._estimateSupervisorHeapMiB();
                const delta = memAfter - memBefore;
                safeProgress(`Pre-bundle complete: ${okCount}/${attempted} succeeded. (supervisor heap ${memAfter.toFixed(1)} MiB, Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} MiB)`);
            }
            catch (e) {
                try {
                    console.error('[pre-bundle] final-progress threw:', e?.message || e);
                }
                catch { }
            }
            try {
                pool.dispose();
            }
            catch { /* best-effort */ }
            retainedWasmRelease?.();
        }
    }
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
    scanBareImports(projDir) {
        const imports = new Set();
        const scanExts = new Set(['.ts', '.tsx', '.jsx', '.js', '.mjs']);
        // Files we deliberately skip at the project root: their imports run
        // server-side (vite plugins, postcss/tailwind config, etc.), never in
        // the browser, so pre-bundling their bare specifiers as if they were
        // browser modules is wasted work that exposes us to esbuild fs-shim
        // limits (e.g. @tailwindcss/vite triggers `readdir(".")` inside
        // esbuild → "Cannot read directory '.': not implemented on js" → the
        // ensuing combined heap pressure of 30+ pending pre-bundles + dev
        // start has been observed crashing the supervisor on Mossaic-scale
        // projects). The /preview/@modules/ path never serves these
        // specifiers; vite's own plugin resolver loads them at server boot.
        const isServerOnlyTopLevel = (name) => {
            // vite.config.ts/js/mjs/cjs and *.config.{ts,js,mjs,cjs} at the
            // project root. Limited to depth 0 to avoid filtering legitimate
            // browser code that happens to live under e.g. src/config/foo.ts.
            return /^(?:vite|vitest|astro|rollup|tsup|tailwind|postcss|prettier|eslint|stylelint|rolldown)\.config\.[mc]?[jt]s$/.test(name)
                || /\.config\.[mc]?[jt]s$/.test(name) && name.split('.').length === 3;
        };
        const walk = (dir, depth) => {
            if (depth > 5)
                return;
            try {
                for (const entry of this.vfs.readdir(dir)) {
                    if (entry.name === 'node_modules' || entry.name === '.git' ||
                        entry.name === 'dist' || entry.name === 'build')
                        continue;
                    const path = dir + '/' + entry.name;
                    if (entry.type === 'directory') {
                        walk(path, depth + 1);
                        continue;
                    }
                    // Server-only config files at the project root (depth 0) are
                    // skipped — their imports are not browser modules.
                    if (depth === 0 && isServerOnlyTopLevel(entry.name))
                        continue;
                    const dotIdx = entry.name.lastIndexOf('.');
                    if (dotIdx < 0)
                        continue;
                    const ext = entry.name.substring(dotIdx);
                    if (!scanExts.has(ext))
                        continue;
                    try {
                        const code = this.vfs.readFileString(path);
                        const re = /(?:from\s+|import\s*\(?\s*)["']([^./][^"']*?)["']/g;
                        let m;
                        while ((m = re.exec(code)) !== null) {
                            const spec = m[1];
                            // Keep the full specifier (including subpaths) so each is
                            // pre-bundled separately with the appropriate externals.
                            // Strip any trailing query string (?v=... etc.)
                            const clean = spec.split('?')[0];
                            imports.add(clean);
                            // Also add the top-level package name so its main entry is
                            // pre-bundled even if only a subpath was imported.
                            const pkgName = clean.startsWith('@')
                                ? clean.split('/').slice(0, 2).join('/')
                                : clean.split('/')[0];
                            imports.add(pkgName);
                        }
                        // If any .tsx/.jsx file is present and uses JSX automatic runtime
                        // (the default), esbuild injects imports from react/jsx-runtime
                        // even though the source never wrote them explicitly. Queue the
                        // runtime packages so they get pre-bundled with the correct
                        // externals.
                        if (ext === '.tsx' || ext === '.jsx') {
                            if (imports.has('react')) {
                                imports.add('react/jsx-runtime');
                                imports.add('react/jsx-dev-runtime');
                            }
                        }
                    }
                    catch { /* skip unreadable files */ }
                }
            }
            catch { /* skip unreadable dirs */ }
        };
        walk(projDir, 0);
        return [...imports];
    }
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
    resolvePackageEntryPath(specifier, nmDir) {
        // Parse out pkgName and subpath
        let pkgName;
        let subpath;
        if (specifier.startsWith('@')) {
            const parts = specifier.split('/');
            pkgName = parts.slice(0, 2).join('/');
            subpath = parts.slice(2).join('/');
        }
        else {
            const parts = specifier.split('/');
            pkgName = parts[0];
            subpath = parts.slice(1).join('/');
        }
        const pkgDir = nmDir + '/' + pkgName;
        const pkgJsonPath = pkgDir + '/package.json';
        if (!this.vfs.exists(pkgJsonPath))
            return null;
        try {
            const pkg = JSON.parse(this.vfs.readFileString(pkgJsonPath));
            // Use the full exports-field resolution with ESM browser conditions.
            // For subpath imports like "react/jsx-runtime", pass './jsx-runtime'.
            const subpathKey = subpath ? './' + subpath : '.';
            let entry = resolvePackageEntry(pkg, subpathKey);
            // Fallback: if no exports field or subpath not in exports, try direct
            // file resolution (e.g. "react/jsx-runtime" → "react/jsx-runtime.js").
            if (!entry && subpath) {
                entry = './' + subpath;
            }
            else if (!entry) {
                entry = 'index.js';
            }
            const entryPath = pkgDir + '/' + entry.replace(/^\.\//, '');
            // Try with extensions
            const exts = ['', '.js', '.mjs', '.ts', '.tsx', '.cjs'];
            for (const ext of exts) {
                if (this.vfs.exists(entryPath + ext) && !this.vfs.isDirectory(entryPath + ext)) {
                    return entryPath + ext;
                }
            }
            // Try index files
            if (this.vfs.isDirectory(entryPath)) {
                for (const idx of ['index.js', 'index.mjs', 'index.ts', 'index.cjs']) {
                    if (this.vfs.exists(entryPath + '/' + idx))
                        return entryPath + '/' + idx;
                }
            }
        }
        catch { /* skip */ }
        return null;
    }
    /** Monotonic count of transactionSync calls this DO's VFS has executed. */
    storageCommitCount() {
        return this.store.getStats().sql?.transactions?.durationMs?.count ?? 0;
    }
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
    _estimateSupervisorHeapMiB() {
        try {
            const counters = readDiagCounters();
            const vfsStats = this.store.getStats();
            const cacheStats = vfsStats.cache ?? {};
            const sqlStats = vfsStats.sql ?? {};
            const heap = estimateSupervisorHeap(counters, {
                cacheHotBytes: cacheStats.hotBytes ?? 0,
                inFlightWriteBytes: sqlStats.retainedWriteBytes?.current ?? 0,
            });
            return heap.estimatedBytes / (1024 * 1024);
        }
        catch {
            return 0;
        }
    }
}
// ── Helpers ─────────────────────────────────────────────────────────────
// P5 (production reliability): readSupervisorHeap() removed. It called
// process.memoryUsage() which returns 0 for every field inside a
// Durable Object class context (only dynamic-worker isolates under
// nodejs_compat get the real implementation — see
// src/observability/diag-counters.ts:4). The deterministic
// supervisor-heap estimator is the C'.1 replacement; see
// NpmInstaller._estimateSupervisorHeapMiB.
function parentOf(path) {
    return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
}
function parseExplicitPackageSpec(spec) {
    const aliasMarker = spec.indexOf('@npm:');
    if (aliasMarker > 0) {
        return {
            name: spec.slice(0, aliasMarker),
            range: 'npm:' + spec.slice(aliasMarker + '@npm:'.length),
        };
    }
    const rangeAt = findPackageRangeSeparator(spec);
    if (rangeAt >= 0) {
        return {
            name: spec.slice(0, rangeAt),
            range: spec.slice(rangeAt + 1) || 'latest',
        };
    }
    return { name: spec, range: 'latest' };
}
function findPackageRangeSeparator(spec) {
    if (!spec)
        return -1;
    if (spec[0] !== '@')
        return spec.indexOf('@');
    const slash = spec.indexOf('/');
    if (slash < 0)
        return -1;
    return spec.indexOf('@', slash + 1);
}
function safeJsonParse(json, fallback) {
    try {
        return JSON.parse(json);
    }
    catch {
        return fallback;
    }
}
/**
 * A warm install finishes in a few hundred ms, where a seconds-with-one-decimal
 * format rounds every phase to `0.0s` and the breakdown stops decomposing the
 * total it sits next to.
 */
function fmtPhaseMs(ms) {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
/**
 * Merge per-shard `facetCounters` arrays from a fanout install-batch.
 * Each shard's counters describe the work done by its peer DO's
 * facet; merging gives the supervisor a single aggregate to fold
 * into recordInstallFacetCounters / recordR2RaceCounters as if the
 * batch had run as a single facet (the pre-fanout posture).
 *
 * Aggregation rules:
 *   - tarballsCompleted, cumulativeBytesDecoded, race wins/losses:
 *     SUM (additive across shards).
 *   - peakInFlight: MAX (each shard observed its own peak; the
 *     overall peak is the max of those, since shards run in parallel
 *     across separate isolates and the supervisor never sees their
 *     in-flight sum at one moment).
 */
function mergeFacetCounters(perShard) {
    if (perShard.length === 0) {
        return {
            tarballsCompleted: 0,
            cumulativeBytesDecoded: 0,
            peakInFlight: 0,
            pipelinedTarballRaceWins: 0,
            pipelinedTarballRaceLosses: 0,
            r2WaitMsMax: 0,
            speculativeFetches: 0,
            sharedWaves: 0,
            sharedWaveMs: 0,
        };
    }
    return {
        tarballsCompleted: perShard.reduce((s, c) => s + (c.tarballsCompleted || 0), 0),
        cumulativeBytesDecoded: perShard.reduce((s, c) => s + (c.cumulativeBytesDecoded || 0), 0),
        peakInFlight: perShard.reduce((m, c) => Math.max(m, c.peakInFlight || 0), 0),
        pipelinedTarballRaceWins: perShard.reduce((s, c) => s + (c.pipelinedTarballRaceWins || 0), 0),
        pipelinedTarballRaceLosses: perShard.reduce((s, c) => s + (c.pipelinedTarballRaceLosses || 0), 0),
        // Shards wait on R2 concurrently, so the max is the wait the install
        // actually serialized behind.
        r2WaitMsMax: perShard.reduce((m, c) => Math.max(m, c.r2WaitMsMax || 0), 0),
        speculativeFetches: perShard.reduce((s, c) => s + (c.speculativeFetches || 0), 0),
        sharedWaves: perShard.reduce((s, c) => s + (c.sharedWaves || 0), 0),
        // Shards run concurrently, so the per-shard stall times overlap. The
        // max is the shard that stalled longest, which is what the install's
        // wall time actually waits on; a sum would double-count.
        sharedWaveMs: perShard.reduce((m, c) => Math.max(m, c.sharedWaveMs || 0), 0),
    };
}
