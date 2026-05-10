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

import type { SqliteVFS, BatchInodeEntry } from '../vfs/sqlite-vfs.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
import { BUNDLER_VERSION } from '../runtime/esbuild-service.js';
import { NpmCache, type LockfileEntry } from './cache.js';
import {
  computeHoistPlan, shouldSkipPackage,
  type ResolvedPackage, type HoistPlan, type FetchFn,
} from './resolver.js';
import {
  applySwaps, findRejects, lookupSwap, lookupReject,
  shouldWarnSkipTransitive,
  formatSwapNotice, formatTransitiveSkip, RegistryRejectError,
  emitRegistryEvent,
} from '../facets/wasm-swap-registry.js';
import { shouldSkipPackageWithFramework } from './resolver.js';
import { resolvePackageEntry } from '../_shared/exports-resolver.js';
import { buildCacheRestorePayload } from './tarball.js';
import { NimbusLoaderPool } from '../loaders/loader-pool.js';
import { NimbusFanoutPool, IN_DO_THRESHOLD, MAX_PEER_FANOUT } from '../loaders/fanout-pool.js';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE } from '../loaders/generated-workers.js';
import type { FacetPackageSpec } from './install-facet.js';
import {
  installPackagesInFacet,
  type InstallBatchSpec,
  type InstallBatchResult,
} from './install-batch-facet.js';
import {
  setInstallPhase, setResolverPath,
  setInstallFacetPath, recordInstallFacetCounters,
  recordPreBundleSummary,
  recordR2RaceCounters,
  readDiagCounters,
} from '../observability/diag-counters.js';
import { estimateSupervisorHeap } from '../observability/heap-estimate.js';
import {
  resolveTreeInFacet,
  type ResolveFacetSpec,
  type ResolveFacetResult,
  type FacetCachedEntry,
} from './resolve-facet.js';
import {
  resolveOnePackumentInFacet,
  type ResolveOneSpec,
  type ResolveOneResult,
} from './resolve-one-facet.js';
import { NPM_RESOLVE_PREAMBLE } from '../loaders/npm-resolve-preamble.js';
import {
  prebundleOne,
  buildSliceForSpecifierWithCap,
  externalsForSpecifier,
  type PrebundleSpec,
  type PrebundleResult,
} from './pre-bundle-facet.js';
import { PRE_BUNDLE_PREAMBLE } from '../loaders/pre-bundle-preamble.js';
import { fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';
import { CHUNK_SIZE } from '../constants.js';
import { waitForLowAllocPressure } from '../observability/heavy-alloc-coord.js';
import { countPackageFiles, BARREL_PKG_FILE_THRESHOLD, packageNameFromSpecifier } from '../runtime/barrel-detect.js';
import {
  scanNamedImports,
  buildSyntheticEntry,
  buildScopedSliceForSynthetic,
  syntheticEntryPath,
  type NamedImportMap,
} from '../runtime/barrel-synthesizer.js';
import { enc } from '../_shared/bytes.js';

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
      // F-2 (cleanup-not-done): frontier-coordinator path. Each BFS
      // layer dispatches to NimbusFanoutPool.submitMany — width <5 in-DO
      // (POC C), width ≥5 peer-DO (POC B). Per-package task body is
      // self-contained (resolveOnePackumentInFacet), supervisor builds
      // layer N+1 from layer N's edges. Replaces the pre-F-2 single
      // resolve-facet path. See audit/sections/F2-RESOLVER-FANOUT-plan.md.
      //
      // Selection: env NIMBUS_RESOLVER_PATH=facet forces the legacy
      // single-facet path. Default is `fanout`. The legacy path lives
      // ONLY for A/B profile measurement (see profile-layer-widths.mjs);
      // it is NOT a runtime auto-fallback (per anti-requirement).
      // Missing env.LOADER throws at construction either way; missing
      // env.NIMBUS_SESSION throws at the first wide-layer submitMany.
      const __resolverPathSel = ((globalThis as any).process?.env?.NIMBUS_RESOLVER_PATH === 'facet') ? 'facet' : 'fanout';
      phaseStart = Date.now();
      setInstallPhase('resolve');
      setResolverPath('in-facet');
      log(`Resolving ${Object.keys(specs).length} dependencies (path: ${__resolverPathSel}, fetch: ${this.fetchFn ? 'facet-proxy' : 'global'})...`);
      resolved = __resolverPathSel === 'facet'
        ? await this.resolveTreeViaFacet(specs, log, { frameworkAware })
        : await this.resolveTreeViaFanout(specs, log, { frameworkAware });
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
    // Single fetch path: one NimbusLoaderPool isolate (the batch facet)
    // runs the entire install. The facet streams each tarball through
    // gunzip+tar and emits one writeBatch RPC per package; supervisor
    // heap only sees one inbound RPC payload at a time.
    //
    // No fallback paths: env.LOADER + ctx are platform requirements
    // (their absence is a deploy bug, not a runtime branch). Per-package
    // pool.map and the legacy in-supervisor fetchWaves loop were both
    // removed in Phase 2 A'.1 — they re-introduced the supervisor-heap
    // pressure the facet path eliminates.
    if (toFetch.length > 0) {
      setInstallFacetPath('batch-facet');
      log(`Fetching ${toFetch.length} packages... (path: batch-facet)`);
      const batchResult = await this.fetchViaBatchFacet(toFetch, hoistPlan, nmDir);
      totalFiles += batchResult.filesWritten;
      for (const name of batchResult.installed) installed.push(name);
      for (const name of batchResult.failed) failed.push(name);
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
      // ── Bug 1 (prod-bugs-2 P4) — late-progress gating ───────────────
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
      this.onProgress = (msg: string) => {
        if (installInvocationActive.v) {
          persistentProgress?.(msg);
        } else {
          // Late progress — pre-bundle finished AFTER install()
          // returned. Surface to the wrangler dev console only so
          // the user's shell prompt isn't corrupted.
          try { console.log('[npm:late] ' + msg); } catch {}
        }
      };
      // Fire-and-forget. Capture rejections so the orphan promise
      // never raises an "unhandled rejection" warning. We do NOT
      // await here — see Phase 7 design note above for why.
      const prebundlePromise = this.prebundleUsedModules(projDir, resolved)
        .catch((e: any) => {
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
    log(`Done! ${installed.length} packages, ${totalFiles} files in ${(elapsed / 1000).toFixed(1)}s`);
    if (cachedHits > 0) {
      log(`  (${cachedHits} from cache)`);
    }

    return { installed, failed, totalFiles, elapsed, cachedHits, phases };
  }

  // ── Single-resolver / single-fetcher invariant (Phase 2 A'.1) ─────────
  //
  // Pre-rebuild this section had three feature flags that gated the
  // facet paths and fell back to in-supervisor resolveTree /
  // fetchWaves / pool.map when off. The fallback paths re-introduced
  // exactly the supervisor heap pressure the rebuild aims to remove,
  // so they were deleted along with their feature flags.
  //
  // Single resolver: src/npm-resolve-facet.ts (called from
  // resolveTreeViaFacet below).
  // Single fetcher : src/npm-install-batch-facet.ts (called from
  // fetchViaBatchFacet below).
  //
  // env.LOADER and ctx are platform requirements; if either is
  // missing the install fails loud at the first await on the facet
  // pool — that's a deploy bug, not a runtime branch.

  /**
   * Resolve the dep graph in a NimbusLoaderPool isolate.
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

    // F-2 profiling: forward NIMBUS_DIAG_INSTALL_PIPELINE=1 into the
    // facet so the in-DO BFS emits per-layer-width lines into messages.
    // Same env-gated diag posture as resolver.ts. Zero cost in prod.
    const __f2Diag = ((globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');
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
      ...(__f2Diag ? { __f2DiagWidths: true } as any : {}),
    };

    const pool = new NimbusLoaderPool(this.env, this.ctx!, {
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
   * F-2 frontier-coordinator path. Replaces the single-resolve-facet
   * dispatch with a per-package fanout: each BFS layer becomes ONE
   * `NimbusFanoutPool.submitMany` call, layer N+1 builds from the
   * resolved metadata of layer N.
   *
   * Topology auto-routes per layer:
   *   width <  IN_DO_THRESHOLD (5)  → POC C in-DO loader-pool
   *   width >= IN_DO_THRESHOLD       → POC B peer-DO (sibling NimbusSession DOs)
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
   * audit/sections/F2-RESOLVER-FANOUT-plan.md.
   *
   * Anti-requirements (cleanup-not-done charter): NO setTimeout
   * between layers, NO fallback to single-facet on missing bindings.
   */
  private async resolveTreeViaFanout(
    specs: Record<string, string>,
    log: (msg: string) => void,
    opts: { frameworkAware?: boolean } = {},
  ): Promise<Map<string, ResolvedPackage>> {
    const t0 = Date.now();
    const frameworkAware = !!opts.frameworkAware;
    const __f2Diag = ((globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');

    // Per-walk state — supervisor side.
    const resolved = new Map<string, ResolvedPackage>();
    const seen = new Set<string>();
    const topLevelNames = new Set<string>(Object.keys(specs));
    const optionalNames = new Set<string>();   // X.5-G G1
    const bestEffortNames = new Set<string>(); // X.5-drizzle
    let queue: Array<[string, string]> = Object.entries(specs);
    const cacheWritesPending: any[] = [];
    let totalPackumentBytes = 0;
    let totalPackumentsDecoded = 0;
    let layerN = 0;
    let totalLayers = 0;
    let r2Wins = 0;
    let r2Losses = 0;

    // Counter for diagnostics — peak in-flight inside a layer = layer
    // width (parallelism mirrors the in-DO/peer-DO pool's task count).
    let inFlightPeak = 0;

    // F-2 fanout pool. One construction reused across every layer; the
    // pool is stateless across submitMany calls.
    const fanoutPool = new NimbusFanoutPool(this.env, this.ctx!, {
      tag: 'npm-resolve-fanout',
      // 5 minutes per layer is generous; typical layers complete in
      // 1-3 s. Per-task this gates each packument fetch + R2 race.
      timeoutMs: 5 * 60_000,
      preamble: NPM_RESOLVE_PREAMBLE,
    });

    // Frontier loop. Each iteration = ONE BFS layer dispatched as ONE
    // submitMany batch.
    while (queue.length > 0) {
      // Dedupe + filter the layer up front. The task body also filters
      // (defensive), but doing it here avoids dispatching wasted RPC
      // for already-seen names.
      const layer: Array<[string, string]> = [];
      const layerSeenLocal = new Set<string>();
      for (const [name, range] of queue) {
        if (seen.has(name) || layerSeenLocal.has(name)) continue;
        layerSeenLocal.add(name);
        seen.add(name);
        layer.push([name, range]);
      }
      queue = [];

      if (__f2Diag) {
        log(`[f2-frontier] N=${layerN} width=${layer.length} resolved-so-far=${resolved.size} seen=${seen.size}`);
      }

      if (layer.length === 0) break;

      // Track peak — the layer is dispatched in parallel inside the pool.
      if (layer.length > inFlightPeak) inFlightPeak = layer.length;
      totalLayers++;

      // Build per-package tasks. Each task gets its own pre-loaded
      // cache slice (only entries for THIS name) so the per-task RPC
      // stays small. Bounded to 16 versions per name — enough to cover
      // ~2 majors of typical packages, well under any RPC arg size cap.
      const tasks = layer.map(([name, range]) => {
        const cachedRows = this.cache.getRegistryVersions(name).slice(0, 16);
        const cachedEntries: FacetCachedEntry[] = cachedRows.map((e) => ({
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
          fetchedAt: e.fetchedAt,
        }));
        const taskSpec: ResolveOneSpec = {
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
      //   <5 → POC C in-DO (NimbusLoaderPool), concurrency = layer.length (capped at 4)
      //   ≥5 → POC B peer-DO, N peers = min(layer.length, 32)
      let results: ResolveOneResult[];
      try {
        results = await fanoutPool.submitMany<ResolveOneSpec, ResolveOneResult>(
          tasks,
          resolveOnePackumentInFacet,
        );
      } catch (e: any) {
        // Per anti-requirement: no fallback. Log + propagate.
        const msg = e?.remoteMessage || e?.message || String(e);
        log(`  resolver-fanout layer ${layerN} failed: ${msg}`);
        try { /* fanoutPool has no dispose; constructor is stateless */ } catch {}
        throw new Error(`resolver-fanout failed at layer ${layerN}: ${msg}`);
      }

      // Stitch per-package results into supervisor state.
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const [taskName] = layer[i];

        // Forward messages + events.
        for (const m of res.messages) log(m);
        for (const ev of res.events) {
          try { emitRegistryEvent(ev); } catch { /* swallow sink errors */ }
        }

        // Accumulate cache writes for end-of-walk flush.
        for (const cw of res.cacheWrites) cacheWritesPending.push(cw);
        totalPackumentBytes += res.packumentBytesDecoded;
        if (res.packumentSource === 'r2-cache') r2Wins++;
        else if (res.packumentSource === 'network') r2Losses++;
        if (res.packumentBytesDecoded > 0) totalPackumentsDecoded++;

        // W6 reject error handling — mirrors resolve-facet.ts:716.
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
          const rejectEntry: any = {
            from: res.error.from,
            reason: res.error.reason,
            suggest: res.error.suggest,
            transitive: 'fail',
          };
          throw new RegistryRejectError([rejectEntry]);
        }

        // Optional-dep fetch failure → silent-skip (X.5-G G1).
        if (res.error && res.error.type === 'fetch-exhausted' && optionalNames.has(taskName)) {
          const reason = `optional dep fetch failed: ${res.error.message}`;
          log(`[resolve-fanout] [skip] ${taskName} — ${reason}`);
          emitRegistryEvent({ type: 'transitive-skip', from: taskName, reason });
          continue;
        }

        const pkg = res.pkg;
        if (!pkg) continue;

        // X.5-G G1: silent-skip platform-native bindings sourced from
        // optionalDependencies. The task returns the pkg raw; the
        // supervisor checks isOptional + os/cpu/libc/main.
        if (optionalNames.has(taskName)) {
          const isNativeBinding =
            (Array.isArray((pkg as any).os) && (pkg as any).os.length > 0) ||
            (Array.isArray((pkg as any).cpu) && (pkg as any).cpu.length > 0) ||
            (Array.isArray((pkg as any).libc) && (pkg as any).libc.length > 0) ||
            (typeof pkg.main === 'string' && /\.node$/.test(pkg.main));
          if (isNativeBinding) {
            const reason = `optional native binding (os=${(pkg as any).os ?? '*'}, cpu=${(pkg as any).cpu ?? '*'}, libc=${(pkg as any).libc ?? '*'}, main=${pkg.main || '?'})`;
            log(`[resolve-fanout] [skip] ${taskName} — ${reason}`);
            emitRegistryEvent({ type: 'transitive-skip', from: taskName, reason });
            continue;
          }
        }

        if (resolved.has(pkg.name)) continue;
        resolved.set(pkg.name, pkg);

        // Edge extraction — mirrors resolve-facet.ts:754-836.
        const inheritBestEffort = bestEffortNames.has(pkg.name);
        for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
          if (resolved.has(depName) || seen.has(depName)) continue;
          if (inheritBestEffort) bestEffortNames.add(depName);
          queue.push([depName, depRange as string]);
        }
        const optDeps = (pkg as any).optionalDependencies as Record<string, string> | undefined;
        if (optDeps) {
          for (const [depName, depRange] of Object.entries(optDeps)) {
            if (resolved.has(depName) || seen.has(depName)) continue;
            optionalNames.add(depName);
            if (inheritBestEffort) bestEffortNames.add(depName);
            queue.push([depName, depRange as string]);
          }
        }
        if (pkg.peerDependencies) {
          for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies)) {
            if (resolved.has(peerName) || seen.has(peerName)) continue;
            topLevelNames.add(peerName);
            if (inheritBestEffort) bestEffortNames.add(peerName);
            queue.push([peerName, peerRange as string]);
          }
        }
        // X.5-F R2.5 + X.5-J: optional peers when THIS pkg is the
        // user's top-level. Filter through REJECT_INSTALL.
        if (topLevelNames.has(pkg.name)) {
          const allPeers = (pkg as any).__allPeerDependencies as Record<string, string> | undefined;
          if (allPeers) {
            for (const [peerName, peerRange] of Object.entries(allPeers)) {
              if (resolved.has(peerName) || seen.has(peerName)) continue;
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
              queue.push([peerName, peerRange as string]);
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
      if (r.failed > 0) log(`  resolver-fanout cache write: ${r.failed} entries failed`);
    }

    // Diag/counters parity with resolveTreeViaFacet.
    recordR2RaceCounters({
      pipelinedTarballRaceWins: 0,
      pipelinedTarballRaceLosses: 0,
      pipelinedPackumentRaceWins: r2Wins,
      pipelinedPackumentRaceLosses: r2Losses,
    });
    const r2WinSuffix = r2Wins > 0 ? `, R2 packument cache wins=${r2Wins}/${r2Wins + r2Losses}` : '';
    log(
      `  resolver-fanout: ${resolved.size} resolved, ` +
      `${totalPackumentsDecoded} packuments fetched (` +
      `${(totalPackumentBytes / (1024 * 1024)).toFixed(1)} MiB), ` +
      `peak in-flight=${inFlightPeak}, ` +
      `cache writes=${cacheWriteCount}` +
      r2WinSuffix +
      `, layers=${totalLayers}, ` +
      `elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    return resolved;
  }

  /**
   * Batch install via two-tier fan-out (NimbusFanoutPool).
   *
   * Topology selected automatically based on the spec count:
   *   specs.length <  IN_DO_THRESHOLD (5)  → POC C in-DO
   *     1 NimbusLoaderPool with concurrency = specs.length, capped at
   *     4 by V8 invariant. Each spec is one facet running its own
   *     installPackagesInFacet over a single-element shard.
   *   specs.length >= IN_DO_THRESHOLD       → POC B peer-DO
   *     N peer NimbusSession sibling DOs (N = min(specs.length,
   *     MAX_PEER_FANOUT = 32)), each running ONE installPackagesInFacet
   *     against its own shard with internal pLimit(3).
   *
   * Sharding strategy: round-robin (`pkgIdx % N`) so every peer DO
   *   receives roughly equal work. Stable-id router maps each
   *   `shard-${i}` task key deterministically (tests can predict
   *   placement).
   *
   * Pre-fix lineage: this site previously ran ONE NimbusLoaderPool
   *   with concurrency=1, internal pLimit(3) — the explicit "collapses
   *   what was 4 concurrent dynamic workers (pool.map slots) into 1"
   *   YELLOW retreat documented in audit/sections/FANOUT-AUDIT.md (P1).
   *   Two-tier topology re-expands the fan-out without re-introducing
   *   the V8 cap risk.
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
    // hoistPlan is intentionally unused: the current installer maps
    // every package to `${nmDir}/${name}` (flat hoisting). Accepting
    // the plan as a parameter keeps the caller agnostic of the hoist
    // strategy and lets a future nested-install variant slot in
    // without changing the call site.
    void hoistPlan;

    if (specs.length === 0) {
      return { installed, failed, filesWritten };
    }

    // Shard count: bounded by spec count, the peer-DO ceiling, and
    // the coordinator-flush ceiling.
    //
    // For small batches (< IN_DO_THRESHOLD), the in-DO path uses
    // concurrency = specs.length (capped at 4 by NimbusFanoutPool's
    // in-DO leg) — so each spec gets its own slot.
    //
    // For larger batches, we shard into N = min(specs.length,
    // MAX_PEER_FANOUT) buckets, each handled by one peer DO.
    //
    // [COORDINATOR-OVERLOAD adaptive cap, P0a]
    // For VERY large installs (> COORD_FLUSH_PRESSURE_THRESHOLD), the
    // 32-peer × pLimit=3 = 96 concurrent writeBatchStream RPC streams
    // saturate the coordinator DO's workerd input gate, producing
    // "Durable Object is overloaded. Requests queued for too long." on
    // a fraction of writes (Markflow 617 deps → ~50% fail rate per
    // user transcript). Capping shard count to ⌈specs.length /
    // PER_SHARD_TARGET⌉ keeps per-peer dep count high and reduces
    // simultaneous flushes proportionally. Pairs with the coordinator
    // semaphore in src/session/rpc.ts:_rpcWriteBatchStream.
    //
    //   PER_SHARD_TARGET = 40 (deps / shard average); chosen so 617
    //   deps maps to ~15 shards (= 45 in-flight flushes), well under
    //   the empirical knee at 96 producers.
    //   COORD_FLUSH_PRESSURE_THRESHOLD = 200 (deps); below this the
    //   default 32-peer fan-out is fine and we keep current behavior.
    const COORD_FLUSH_PRESSURE_THRESHOLD = 200;
    const PER_SHARD_TARGET = 40;
    let shardCount: number;
    if (specs.length > COORD_FLUSH_PRESSURE_THRESHOLD) {
      shardCount = Math.min(
        specs.length,
        MAX_PEER_FANOUT,
        Math.max(IN_DO_THRESHOLD, Math.ceil(specs.length / PER_SHARD_TARGET)),
      );
    } else {
      shardCount = Math.min(specs.length, MAX_PEER_FANOUT);
    }
    // Round-robin assignment: spec at pkgIdx → shard pkgIdx % shardCount.
    // This produces ⌈specs.length / shardCount⌉ specs per shard at
    // most, with the imbalance bounded to ±1.
    const shards: FacetPackageSpec[][] = Array.from(
      { length: shardCount },
      () => [],
    );
    specs.forEach((spec, idx) => {
      shards[idx % shardCount].push(spec);
    });
    const nonEmptyShards = shards.filter((s) => s.length > 0);

    const topology =
      nonEmptyShards.length < IN_DO_THRESHOLD ? 'in-do (POC C)' : 'peer-do (POC B)';
    log(
      `Dispatching ${specs.length} packages across ${nonEmptyShards.length} ` +
      `shard${nonEmptyShards.length === 1 ? '' : 's'} (${topology}, internal pLimit=3)...`,
    );

    const fanoutPool = new NimbusFanoutPool(this.env, this.ctx!, {
      tag: 'npm-install-batch',
      // Whole-batch timeout. With per-shard parallelism of N=8 peer
      // DOs each running pLimit(3), Mossaic-class 456 packages
      // typical 30-60 s wall clock. 10 min covers pathological cases.
      timeoutMs: 10 * 60_000,
      // W7: tar-stream + W7-frame preambles concatenated. Forwarded
      // to every facet (in-DO and per-peer) so each shard's facet
      // can encode its own write-batch stream.
      preamble: TAR_STREAM_PREAMBLE + '\n' + W7_FRAME_PREAMBLE,
    });

    const tasks = nonEmptyShards.map((shardSpecs, shardIdx) => ({
      // Stable-id router key. Same shardIdx → same peer DO across
      // runs. Tests can predict placement via NimbusFanoutPool's
      // `peerSiblingId(key, peerCount)` helper.
      key: `shard-${shardIdx}`,
      args: { packages: shardSpecs, concurrency: 3 } as InstallBatchSpec,
    }));

    let shardResults: InstallBatchResult[];
    try {
      try {
        shardResults = await fanoutPool.submitMany<InstallBatchSpec, InstallBatchResult>(
          tasks,
          installPackagesInFacet,
        );
      } catch (e: any) {
        const msg = e?.remoteMessage || e?.message || String(e);
        log(`  [batch-fanout] aborted: ${msg}`);
        // Mark all packages failed; surface to caller to set non-zero exit.
        for (const s of specs) failed.push(`${s.name}@${s.version}`);
        throw new Error(`batch-fanout install failed: ${msg}`);
      }

      // Merge per-shard InstallBatchResult into a single result for
      // the rest of the function. Maintain input order: the
      // round-robin sharding means perPackage entries are NOT in
      // input order, but the rest of fetchViaBatchFacet uses set
      // semantics (installed/failed are unordered string lists,
      // filesWritten is summed) so we don't need to re-order.
      const result: InstallBatchResult = {
        perPackage: shardResults.flatMap((r) => r.perPackage),
        elapsed: Math.max(...shardResults.map((r) => r.elapsed)),
        facetCounters: mergeFacetCounters(shardResults.map((r) => r.facetCounters)),
      } as InstallBatchResult;

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
    } catch (e: any) {
      // Final catch — preserved from the pre-fix shape so the error
      // log line shape stays consistent. NimbusFanoutPool's internal
      // pools dispose themselves at the end of each submitMany call,
      // so no explicit dispose() is needed here.
      const msg = e?.remoteMessage || e?.message || String(e);
      // The earlier inner-catch already logged + threw; if we reach
      // here, the throw bubbled — re-throw to preserve the install
      // command's failure semantics.
      throw e instanceof Error ? e : new Error(msg);
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
      const { detectFramework } = await import('../runtime/framework-detect.js');
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
    _hoistPlan: HoistPlan,
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
    //
    // P5 (prod-bugs-2): switched from process.memoryUsage() to the
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
    this.onProgress?.(
      `Pre-bundling ${pending.length} modules... (supervisor heap ${memBefore.toFixed(1)} MiB)`,
    );

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
    const safeProgress = (msg: string): void => {
      try { this.onProgress?.(msg); } catch (e: any) {
        try { console.error('[pre-bundle] onProgress threw:', e?.message || e); } catch {}
      }
    };

    // No fallback: a missing wasm asset is a deploy bug. Surface
    // loudly via the thrown error from fetchEsbuildWasmBytes — the
    // pre-bundle phase aborts cleanly and the install completes
    // without pre-bundle (vite then serves modules un-pre-bundled).
    const wasmBytes: ArrayBuffer = await fetchEsbuildWasmBytes(this.env as any);

    let pool: NimbusLoaderPool;
    try {
      pool = new NimbusLoaderPool(this.env, this.ctx!, {
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
      // P5 (prod-bugs-2): switched both `memBefore` and `memAfter`
      // to the C'.1 deterministic estimator (see entry-point note
      // above). Both are floats in MiB; delta is post − pre.
      try {
        const memAfter = this._estimateSupervisorHeapMiB();
        const delta = memAfter - memBefore;
        safeProgress(
          `Pre-bundle complete: ${okCount}/${attempted} succeeded. (supervisor heap ${memAfter.toFixed(1)} MiB, Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} MiB)`,
        );
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
   * P5 (prod-bugs-2) — deterministic supervisor-heap estimate in MiB.
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
  private _estimateSupervisorHeapMiB(): number {
    try {
      const counters = readDiagCounters();
      const vfsStats = this.vfs.getStats() as any;
      const cacheStats = vfsStats.cache ?? {};
      const heap = estimateSupervisorHeap(counters, {
        cacheHotBytes: cacheStats.hotBytes ?? 0,
        // Steady-state in-flight write bytes are 0 by the time we
        // reach the pre-bundle phase boundary (writeBatch has
        // already flushed before bundle dispatches). Same value
        // routes.ts uses for its read.
        inFlightWriteBytes: 0,
      });
      return heap.estimatedBytes / (1024 * 1024);
    } catch {
      return 0;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

// P5 (prod-bugs-2): readSupervisorHeap() removed. It called
// process.memoryUsage() which returns 0 for every field inside a
// Durable Object class context (only dynamic-worker isolates under
// nodejs_compat get the real implementation — see
// src/observability/diag-counters.ts:4). The deterministic
// supervisor-heap estimator is the C'.1 replacement; see
// NpmInstaller._estimateSupervisorHeapMiB.

function parentOf(path: string): string {
  return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json); } catch { return fallback; }
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
function mergeFacetCounters(
  perShard: Array<InstallBatchResult['facetCounters']>,
): InstallBatchResult['facetCounters'] {
  if (perShard.length === 0) {
    return {
      tarballsCompleted: 0,
      cumulativeBytesDecoded: 0,
      peakInFlight: 0,
      pipelinedTarballRaceWins: 0,
      pipelinedTarballRaceLosses: 0,
    };
  }
  return {
    tarballsCompleted: perShard.reduce((s, c) => s + (c.tarballsCompleted || 0), 0),
    cumulativeBytesDecoded: perShard.reduce((s, c) => s + (c.cumulativeBytesDecoded || 0), 0),
    peakInFlight: perShard.reduce((m, c) => Math.max(m, c.peakInFlight || 0), 0),
    pipelinedTarballRaceWins: perShard.reduce((s, c) => s + (c.pipelinedTarballRaceWins || 0), 0),
    pipelinedTarballRaceLosses: perShard.reduce((s, c) => s + (c.pipelinedTarballRaceLosses || 0), 0),
  };
}


