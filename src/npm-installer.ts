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
 *   Phase 5: Write          — ONE transactionSync() per wave via writeBatch()
 *   Phase 6: Link bins      — create node_modules/.bin/ entries
 *   Phase 7: Pre-bundle     — scan source, esbuild used packages (background)
 *
 * Key invariants:
 *   - All VFS writes go through writeBatch() (never individual writeFile)
 *   - Tarball cache is per-package (name, version) — no cross-package dedup
 *   - Lockfile stored in SQLite (not JSON file)
 *   - ESM pre-bundles cached in SQLite for /@modules/ serving
 */

import type { SqliteVFS, BatchWritePayload, BatchInodeEntry } from './sqlite-vfs.js';
import type { EsbuildService } from './esbuild-service.js';
import { BUNDLER_VERSION } from './esbuild-service.js';
import { NpmCache, type LockfileEntry } from './npm-cache.js';
import {
  resolveTree, computeHoistPlan, shouldSkipPackage,
  type ResolvedPackage, type HoistPlan, type FetchFn,
} from './npm-resolver.js';
import {
  applySwaps, findRejects, lookupSwap,
  formatSwapNotice, RegistryRejectError,
  emitRegistryEvent,
} from './wasm-swap-registry.js';
import { resolvePackageEntry } from './_shared/exports-resolver.js';
import {
  fetchWaves, buildBatchPayload, buildCacheRestorePayload,
} from './npm-tarball.js';
import { NimbusFacetPool } from './parallel/facet-pool.js';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE } from './parallel/generated-workers.js';
import { fetchAndStagePackage, type FacetPackageSpec, type FacetPackageResult } from './npm-install-facet.js';
import {
  installPackagesInFacet,
  type InstallBatchSpec,
  type InstallBatchResult,
} from './npm-install-batch-facet.js';
import {
  setInstallPhase, setResolverPath,
  setInstallFacetPath, recordInstallFacetCounters,
  recordPreBundleSummary,
  recordR2RaceCounters,
} from './diag-counters.js';
import {
  resolveTreeInFacet,
  type ResolveFacetSpec,
  type ResolveFacetResult,
  type FacetCachedEntry,
} from './npm-resolve-facet.js';
import { NPM_RESOLVE_PREAMBLE } from './parallel/npm-resolve-preamble.js';
import {
  prebundleOne,
  buildSliceForSpecifierWithCap,
  externalsForSpecifier,
  type PrebundleSpec,
  type PrebundleResult,
} from './pre-bundle-facet.js';
import { PRE_BUNDLE_PREAMBLE } from './parallel/pre-bundle-preamble.js';
import { getEsbuildWasmBytes } from './esbuild-wasm-bytes.js';
import { CHUNK_SIZE } from './constants.js';
import { waitForLowAllocPressure } from './heavy-alloc-coord.js';
import { countPackageFiles, BARREL_PKG_FILE_THRESHOLD, packageNameFromSpecifier } from './barrel-detect.js';
import {
  scanNamedImports,
  buildSyntheticEntry,
  buildScopedSliceForSynthetic,
  syntheticEntryPath,
  type NamedImportMap,
} from './barrel-synthesizer.js';
import { enc } from './_shared/bytes.js';

// ── Types ───────────────────────────────────────────────────────────────

export type InstallPhase =
  | 'lock-check' | 'resolve' | 'hoist' | 'diff'
  | 'fetch' | 'write' | 'link-bins' | 'bundle' | 'done';

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
  phases: Record<string, number>; // phase → ms
}

// ── NpmInstaller ────────────────────────────────────────────────────────

export class NpmInstaller {
  private vfs: SqliteVFS;
  private cache: NpmCache;
  private esbuild: EsbuildService | null;
  private ctx: DurableObjectState | undefined;
  private env: any;
  private onProgress: ((msg: string) => void) | undefined;
  /**
   * Injectable fetch function. Required because DO fetch() hangs in
   * wrangler local dev. The caller (NimbusSession) provides a function
   * that routes fetches through a facet worker. Used only by the resolve
   * path (packument JSON) — tarball fetches happen inside the facet pool
   * when the feature flag is on, using the facet's own global fetch.
   */
  private fetchFn: FetchFn | undefined;

  constructor(
    vfs: SqliteVFS,
    sql: SqlStorage,
    opts?: {
      esbuild?: EsbuildService;
      ctx?: DurableObjectState;
      env?: any;
      onProgress?: (msg: string) => void;
      fetchFn?: FetchFn;
    },
  ) {
    this.vfs = vfs;
    this.cache = new NpmCache(sql);
    this.esbuild = opts?.esbuild ?? null;
    this.ctx = opts?.ctx;
    this.env = opts?.env;
    this.onProgress = opts?.onProgress;
    this.fetchFn = opts?.fetchFn;
  }

  /** Expose cache for external use (e.g., serveModule in vite-dev-server). */
  get npmCache(): NpmCache { return this.cache; }

  // ── Main entry point ──────────────────────────────────────────────────

  /**
   * Install packages for a project. Handles:
   * - Lockfile-based fast path (no network if lock is valid)
   * - Full resolution + fetch + write pipeline
   * - Incremental: only fetches/writes what changed
   */
  async install(
    projectDir: string,
    opts?: {
      packages?: string[];       // explicit packages (npm install react)
      production?: boolean;      // skip devDependencies
    },
  ): Promise<NpmInstallResult> {
    const start = Date.now();
    const projDir = projectDir.replace(/^\/+/, '').replace(/\/+$/, '');
    const nmDir = projDir + '/node_modules';
    const log = (msg: string) => this.onProgress?.(msg);

    // Reset phase to 'idle' on any exit path so /api/_diag/memory
    // never reports a stale phase after a crash unwound the install.
    // The DO reboot would zero this anyway; finally is defense against
    // a non-fatal mid-install throw.
    try { return await this._installInner(projDir, nmDir, opts, log, start); }
    finally { setInstallPhase('idle'); }
  }

  private async _installInner(
    projDir: string,
    nmDir: string,
    opts: { packages?: string[]; production?: boolean } | undefined,
    log: (msg: string) => void,
    start: number,
  ): Promise<NpmInstallResult> {
    const phases: Record<string, number> = {};
    const installed: string[] = [];
    const failed: string[] = [];
    let totalFiles = 0;
    let cachedHits = 0;

    // ── Phase 0: Lock-check ─────────────────────────────────────────
    setInstallPhase('idle');
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
    // See audit/sections/W11-plan.md §3.0.
    const frameworkAware = await this.detectFrameworkAware(projDir);
    if (frameworkAware) {
      log(`Framework detected — installing framework-required packages (vite, …).`);
    }

    const lockfile = this.cache.readLockfile(projDir);
    let resolved: Map<string, ResolvedPackage>;
    let usedLockfile = false;

    if (lockfile && !opts?.packages && this.isLockfileValid(lockfile, specs)) {
      log(`Lockfile valid (${lockfile.size} packages). Skipping resolution.`);
      resolved = this.lockfileToResolved(lockfile);
      usedLockfile = true;
      phases['lock-check'] = Date.now() - phaseStart;
    } else {
      if (lockfile && !opts?.packages) {
        log('Lockfile outdated. Re-resolving...');
      }
      phases['lock-check'] = Date.now() - phaseStart;

      // ── Phase 1: Resolve ──────────────────────────────────────────
      phaseStart = Date.now();
      setInstallPhase('resolve');
      const useFacetResolver = this.shouldUseFacetResolver();
      setResolverPath(useFacetResolver ? 'in-facet' : 'in-supervisor');
      log(`Resolving ${Object.keys(specs).length} dependencies (path: ${useFacetResolver ? 'facet' : 'in-supervisor'}, fetch: ${this.fetchFn ? 'facet-proxy' : 'global'})...`);

      if (useFacetResolver) {
        // Facet resolver runs in a worker without easy access to the VFS
        // detection result; we pass frameworkAware via an env var the
        // facet preamble reads. For now, mirror behaviour by also calling
        // the in-supervisor path's flag here.
        resolved = await this.resolveTreeViaFacet(specs, log, { frameworkAware });
      } else {
        resolved = await resolveTree(specs, this.cache, undefined, log, this.fetchFn, { frameworkAware });
      }
      phases['resolve'] = Date.now() - phaseStart;

      if (resolved.size === 0) {
        log('No packages resolved.');
        return {
          installed, failed: Object.keys(specs),
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
    const toFetch: ResolvedPackage[] = [];
    const toRestore: ResolvedPackage[] = [];

    for (const [, pkg] of resolved) {
      if (!pkg.tarballUrl) continue;
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
        } catch { /* corrupt package.json — reinstall */ }
      }

      // Check tarball cache
      if (this.cache.hasTarballCache(pkg.name, pkg.version)) {
        toRestore.push(pkg);
        cachedHits++;
      } else {
        toFetch.push(pkg);
      }
    }

    phases['diff'] = Date.now() - phaseStart;
    log(`To fetch: ${toFetch.length}, to restore: ${toRestore.length}, already installed: ${cachedHits - toRestore.length}`);

    // ── Phase 4+5: Fetch + Write (wave-based) ───────────────────────
    phaseStart = Date.now();
    setInstallPhase('fetch');

    // First, restore cached packages
    if (toRestore.length > 0) {
      log(`Restoring ${toRestore.length} packages from cache...`);
      // Process in waves to bound memory
      const RESTORE_WAVE = 20;
      for (let i = 0; i < toRestore.length; i += RESTORE_WAVE) {
        const wave = toRestore.slice(i, i + RESTORE_WAVE);
        const payload = buildCacheRestorePayload(wave, hoistPlan, nmDir, this.cache);
        const result = this.vfs.writeBatch(payload);
        totalFiles += result.inodes;
        for (const pkg of wave) {
          installed.push(`${pkg.name}@${pkg.version}`);
        }
      }
    }

    // Then, fetch + extract + write new packages.
    //
    // Two paths:
    //   (a) Facet pool (NIMBUS_FACET_NPM_INSTALL=1, default on): dispatch
    //       each package to its own isolate via NimbusFacetPool. Each
    //       facet fetches the tarball, verifies sha-integrity, streams
    //       the gunzip+tar into a writeBatch payload, and calls
    //       env.SUPERVISOR.writeBatch() exactly once. The supervisor's
    //       heap never holds a full tarball — only the inbound RPC
    //       payload, one package at a time. See WORKERD-CRASH.md (H2).
    //
    //   (b) Legacy wave path (NIMBUS_FACET_NPM_INSTALL=0): the old
    //       fetchWaves + buildBatchPayload loop that ran in-process on
    //       the supervisor. Retained as a rollback for any workerd
    //       regression we haven't anticipated. This path does NOT
    //       benefit from distributed-heap isolation, but it is known to
    //       be correct end-to-end prior to H2 (H1 streaming landed
    //       before this commit).
    if (toFetch.length > 0) {
      const useFacetPool = this.shouldUseFacetPool();
      const useBatchFacet = useFacetPool && this.shouldUseBatchFacet();
      const pathLabel = useBatchFacet
        ? 'batch-facet'
        : useFacetPool ? 'pool.map (legacy)' : 'legacy-waves';
      // Record path so /api/_diag/memory surfaces which dispatcher
      // served the request — useful for proving prod is on the new
      // architecture and not silently falling back.
      setInstallFacetPath(useBatchFacet ? 'batch-facet' : useFacetPool ? 'pool.map' : 'legacy-waves');
      log(`Fetching ${toFetch.length} packages... (path: ${pathLabel})`);
      if (useBatchFacet) {
        const batchResult = await this.fetchViaBatchFacet(toFetch, hoistPlan, nmDir);
        totalFiles += batchResult.filesWritten;
        for (const name of batchResult.installed) installed.push(name);
        for (const name of batchResult.failed) failed.push(name);
      } else if (useFacetPool) {
        const poolResult = await this.fetchViaFacetPool(toFetch, hoistPlan, nmDir);
        totalFiles += poolResult.filesWritten;
        for (const name of poolResult.installed) installed.push(name);
        for (const name of poolResult.failed) failed.push(name);
      } else {
        for await (const wave of fetchWaves(toFetch, this.cache, this.ctx, 15, log, this.fetchFn)) {
          if (wave.fetched.length > 0) {
            const payload = buildBatchPayload(wave.fetched, hoistPlan, nmDir);
            const result = this.vfs.writeBatch(payload);
            totalFiles += result.inodes;
            for (const f of wave.fetched) {
              installed.push(`${f.pkg.name}@${f.pkg.version}`);
            }
          }
          failed.push(...wave.failed);
        }
      }
    }

    phases['fetch+write'] = Date.now() - phaseStart;

    // ── Phase 6: Link bins ──────────────────────────────────────────
    phaseStart = Date.now();
    setInstallPhase('link-bins');
    this.linkBins(resolved, nmDir);
    phases['link-bins'] = Date.now() - phaseStart;

    // ── Write lockfile ──────────────────────────────────────────────
    if (!usedLockfile || opts?.packages) {
      this.writeLockfile(projDir, resolved, hoistPlan, nmDir);
    }

    // ── Update package.json if explicit packages were added ─────────
    if (opts?.packages && opts.packages.length > 0) {
      this.updatePackageJson(projDir, opts.packages, resolved);
    }

    this.vfs.flushAll();

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
      // Fire-and-forget. Capture rejections to log but never await.
      const prebundlePromise = this.prebundleUsedModules(projDir, resolved)
        .catch((e: any) => {
          // log() goes through onProgress which writes to the install
          // output channel — the user sees this in their npm install
          // tail. Safe to call from a background promise.
          log(`[npm] pre-bundle skipped: ${e?.message || String(e)}`);
        });
      // Mark `void` so the linter / human reader knows we intentionally
      // don't await this. The promise outlives the install command.
      void prebundlePromise;
      phases['bundle'] = Date.now() - phaseStart;
    }

    setInstallPhase('done');
    const elapsed = Date.now() - start;
    log(`Done! ${installed.length} packages, ${totalFiles} files in ${(elapsed / 1000).toFixed(1)}s`);
    if (cachedHits > 0) {
      log(`  (${cachedHits} from cache)`);
    }

    return { installed, failed, totalFiles, elapsed, cachedHits, phases };
  }

  // ── Facet-pool fetch path (H2) ────────────────────────────────────────

  /**
   * Feature flag: `NIMBUS_FACET_NPM_INSTALL` defaults to on. Read from env
   * (either a var binding at build-time or a hardcoded env string in
   * wrangler.jsonc). Any falsy literal value ('', '0', 'false') turns it
   * off; anything else (including the absence of the var, for back-compat
   * with deployed configs) leaves it on.
   */
  private shouldUseFacetPool(): boolean {
    // Guard: we need both env.LOADER for the pool AND ctx for SupervisorRPC
    // binding metadata. If either is missing, fall back to the legacy path.
    if (!this.env?.LOADER || !this.ctx) return false;
    const raw = (this.env as any)?.NIMBUS_FACET_NPM_INSTALL;
    if (raw === undefined || raw === null) return true; // default on
    const s = String(raw).toLowerCase();
    if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no') return false;
    return true;
  }

  /**
   * Whether the install phase uses the SINGLE-FACET batch path (one
   * dynamic worker for the whole install) vs. the legacy per-package
   * pool.map (4 workers in parallel). Default ON.
   *
   * Workerd has a per-DO cap on concurrent dynamic workers (~5-6
   * empirically; see WORKERD-CRASH.md). Each pool slot in pool.map
   * spawns its own loader entry; loader.get() entries are PERMANENT
   * for the DO lifetime (src/parallel/facet-pool.ts:328-348 — dispose()
   * only releases SUPERVISOR binding stubs, NOT the underlying worker).
   * Combine resolver-facet (1) + fetch-proxy (1) + install pool.map (4)
   * + pre-bundle (1) = 7 workers, tripping the cap with "Too many
   * concurrent dynamic workers" right when install-pool fires its 4th slot.
   *
   * Single-facet batch (this path) collapses install to 1 worker, same
   * pattern proven by resolver-facet (commit 9194998).
   *
   * Set NIMBUS_FACET_NPM_INSTALL_BATCH=0 to fall back to the legacy
   * pool.map path. Same emergency-rollback posture as
   * NIMBUS_FACET_NPM_INSTALL / NIMBUS_FACET_RESOLVER.
   */
  private shouldUseBatchFacet(): boolean {
    if (!this.env?.LOADER || !this.ctx) return false;
    const raw = (this.env as any)?.NIMBUS_FACET_NPM_INSTALL_BATCH;
    if (raw === undefined || raw === null) return true;
    const s = String(raw).toLowerCase();
    if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no') return false;
    return true;
  }

  /**
   * Whether the resolver phase runs in a NimbusFacetPool isolate.
   * Default ON so prod gets the OOM fix without a config change. Set
   * NIMBUS_FACET_RESOLVER=0 in wrangler.jsonc (or the env binding) to
   * fall back to the legacy in-supervisor resolveTree — useful as an
   * emergency rollback if the facet path surfaces a workerd quirk we
   * didn't anticipate. Same posture as NIMBUS_FACET_NPM_INSTALL.
   */
  private shouldUseFacetResolver(): boolean {
    if (!this.env?.LOADER || !this.ctx) return false;
    const raw = (this.env as any)?.NIMBUS_FACET_RESOLVER;
    if (raw === undefined || raw === null) return true; // default on
    const s = String(raw).toLowerCase();
    if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no') return false;
    return true;
  }

  /**
   * Resolve the dep graph in a NimbusFacetPool isolate. Mirrors the
   * legacy resolveTree contract: returns Map<name, ResolvedPackage>.
   *
   * Cache strategy: pre-load ALL cached registry entries from
   * pkg_registry_cache and ship them to the facet so cache hits don't
   * cost a fetch. For a fresh DO (cold session) this is empty. For
   * a warm DO with prior installs, it's bounded by the cache size —
   * we cap at MAX_CACHED_ENTRIES_INLINE to keep the RPC arg under
   * workerd's 32 MiB structured-clone cap.
   */
  private async resolveTreeViaFacet(
    specs: Record<string, string>,
    log: (msg: string) => void,
    opts: { frameworkAware?: boolean } = {},
  ): Promise<Map<string, ResolvedPackage>> {
    const frameworkAware = !!opts.frameworkAware;
    // Pre-load cached entries. Cached registry entries are ~500 B each;
    // cap at 5000 for ~2.5 MiB total. Facets that find a cache miss for
    // a transitive dep beyond this cap will simply re-fetch — same as
    // a cold session — which is correct, just slower for warm-cache
    // pathological cases. Threshold can be raised after we have prod
    // data on cache size distributions.
    const MAX_CACHED_ENTRIES_INLINE = 5000;
    const allCached = this.cache.dumpRegistryEntries(MAX_CACHED_ENTRIES_INLINE);
    const cachedEntries: FacetCachedEntry[] = allCached.map((e) => ({
      name: e.name,
      version: e.version,
      tarballUrl: e.tarballUrl,
      integrity: e.integrity,
      depsJson: e.depsJson,
      exportsJson: e.exportsJson,
      main: e.main,
      moduleField: e.moduleField,
      binJson: e.binJson,
      fetchedAt: e.fetchedAt,
    }));
    log(`  resolver-facet: shipping ${cachedEntries.length} cached entries`);

    const facetSpec: ResolveFacetSpec = {
      specs,
      cachedEntries,
      frameworkAware,
      // Concurrency 4 inside the facet (NOT 6 like the legacy in-supervisor
      // resolver). Worst-case 4 × ~20 MiB packument parse buffers = 80 MiB
      // transient peak inside the facet's 128 MiB cap. Concurrency 6 would
      // peak at ~120 MiB, leaving < 10 MiB headroom — same defense-in-depth
      // tradeoff we made in pre-bundle (concurrency 2 there because slices
      // are larger). If prod data shows we have margin, raise to 6.
      concurrency: 4,
      fetchTimeoutMs: 15_000,
      retries: 3,
    };

    const pool = new NimbusFacetPool(this.env, this.ctx!, {
      // One facet for the whole walk — the facet itself runs pLimit(6)
      // internally. Per the plan's topology choice; per-spec dispatch
      // would multiply cold-start costs across 456+ transitive deps.
      concurrency: 1,
      // The facet fetches up to ~456 packuments serially-ish (pLimit 6).
      // At ~1-2 s per packument worst case, total budget needs headroom.
      // 5 minutes is generous — typical real installs complete in 30-90 s.
      timeoutMs: 5 * 60_000,
      retries: 0,
      tag: 'npm-resolve',
      preamble: NPM_RESOLVE_PREAMBLE,
    });

    let result: ResolveFacetResult;
    try {
      try {
        result = await pool.submit<ResolveFacetSpec, ResolveFacetResult>(
          resolveTreeInFacet,
          facetSpec,
        );
      } catch (e: any) {
        const msg = e?.remoteMessage || e?.message || String(e);
        log(`  resolver-facet failed: ${msg}`);
        throw new Error(`resolver-facet failed: ${msg}`);
      }
    } finally {
      try { pool.dispose(); } catch { /* best-effort */ }
    }

    // Surface facet messages into the install log.
    for (const m of result.messages) log(m);
    // W6.5: drain telemetry events the facet collected and forward to
    // the registry sink. Defensive: older facet builds may not return
    // the field, so handle missing/undefined gracefully.
    const facetEvents = (result as any).registryEvents;
    if (Array.isArray(facetEvents)) {
      for (const ev of facetEvents) {
        try { emitRegistryEvent(ev); } catch { /* sink errors swallowed inside emitRegistryEvent */ }
      }
    }
    // [W4] Fold packument R2 race outcomes into supervisor diag.r2.
    const rfc: any = result.facetCounters;
    recordR2RaceCounters({
      pipelinedTarballRaceWins: 0,
      pipelinedTarballRaceLosses: 0,
      pipelinedPackumentRaceWins: rfc.pipelinedPackumentRaceWins ?? 0,
      pipelinedPackumentRaceLosses: rfc.pipelinedPackumentRaceLosses ?? 0,
    });
    const r2WinSuffix = (rfc.pipelinedPackumentRaceWins ?? 0) > 0
      ? `, R2 packument cache wins=${rfc.pipelinedPackumentRaceWins}/${(rfc.pipelinedPackumentRaceWins ?? 0) + (rfc.pipelinedPackumentRaceLosses ?? 0)}`
      : '';
    log(
      `  resolver-facet: ${result.resolved.length} resolved, ` +
      `${result.facetCounters.packumentsDecoded} packuments fetched (` +
      `${(result.facetCounters.cumulativeBytesDecoded / (1024 * 1024)).toFixed(1)} MiB), ` +
      `peak in-flight=${result.facetCounters.inFlightPeak}, ` +
      `cache writes=${result.cacheWriteCount}` +
      r2WinSuffix +
      `, elapsed=${(result.elapsed / 1000).toFixed(1)}s`,
    );

    const resolved = new Map<string, ResolvedPackage>();
    for (const pkg of result.resolved) resolved.set(pkg.name, pkg);
    return resolved;
  }

  /**
   * Single-facet batch install. Builds per-package specs, dispatches
   * ONE facet via NimbusFacetPool.submit (concurrency=1), and lets the
   * facet loop internally with pLimit(3).
   *
   * One dynamic worker total. Combined with resolver-facet (1) and the
   * lazy fetch-proxy (0 when both facet paths default-on, see commit 2),
   * the install lifecycle peaks at 2 concurrent dynamic workers — well
   * under workerd's per-DO cap.
   */
  private async fetchViaBatchFacet(
    toFetch: ResolvedPackage[],
    hoistPlan: HoistPlan,
    nmDir: string,
  ): Promise<{ installed: string[]; failed: string[]; filesWritten: number }> {
    const log = (msg: string) => this.onProgress?.(msg);
    const installed: string[] = [];
    const failed: string[] = [];
    let filesWritten = 0;

    const mtime = Date.now();
    const specs: FacetPackageSpec[] = toFetch
      .filter((p) => !!p.tarballUrl)
      .map((p) => ({
        name: p.name,
        version: p.version,
        tarballUrl: p.tarballUrl,
        integrity: p.integrity || '',
        pkgDir: nmDir + '/' + p.name,
        mtime,
        chunkSize: CHUNK_SIZE,
      }));
    void hoistPlan; // flat hoisting only — see fetchViaFacetPool comment.

    if (specs.length === 0) {
      return { installed, failed, filesWritten };
    }

    log(`Dispatching ${specs.length} packages to batch-facet (single worker, internal pLimit=3)...`);

    const pool = new NimbusFacetPool(this.env, this.ctx!, {
      // ONE facet for the whole batch — collapses what was 4 concurrent
      // dynamic workers (pool.map slots) into 1. The facet itself runs
      // pLimit(3) to keep its heap peak under ~87 MiB inside its 128 MiB cap.
      concurrency: 1,
      // Whole-batch timeout. ~456 packages × ~0.5-2 s tarball download
      // = up to ~15 min worst case at pLimit=3. 10 min covers typical
      // installs comfortably; pathological networks fall through to the
      // catch path below.
      timeoutMs: 10 * 60_000,
      retries: 0,
      tag: 'npm-install-batch',
      // W7: tar-stream + W7-frame preambles concatenated. The batch
      // facet calls encodeWriteBatchStream() to produce a type:'bytes'
      // ReadableStream, then env.SUPERVISOR.writeBatchStream(stream) to
      // bypass the 32 MiB structured-clone cap on the bulk-write RPC.
      preamble: TAR_STREAM_PREAMBLE + '\n' + W7_FRAME_PREAMBLE,
    });

    let result: InstallBatchResult;
    try {
      try {
        result = await pool.submit<InstallBatchSpec, InstallBatchResult>(
          installPackagesInFacet,
          { packages: specs, concurrency: 3 },
          { timeoutMs: 10 * 60_000 },
        );
      } catch (e: any) {
        const msg = e?.remoteMessage || e?.message || String(e);
        log(`  [batch-facet] aborted: ${msg}`);
        // Mark all packages failed; surface to caller to set non-zero exit.
        for (const s of specs) failed.push(`${s.name}@${s.version}`);
        throw new Error(`batch-facet install failed: ${msg}`);
      }

      let okCount = 0;
      let failCount = 0;
      for (const r of result.perPackage) {
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

      // Fold facet counters into the supervisor's diag state so
      // /api/_diag/memory shows the install ran in the facet (the
      // smoking gun: cumulativeBytesDecoded grows on the FACET side
      // while the supervisor's cumulativePackumentBytesDecoded stays
      // flat).
      recordInstallFacetCounters(result.facetCounters);
      // [W4] Fold tarball R2 race outcomes into supervisor diag.r2.
      const fc: any = result.facetCounters;
      recordR2RaceCounters({
        pipelinedTarballRaceWins: fc.pipelinedTarballRaceWins ?? 0,
        pipelinedTarballRaceLosses: fc.pipelinedTarballRaceLosses ?? 0,
        // Resolver counters folded separately at resolveTreeViaFacet().
        pipelinedPackumentRaceWins: 0,
        pipelinedPackumentRaceLosses: 0,
      });
      const r2WinSuffix = (fc.pipelinedTarballRaceWins ?? 0) > 0
        ? `, R2 cache wins=${fc.pipelinedTarballRaceWins}/${(fc.pipelinedTarballRaceWins ?? 0) + (fc.pipelinedTarballRaceLosses ?? 0)}`
        : '';
      log(
        `Batch-facet complete: ${okCount}/${specs.length} packages, ` +
        `${filesWritten} files, ` +
        `${(result.facetCounters.cumulativeBytesDecoded / (1024 * 1024)).toFixed(1)} MiB tarball bytes, ` +
        `peak in-flight=${result.facetCounters.peakInFlight}` +
        r2WinSuffix +
        `, ${(result.elapsed / 1000).toFixed(1)}s` +
        (failCount > 0 ? ` (${failCount} failed)` : ''),
      );
      return { installed, failed, filesWritten };
    } finally {
      try { pool.dispose(); } catch { /* best-effort */ }
    }
  }

  private async fetchViaFacetPool(
    toFetch: ResolvedPackage[],
    hoistPlan: HoistPlan,
    nmDir: string,
  ): Promise<{ installed: string[]; failed: string[]; filesWritten: number }> {
    const log = (msg: string) => this.onProgress?.(msg);
    const installed: string[] = [];
    const failed: string[] = [];
    let filesWritten = 0;

    // Build per-package specs. Each gets its absolute install directory
    // resolved here (using hoistPlan) so the facet doesn't need the plan.
    // CHUNK_SIZE imported from ./constants.js (single source of truth).
    const mtime = Date.now();
    const specs: FacetPackageSpec[] = toFetch
      .filter((p) => !!p.tarballUrl)
      .map((p) => ({
        name: p.name,
        version: p.version,
        tarballUrl: p.tarballUrl,
        integrity: p.integrity || '',
        // hoistPlan.root is a Set<string> of names installed flat at nmDir;
        // current installer maps every package to `${nmDir}/${name}` (nested
        // installs are not yet implemented — see comment in buildBatchPayload).
        pkgDir: nmDir + '/' + p.name,
        mtime,
        chunkSize: CHUNK_SIZE,
      }));

    // Note: `hoistPlan` is intentionally unused in the current flat mapping
    // (see above). Accepting it in this method's signature keeps the caller
    // agnostic of the hoist strategy and lets a future nested-install
    // variant plug in without changing the call site. Silence the
    // unused-parameter warning.
    void hoistPlan;

    if (specs.length === 0) {
      return { installed, failed, filesWritten };
    }

    // 4 concurrent facets per H2 plan (guardrail #4). Each isolate gets its
    // own 128 MB budget on edge; in wrangler-dev all share one process but
    // memory is still distributed across isolates.
    const pool = new NimbusFacetPool(this.env, this.ctx!, {
      concurrency: 4,
      timeoutMs: 60_000,
      retries: 0,
      tag: 'npm-install',
      preamble: TAR_STREAM_PREAMBLE,
    });

    let done = 0;
    const total = specs.length;
    log(`Dispatching ${total} packages to ${pool.defaultConcurrency}-way facet pool...`);

    // Guardrail #8: onError 'throw' + retries 0 — install-time failures must
    // surface loudly, not be silently skipped. We wrap the whole map() in a
    // try so the caller sees which package failed and why. Other in-flight
    // facets are NOT cancelled (workerd RPC has no cancellation primitive),
    // but they complete into ignored results — the failed install is
    // reported immediately.
    //
    // The outer try/finally ensures pool.dispose() runs on BOTH the success
    // and failure paths so the SUPERVISOR binding's RPC stub is released
    // back to workerd. Without this, each install leaves a live stub in
    // the deferred-destruction queue; across a full session (git clone +
    // npm install + wrangler dev) that accumulation trips the
    // QueueState::ACTIVE fatal documented in
    // memory/nimbus-internal/INSTALL-PERSISTENCE-STATUS.md.
    let results: Array<Awaited<FacetPackageResult> | null>;
    try {
      try {
        results = await pool.map<FacetPackageSpec, FacetPackageResult>(
          fetchAndStagePackage,
          specs,
          { onError: 'throw' },
        );
      } catch (e: any) {
        const msg = e?.remoteMessage || e?.message || String(e);
        log(`  [facet-pool] aborted: ${msg}`);
        throw new Error(`facet-pool install failed: ${msg}`);
      }

      for (let i = 0; i < specs.length; i++) {
        const r = results[i];
        const spec = specs[i];
        if (!r) {
          // With onError:'throw' this branch is unreachable; defensive.
          failed.push(`${spec.name}@${spec.version}`);
          continue;
        }
        installed.push(`${r.name}@${r.version}`);
        filesWritten += r.fileCount;
        done += 1;
        if (r.warnings && r.warnings.length > 0) {
          for (const w of r.warnings) {
            log(`  [warn] ${r.name}@${r.version}: ${w}`);
          }
        }
      }

      log(`Facet pool complete: ${done}/${total} packages, ${filesWritten} files written.`);
      return { installed, failed, filesWritten };
    } finally {
      try { pool.dispose(); } catch { /* best-effort */ }
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
  private async detectFrameworkAware(projDir: string): Promise<boolean> {
    try {
      const pkgPath = projDir + '/package.json';
      if (!this.vfs.exists(pkgPath)) return false;
      const pkg = JSON.parse(this.vfs.readFileString(pkgPath));
      // Lazy-load the detector to avoid a hard dep cycle.
      const { detectFramework } = await import('./framework-detect.js');
      // Snapshot root files. Best-effort — if readdir throws we proceed
      // with an empty set (still detects via deps for most frameworks).
      const files = new Set<string>();
      try {
        for (const e of this.vfs.readdir(projDir)) files.add(e.name);
      } catch { /* tolerate */ }
      // Optional file contents — read only the vite.config.* if present
      // (used by the Remix gate).
      const fileContents: Record<string, string> = {};
      for (const c of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
        if (files.has(c)) {
          try { fileContents[c] = this.vfs.readFileString(projDir + '/' + c); } catch {}
        }
      }
      const result = detectFramework({
        pkg: { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, scripts: pkg.scripts },
        files,
        fileContents,
      });
      return result.framework !== 'unknown';
    } catch {
      return false;
    }
  }

  private async buildSpecs(
    projDir: string,
    explicitPackages?: string[],
    production?: boolean,
  ): Promise<Record<string, string>> {
    const specs: Record<string, string> = {};

    if (explicitPackages && explicitPackages.length > 0) {
      // Explicit packages: npm install react react-dom@18.2.0
      for (const pkg of explicitPackages) {
        const atIdx = pkg.lastIndexOf('@');
        if (atIdx > 0 && !pkg.startsWith('@')) {
          specs[pkg.substring(0, atIdx)] = pkg.substring(atIdx + 1);
        } else if (pkg.startsWith('@') && pkg.indexOf('@', 1) > 0) {
          const idx = pkg.indexOf('@', 1);
          specs[pkg.substring(0, idx)] = pkg.substring(idx + 1);
        } else {
          specs[pkg] = 'latest';
        }
      }
      return this.applyW6Registry(specs);
    }

    // Read from package.json
    const pkgJsonPath = projDir + '/package.json';
    if (!this.vfs.exists(pkgJsonPath)) return specs;

    try {
      const pkgJson = JSON.parse(this.vfs.readFileString(pkgJsonPath));

      // Always include dependencies
      for (const [name, range] of Object.entries(pkgJson.dependencies || {})) {
        if (!shouldSkipPackage(name)) {
          specs[name] = range as string;
        }
      }

      // Include devDeps unless production mode, skipping build-only
      if (!production) {
        for (const [name, range] of Object.entries(pkgJson.devDependencies || {})) {
          if (!shouldSkipPackage(name)) {
            specs[name] = range as string;
          }
        }
      }
    } catch { /* corrupt package.json */ }

    return this.applyW6Registry(specs);
  }

  /**
   * W6: apply WASM_SWAPS rewrites and REJECT_INSTALL deny list to a
   * top-level spec map. Emits `[swap]` notices via onProgress; throws
   * a multi-line error on any reject (with `transitive='warn'` rejects
   * also failing at top level — they only soften at depth>0).
   *
   * Idempotent: running on already-swapped specs is a no-op.
   */
  private applyW6Registry(specs: Record<string, string>): Record<string, string> {
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
      throw new RegistryRejectError(rejects);
    }
    return swapped;
  }

  // ── Lockfile ──────────────────────────────────────────────────────────

  /**
   * Check if a lockfile is still valid against current package.json specs.
   */
  private isLockfileValid(
    lockfile: Map<string, LockfileEntry>,
    specs: Record<string, string>,
  ): boolean {
    // Every spec must be in the lockfile
    for (const name of Object.keys(specs)) {
      if (shouldSkipPackage(name)) continue;
      if (!lockfile.has(name)) return false;
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
      const peers = safeJsonParse<Record<string, string>>(cached.peerDepsJson || '{}', {});
      for (const peerName of Object.keys(peers)) {
        if (!lockfile.has(peerName)) return false;
      }
    }
    return true;
  }

  /**
   * Convert a lockfile back to resolved packages (for cache restore).
   */
  private lockfileToResolved(
    lockfile: Map<string, LockfileEntry>,
  ): Map<string, ResolvedPackage> {
    const resolved = new Map<string, ResolvedPackage>();
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
      } else {
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
  private writeLockfile(
    projDir: string,
    resolved: Map<string, ResolvedPackage>,
    hoistPlan: HoistPlan,
    nmDir: string,
  ): void {
    const entries = new Map<string, LockfileEntry>();
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
  private linkBins(
    resolved: Map<string, ResolvedPackage>,
    nmDir: string,
  ): void {
    const binDir = nmDir + '/.bin';
    const binEntries: BatchInodeEntry[] = [];
    const binChunks: { path: string; chunkId: number; data: Uint8Array }[] = [];
    const mtime = Date.now();
    const dirs = new Set<string>();
    dirs.add(binDir);

    for (const [, pkg] of resolved) {
      if (!pkg.bin || Object.keys(pkg.bin).length === 0) continue;

      for (const [binName, binPath] of Object.entries(pkg.bin)) {
        const targetPath = nmDir + '/' + pkg.name + '/' + binPath.replace(/^\.\//, '');
        // Create a shell script that points to the target
        const script = `#!/usr/bin/env node\n// Bin link: ${binName} → ${targetPath}\nrequire('${targetPath}');\n`;
        const data = enc.encode(script);
        const linkPath = binDir + '/' + binName;

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
    }

    if (binEntries.length === 0) return;

    // Add directory inodes
    for (const dir of dirs) {
      binEntries.push({
        path: dir,
        parentPath: parentOf(dir),
        isDir: true,
        size: 0,
        mtime,
        mode: 0o755,
        chunkCount: 0,
      });
    }

    this.vfs.writeBatch({ inodes: binEntries, chunks: binChunks });
  }

  // ── Package.json update ───────────────────────────────────────────────

  private updatePackageJson(
    projDir: string,
    explicitPackages: string[],
    resolved: Map<string, ResolvedPackage>,
  ): void {
    const pkgJsonPath = projDir + '/package.json';
    if (!this.vfs.exists(pkgJsonPath)) return;

    try {
      const pkgJson = JSON.parse(this.vfs.readFileString(pkgJsonPath));
      if (!pkgJson.dependencies) pkgJson.dependencies = {};

      for (const spec of explicitPackages) {
        // Find the resolved package matching this spec
        const atIdx = spec.lastIndexOf('@');
        let name: string;
        if (spec.startsWith('@') && spec.indexOf('@', 1) > 0) {
          name = spec.substring(0, spec.indexOf('@', 1));
        } else if (atIdx > 0 && !spec.startsWith('@')) {
          name = spec.substring(0, atIdx);
        } else {
          name = spec;
        }

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
          if (swap) pkg = resolved.get(swap.to);
        }
        if (pkg) {
          pkgJson.dependencies[name] = '^' + pkg.version;
        }
      }

      this.vfs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    } catch { /* skip if package.json is corrupt */ }
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
  private async prebundleUsedModules(
    projDir: string,
    installed: Map<string, ResolvedPackage>,
  ): Promise<void> {
    // Pre-bundle now runs in NimbusFacetPool isolates (src/pre-bundle-facet.ts);
    // each facet ships its own bundled esbuild-wasm via the preamble. The
    // supervisor's EsbuildService is no longer on the bundle path — it
    // still serves the transform path (TS/JSX → JS) which is small and
    // fits in the supervisor's heap.
    //
    // We gate on this.esbuild presence purely as a feature flag: a caller
    // that constructs the installer without esbuild (e.g. minimal
    // headless test) opts out of pre-bundling entirely. ctx and env must
    // also be present because the facet pool needs them.
    if (!this.esbuild || !this.ctx || !this.env) return;

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
    const isServerPluginPkg = (pkgName: string): boolean => {
      if (pkgName === '@tailwindcss/vite' || pkgName === '@tailwindcss/postcss') return true;
      if (pkgName === 'postcss' || pkgName === 'autoprefixer' || pkgName === 'cssnano') return true;
      if (pkgName === 'lightningcss' || pkgName === 'esbuild' || pkgName === 'esbuild-wasm') return true;
      if (pkgName.startsWith('@vitejs/plugin-')) return true;
      if (pkgName.startsWith('vite-plugin-')) return true;
      if (pkgName.startsWith('postcss-')) return true;
      if (pkgName.startsWith('@rollup/plugin-')) return true;
      if (pkgName.startsWith('rollup-plugin-')) return true;
      return false;
    };

    // Determine which specifiers can actually be resolved to an installed package.
    const toBuild = usedSpecifiers.filter(spec => {
      const pkgName = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
      if (isServerPluginPkg(pkgName)) return false;
      return installed.has(pkgName);
    });

    if (toBuild.length === 0) return;

    const nmDir = projDir + '/node_modules';

    // ── Phase A: filter and resolve entry paths ────────────────────────
    // Drop specifiers we already have a fresh cache entry for, and the
    // ones whose entry resolves to a native/WASM payload (esbuild can't
    // parse those as JS — a package whose `main` points directly at
    // esbuild.wasm or a .node addon would otherwise fail at byte 0).
    //
    // For "barrel" packages — those that ship hundreds/thousands of
    // tiny re-export files (lucide-react@0.460: ~3940 files,
    // @phosphor-icons/react: similar, react-icons, @mui/icons-material,
    // @heroicons/react…) — we DON'T skip pre-bundle. Instead we
    // synthesize a tiny entry from the user's actual named-import set
    // (e.g. `export { Home, FileText, Zap } from 'lucide-react';`) and
    // bundle THAT through the standard facet path. esbuild tree-shakes
    // unreferenced exports, producing a small bundle (~5–20 KiB for a
    // typical icon set) shipped from our edge.
    //
    // This replaces the previous esm.sh CDN fallback (commit fc17847),
    // which violated the 100% edge contract by making the browser
    // fetch tree-shaken bytes from a third-party CDN. The synthesizer
    // is general-purpose and works for any barrel package whose
    // individual export files are side-effect-free.
    //
    // If the scanner found NO named imports for a barrel pkg
    // (e.g. user does `import * from 'pkg'`, computed-name access, or
    // dynamic import), the package is still queued via its real entry
    // — the bundle will OOM the facet, surface a hard error, and the
    // user sees a remediation message. NO silent CDN fallback.
    type PendingSpec = {
      specifier: string;
      entryPath: string;
      synthetic?: boolean;
      // For synthetic entries: the per-file paths the entry imports.
      // Used to build a SCOPED slice (skips the package's full
      // directory walk) so icon-libraries with thousands of files
      // don't blow the 28 MiB slice cap.
      syntheticReferencedFiles?: string[];
    };
    const pending: PendingSpec[] = [];
    // Scan once up front; reused across barrel packages.
    const namedImports: NamedImportMap = scanNamedImports(this.vfs, projDir);
    for (const specifier of toBuild) {
      const existing = this.cache.getEsmBundle(specifier);
      if (existing && existing.bundleHash === BUNDLER_VERSION) continue;

      const entryPath = this.resolvePackageEntryPath(specifier, nmDir);
      if (!entryPath) continue;

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
        if (!names || names.size === 0) {
          // No statically-resolvable imports. We refuse to bundle the
          // whole barrel (would OOM) AND we refuse to CDN-fallback
          // (contract). Skip pre-bundle here; the on-demand path will
          // hard-error with a remediation message if a request comes
          // in for it. Users who hit this need to add a static named
          // import for the icons they reference dynamically.
          this.onProgress?.(
            `  skipped pre-bundle for ${specifier}: barrel (${fileCount} files) ` +
            `with no static named imports detected. Add explicit imports to enable bundling.`,
          );
          continue;
        }
        const synth = buildSyntheticEntry(this.vfs, nmDir, pkgName, names);
        if (!synth) continue;
        const entryPath = syntheticEntryPath(projDir, pkgName);
        try {
          this.vfs.mkdir(entryPath.substring(0, entryPath.lastIndexOf('/')), { recursive: true });
          this.vfs.writeFile(entryPath, synth.code);
        } catch (e: any) {
          this.onProgress?.(
            `  failed to write synthetic entry for ${specifier}: ${e?.message || e}`,
          );
          continue;
        }
        this.onProgress?.(
          `  synthesized entry for ${specifier} (barrel: ${fileCount} files; ` +
          `${names.size} static imports → tree-shaken bundle)`,
        );
        pending.push({ specifier, entryPath, synthetic: true, syntheticReferencedFiles: synth.referencedFiles });
        continue;
      }

      pending.push({ specifier, entryPath });
    }
    if (pending.length === 0) return;
    // Log heap pressure entering pre-bundle so /api/_diag/memory's peak
    // tracker captures the supervisor baseline before the facet pool
    // takes over. After A′ lands the supervisor heap should stay flat
    // through this phase; if a future regression brings esbuild back
    // onto the supervisor we'll see it spike here.
    const memBefore = readSupervisorHeap();
    if (memBefore) {
      this.onProgress?.(
        `Pre-bundling ${pending.length} modules... (supervisor heap ${(memBefore.heapUsed / (1024 * 1024)).toFixed(1)} MiB)`,
      );
    } else {
      this.onProgress?.(`Pre-bundling ${pending.length} modules...`);
    }

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
    const PRE_BUNDLE_CONCURRENCY = 1;
    const SLICE_CAP_BYTES = 28 * 1024 * 1024;

    // Fetch the esbuild-wasm bytes once. Decoded once per supervisor
    // isolate; subsequent calls return the cached ArrayBuffer reference
    // so passing it across multiple pool dispatches is free.
    //
    // Bytes are shipped into each facet via NimbusFacetPool's
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
    // Defensive logger: onProgress is user-supplied and can throw
    // (downstream WS write, JSON.stringify on a circular value, etc.).
    // A throw here would unwind through the iteration, drop other
    // slots' settled work, and surface in the supervisor as an
    // unhandled rejection. Swallow with a console.error so the
    // pre-bundle phase keeps running. Same pattern is used in the
    // pool dispose finally block below.
    const safeProgress = (msg: string): void => {
      try { this.onProgress?.(msg); } catch (e: any) {
        try { console.error('[pre-bundle] onProgress threw:', e?.message || e); } catch {}
      }
    };

    let wasmBytes: ArrayBuffer | null = null;
    try {
      wasmBytes = await getEsbuildWasmBytes();
    } catch (e: any) {
      safeProgress(`Pre-bundle skipped: failed to load esbuild wasm bytes: ${e?.message || e}`);
      return;
    }

    let pool: NimbusFacetPool;
    try {
      pool = new NimbusFacetPool(this.env, this.ctx!, {
        concurrency: PRE_BUNDLE_CONCURRENCY,
        timeoutMs: 60_000,
        retries: 0,
        tag: 'pre-bundle',
        preamble: PRE_BUNDLE_PREAMBLE,
        wasmModules: { 'esbuild.wasm': wasmBytes },
      });
    } catch (e: any) {
      // Pool construction can throw if env bindings are missing or
      // wasm modules registration fails. Without this guard, the
      // throw escapes prebundleUsedModules's caller-side .catch
      // (npm-installer.ts:389) — which IS still safe but loses the
      // chance to record diag counters for the partial run. Bail
      // cleanly instead.
      safeProgress(`Pre-bundle skipped: failed to construct facet pool: ${e?.message || e}`);
      return;
    }

    const queue = pending.slice(); // copy; will shift
    let okCount = 0;
    let attempted = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let lastError = '';
    // Per-module error map for THIS batch. Replaces (not aggregates)
    // diag-counters.preBundleFacet.errorsByModule on phase end so
    // /api/_diag/memory surfaces "which modules failed THIS time" —
    // critical for distinguishing lucide-react vs framer-motion vs
    // others when investigating supervisor crashes. Bounded by
    // pending.length.
    const errorsByModule: Record<string, string> = {};

    const runSlot = async (slotIndex: number): Promise<void> => {
      while (true) {
        const next = queue.shift();
        if (!next) return;
        // Yield to heavy-alloc owners (today: cirrus-real boot path).
        // Non-blocking when no owner is active. Returns false on the
        // 30 s ceiling — we proceed regardless because the gate is a
        // best-effort reduction of peak pressure, not a correctness
        // dependency.
        await waitForLowAllocPressure();
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
        let slice: ReturnType<typeof buildSliceForSpecifierWithCap> = null;
        try {
          if (next.synthetic && next.syntheticReferencedFiles) {
            // SCOPED slice: only the files the synthetic entry directly
            // references + their transitive relative imports + the
            // package's package.json. Skips the full package walk so
            // icon-libraries with thousands of files don't blow the
            // 28 MiB cap. (lucide-react@0.460 ships ~5-15 MiB across
            // 3940 files; full walk hits cap on Mossaic-scale projects
            // with 70+ imported icons.)
            const scoped = buildScopedSliceForSynthetic(
              this.vfs, nmDir, packageNameFromSpecifier(next.specifier),
              next.syntheticReferencedFiles,
            );
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
          } else {
            slice = buildSliceForSpecifierWithCap(
              this.vfs, next.specifier, nmDir, SLICE_CAP_BYTES,
            );
          }
        } catch (e: any) {
          const msg = e?.message || String(e);
          safeProgress(`  pre-bundle slice walk threw for ${next.specifier}: ${msg}`);
          errorCount++;
          lastError = msg;
          errorsByModule[next.specifier] = msg;
          continue;
        }
        if (!slice) {
          safeProgress(
            `  skipped pre-bundle for ${next.specifier}: slice exceeded ${(SLICE_CAP_BYTES / (1024 * 1024)).toFixed(0)} MiB cap`,
          );
          skippedCount++;
          continue;
        }

        // externalsForSpecifier is pure JS over a small list — extremely
        // unlikely to throw, but cheap to guard since we're hardening
        // this path comprehensively.
        let externals: string[];
        try {
          externals = externalsForSpecifier(next.specifier);
        } catch (e: any) {
          const msg = e?.message || String(e);
          safeProgress(`  pre-bundle externals threw for ${next.specifier}: ${msg}`);
          errorCount++;
          lastError = msg;
          errorsByModule[next.specifier] = msg;
          continue;
        }

        let spec: PrebundleSpec | null = {
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

        let result: PrebundleResult | null = null;
        try {
          // pool.submit is per-task (no auto slot pinning). All slots
          // share slot index 0 in the underlying #dispatchSlot — that's
          // fine for our use (we don't need stable warm slots beyond
          // "esbuild compiled once per slot's lifetime"; for pre-bundle
          // the slot HAS to compile esbuild on first call regardless).
          result = await pool.submit<PrebundleSpec, PrebundleResult>(
            prebundleOne,
            spec,
          );
        } catch (e: any) {
          const msg = e?.remoteMessage || e?.message || String(e);
          safeProgress(`  pre-bundle failed for ${next.specifier}: ${msg}`);
          errorCount++;
          lastError = msg;
          errorsByModule[next.specifier] = msg;
        } finally {
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
            lastError = why;
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
            inputHash: '',
          });
          okCount++;
        } catch (e: any) {
          const msg = e?.message || String(e);
          safeProgress(`  pre-bundle cache-write failed for ${next.specifier}: ${msg}`);
          errorCount++;
          lastError = msg;
          errorsByModule[next.specifier] = msg;
        }
        // result.esmCode is now durably in SQLite; drop our heap copy
        // before the next iteration's slice walk allocates.
        result = null;
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
      await Promise.all(
        Array.from({ length: PRE_BUNDLE_CONCURRENCY }, (_, i) => runSlot(i)),
      );
    } catch (e: any) {
      const msg = e?.message || String(e);
      safeProgress(`Pre-bundle aborted: ${msg}`);
      lastError = msg;
    } finally {
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
          lastError,
          errorsByModule,
        });
      } catch (e: any) {
        try { console.error('[pre-bundle] recordPreBundleSummary threw:', e?.message || e); } catch {}
      }
      // readSupervisorHeap returns null on any throw (its own internal
      // try/catch — see line 1525), but we still guard the
      // arithmetic and onProgress call below for completeness.
      try {
        const memAfter = readSupervisorHeap();
        if (memAfter && memBefore) {
          const delta = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
          safeProgress(
            `Pre-bundle complete: ${okCount}/${attempted} succeeded. (supervisor heap ${(memAfter.heapUsed / (1024 * 1024)).toFixed(1)} MiB, Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} MiB)`,
          );
        } else {
          safeProgress(`Pre-bundle complete: ${okCount}/${attempted} succeeded.`);
        }
      } catch (e: any) {
        try { console.error('[pre-bundle] final-progress threw:', e?.message || e); } catch {}
      }
      try { pool.dispose(); } catch { /* best-effort */ }
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
  private scanBareImports(projDir: string): string[] {
    const imports = new Set<string>();
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
    const isServerOnlyTopLevel = (name: string): boolean => {
      // vite.config.ts/js/mjs/cjs and *.config.{ts,js,mjs,cjs} at the
      // project root. Limited to depth 0 to avoid filtering legitimate
      // browser code that happens to live under e.g. src/config/foo.ts.
      return /^(?:vite|vitest|astro|rollup|tsup|tailwind|postcss|prettier|eslint|stylelint|rolldown)\.config\.[mc]?[jt]s$/.test(name)
          || /\.config\.[mc]?[jt]s$/.test(name) && name.split('.').length === 3;
    };

    const walk = (dir: string, depth: number) => {
      if (depth > 5) return;
      try {
        for (const entry of this.vfs.readdir(dir)) {
          if (entry.name === 'node_modules' || entry.name === '.git' ||
              entry.name === 'dist' || entry.name === 'build') continue;
          const path = dir + '/' + entry.name;
          if (entry.type === 'directory') {
            walk(path, depth + 1);
            continue;
          }
          // Server-only config files at the project root (depth 0) are
          // skipped — their imports are not browser modules.
          if (depth === 0 && isServerOnlyTopLevel(entry.name)) continue;
          const dotIdx = entry.name.lastIndexOf('.');
          if (dotIdx < 0) continue;
          const ext = entry.name.substring(dotIdx);
          if (!scanExts.has(ext)) continue;

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
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }
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
  private resolvePackageEntryPath(specifier: string, nmDir: string): string | null {
    // Parse out pkgName and subpath
    let pkgName: string;
    let subpath: string;
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      pkgName = parts.slice(0, 2).join('/');
      subpath = parts.slice(2).join('/');
    } else {
      const parts = specifier.split('/');
      pkgName = parts[0];
      subpath = parts.slice(1).join('/');
    }

    const pkgDir = nmDir + '/' + pkgName;
    const pkgJsonPath = pkgDir + '/package.json';
    if (!this.vfs.exists(pkgJsonPath)) return null;

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
      } else if (!entry) {
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
          if (this.vfs.exists(entryPath + '/' + idx)) return entryPath + '/' + idx;
        }
      }
    } catch { /* skip */ }

    return null;
  }

  /**
   * Get peer dependencies for a package (to mark as external in esbuild).
   */
  private getPeerDeps(
    specifier: string,
    installed: Map<string, ResolvedPackage>,
  ): string[] {
    // For now, externalize all other installed top-level packages.
    // This prevents bundling the entire dependency tree into one file.
    return [...installed.keys()].filter(name => name !== specifier);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Read the supervisor isolate's process.memoryUsage() if available.
 * Returns null when nodejs_compat doesn't expose it (older compat dates,
 * non-Workers test harnesses). Used to log heap pressure at pre-bundle
 * phase boundaries so /api/_diag/memory's peak tracker has clear
 * before/after values to compare. Cost is microseconds per call.
 */
function readSupervisorHeap(): { rss: number; heapUsed: number; heapTotal: number } | null {
  try {
    const g: any = globalThis as any;
    if (g.process && typeof g.process.memoryUsage === 'function') {
      const mu = g.process.memoryUsage();
      return { rss: mu.rss | 0, heapUsed: mu.heapUsed | 0, heapTotal: mu.heapTotal | 0 };
    }
  } catch { /* ignore */ }
  return null;
}

function parentOf(path: string): string {
  return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json); } catch { return fallback; }
}


