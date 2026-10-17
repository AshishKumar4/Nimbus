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

import { ISOLATE_NETWORK, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import type {
  SqliteVFS,
  CredentialedVfs,
} from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL, type PackageRejectEntry, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { engineKey, type ProcessFiles, type ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { direntTypeIn } from '@nimbus-sh/core/vfs/dirent-type.js';
import { LruMap } from '@nimbus-sh/core/_shared/lru-map.js';
import { handKernelArtifact, projectFs, type ProjectFs } from '../runtime/project-fs.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { NpmCache, type LockfileEntry, type RecordSource } from './cache.js';
import type { ResolvedPackage, PackagePlacement } from './resolver.js';
import {
  bundledNames, canonicalTreePath, depthOf, holdTree, lockRootMatches, namedPackages, packageJsonDocument, parentPlacement, placementName, projectRoots, readPackageJson, saveNamed,
  type NamedPackage, type ProjectManifest, type TreeRoot,
} from '@nimbus-sh/core/_shared/npm-tree.js';
import { planTree, type InstalledPackage, type OmitTypes, type PlanOptions, type TreePlan, type TreeResolution } from '@nimbus-sh/core/_shared/npm-arborist/plan.js';
import { checkEngines, type EngineMismatch } from '@nimbus-sh/core/_shared/npm-arborist/engines.js';
import { parsePackageLock, stringList, stringRecord } from './package-lock.js';
import { npmRegistryOrigin, packumentUrl } from './r2-cache.js';
import {
  npmAddedLine, npmHttpCacheLine, npmHttpFetchLine, npmTitleLine,
  type NpmLogEmitter,
} from '@nimbus-sh/core/substrate/lifo/commands/system/npm-log.js';
import {
  applySwaps, findRejects, lookupSwap, lookupReject, swapCoversVersion,
  isOptionalNativeBinding,
  lookupStagedArtifact, applyStagedArtifact, policyNativePlatformReject, PACKAGE_ABI_POLICY,
  formatSwapNotice,
  emitRegistryEvent,
} from '../facets/wasm-swap-registry.js';
import { parseRegistryRequest } from '@nimbus-sh/core/_shared/npm-spec.js';
import { exactVersion } from '@nimbus-sh/core/_shared/npm-semver.js';
import type { NpmCacheMode } from '@nimbus-sh/core/_shared/npm-cache-mode.js';
import type { NpmInstallSpec } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import { createWaveWriter } from '@nimbus-sh/platform/wave-writer.js';
import type { BundlePoolProvider } from '../facets/prebundle-pool.js';
import { Fanout, type FanoutRoute } from '@nimbus-sh/fabric/fanout.js';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE } from '../loaders/generated-workers.js';
import type { FacetPackageSpec } from './install-facet.js';
import {
  type InstallBatchSpec,
  type InstallBatchResult,
} from './install-batch-facet.js';
import {
  setInstallPhase, recordInstallFacetCounters,
  recordPreBundleSummary,
  recordR2RaceCounters,
  readDiagCounters,
} from '@nimbus-sh/platform/diag-counters.js';
import { recordCacheStatEvents } from '@nimbus-sh/core/_shared/cache-stats.js';
import { estimateSupervisorHeap } from '@nimbus-sh/platform/heap-estimate.js';
import { describeError } from '@nimbus-sh/platform/oom-classify.js';
import { isEngines, resolvedFromRecord, type RegistryCacheEntry } from './registry-record.js';
import {
  type ResolveOneSpec,
  type ResolveOneResult,
} from './resolve-one-facet.js';
import { NPM_RESOLVE_PREAMBLE } from '../loaders/npm-resolve-preamble.js';
import { NPM_INSTALL_PREAMBLE } from '../loaders/npm-install-preamble.js';
import { NPM_INSTALL_BATCH_TASK, NPM_RESOLVE_ONE_TASK } from '../loaders/compiled-bodies.generated.js';
import { packageNameFromSpecifier } from '@nimbus-sh/core/runtime/barrel-detect.js';
import { transformParser } from '../runtime/barrel-synthesizer.js';
import {
  barrelInput,
  barrelPackage,
  buildPrebundle,
  isServerToolPackage,
  scanProject,
  storedPrebundle,
  type BarrelInput,
  type PrebundleContext,
  type PrebundleOutcome,
} from './browser-prebundle.js';
import { enc } from '@nimbus-sh/core/_shared/bytes.js';
import {
  createNpmBinManifest,
  createNpmBinShim,
  npmBinManifestPath,
  declaredPackageBins,
  packageBinEntries,
  parseNpmBinManifest,
  type NpmBinEntry,
} from './bin-links.js';

// ── Types ───────────────────────────────────────────────────────────────

import { withRecall } from '@nimbus-sh/core/vfs/recall.js';

/**
 * The one engine's plan (core _shared/npm-arborist), the tree's one model through
 * reification, with its failures named for the user: a dependency it could
 * not resolve must reach them as a failed install, not as a smaller tree.
 */
interface PlannedTree {
  plan: TreePlan<ResolvedPackage, ResolvedPackage>;
  /** Dependency name → why it could not be resolved (a required one). */
  unresolved: Map<string, string>;
  /**
   * Refusals: packages whose own os/cpu/libc allowlists exclude this
   * platform (npm's EBADPLATFORM). `required` decides the exit code —
   * required refusals fail the install with a named `npm ERR!` line each,
   * optional ones do not.
   */
  rejected: RejectedPackage[];
}

/**
 * One refused package the installer left out without aborting.
 * `required` is true when the package was explicitly requested or
 * reached through a required edge (dependencies / required peers);
 * false when it arrived only through optionalDependencies or
 * optional-peer (best-effort) edges.
 */
interface RejectedPackage {
  name: string;
  reason: string;
  required: boolean;
}

/** What a fetch put in place, and what it could not, by placement. */
interface FetchOutcome {
  installed: PackagePlacement[];
  failed: Array<{ target: PackagePlacement; reason: string }>;
  filesWritten: number;
}

/**
 * What an install is asked: the command's spec (NpmInstallSpec), which the
 * hosted port hands on whole, less what the port settles itself (where it
 * installs, the global prefix, the log sink); and the principal, and what
 * runs under the install's hold.
 */
export interface NpmInstallOptions extends Omit<NpmInstallSpec, 'projectDir' | 'packages' | 'global' | 'globalPrefix' | 'npmLog' | 'registry'> {
  /** Explicit packages (`npm install react`). */
  packages?: string[];
  /** The invoking process's credential: what the project is read and written as. */
  cred: VfsCred;
  /** npm-protocol log sink (see --loglevel). */
  npmLog?: NpmLogEmitter;
  /** The command's NPM_REGISTRY; default registry.npmjs.org. */
  registry?: string;
  /** A global prefix's install: npm's shallow layout, and only what is named is built and changed. */
  global?: boolean;
  /** Run under the install's hold, once it has installed; answers the bins it linked. */
  whileHeld?: (result: NpmInstallResult) => Promise<number>;
}

export interface NpmInstallResult {
  installed: string[];
  failed: string[];
  totalFiles: number;
  elapsed: number;
  cachedHits: number;
  phases: Record<string, number>; // phase → ms
  /** The bins `whileHeld` linked. */
  linkedBins?: number;
  /** Each EBADENGINE of the tree (npm's engine check): warnings, or under --engine-strict the install's failure. */
  engines?: EngineMismatch[];
}

/** What a lockfile says is installed: each placement's package, by its registry identity, version and integrity, in placement order. */
function lockRevision(lockfile: ReadonlyMap<string, LockfileEntry>, source: RecordSource): string {
  let revision = `${source.registry}\0${source.network}\n`;
  for (const [at, entry] of [...lockfile].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    revision += `${at}\0${entry.registryName || entry.name}\0${entry.resolvedVer}\0${entry.integrity}\n`;
  }
  return revision;
}

/** The packages of `placements` at the root of node_modules, by placement. */
function rootPackages(placements: readonly PackagePlacement[]): Map<string, ResolvedPackage> {
  return new Map(placements.filter(({ placement }) => depthOf(placement) === 1).map(({ placement, pkg }) => [placement, pkg]));
}

/** Where a batch's receipts go in its install root (FacetPackageSpec.receipt), until it has read them back. */
const RECEIPTS_DIR = '.nimbus-receipts';

// ── NpmInstaller ────────────────────────────────────────────────────────

export class NpmInstaller {
  /** The session's namespace: the project is reached through it as the invoking principal. */
  private readonly filesystem: ProcessFiles;
  private readonly store: SqliteVFS;
  /** What installs in this session are staging or copying now: a sweep leaves them. */
  private readonly placing = new Set<string>();
  private cache: NpmCache;
  /**
   * The installed tree of each project's lockfile, by the lockfile's
   * revision (lockRevision): a lockfile revision is read from its records
   * once, or taken from the tree the install that wrote it planned. The
   * disk is not trusted from it: the diff reads each placement.
   */
  private readonly installedTrees = new LruMap<string, { readonly revision: string; readonly installed: ReadonlyArray<InstalledPackage<ResolvedPackage>> }>(8);
  private esbuild: EsbuildService | null;
  /** The session's esbuild facet pool, shared with the on-demand dev-server path. */
  private bundlePool: BundlePoolProvider | null;
  private ctx: DurableObjectState | undefined;
  private env: any;
  /** Where an install that names no progress sink of its own reports. */
  private readonly onProgress: ((msg: string) => void) | undefined;
  /** The workspace's network: every resolve and install facet (here and in peers) goes out through it. */
  private readonly network: WorkspaceNetwork;

  constructor(
    filesystem: ProcessFiles,
    sql: SqlStorage,
    opts?: {
      esbuild?: EsbuildService;
      bundlePool?: BundlePoolProvider;
      ctx?: DurableObjectState;
      env?: any;
      onProgress?: (msg: string) => void;
      /** The workspace's network (`workspace.network`). */
      network: WorkspaceNetwork;
    },
  ) {
    this.filesystem = filesystem;
    this.store = filesystem.engine;
    this.cache = new NpmCache(sql);
    this.esbuild = opts?.esbuild ?? null;
    this.bundlePool = opts?.bundlePool ?? null;
    this.ctx = opts?.ctx;
    this.env = opts?.env;
    this.onProgress = opts?.onProgress;
    this.network = opts?.network ?? ISOLATE_NETWORK;
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
  async install(projectDir: string, opts: NpmInstallOptions): Promise<NpmInstallResult> {
    const start = Date.now();
    const projDir = projectDir.replace(/^\/+/, '').replace(/\/+$/, '');
    const nmDir = projDir + '/node_modules';
    // The project is read and written through the invoking principal's view
    // of the namespace. The engine's bulk paths (the batch facet, the bin
    // stream, pre-bundling) serve it at its engine key, the project's path
    // with every link resolved; a mounted project has none.
    const view = this.filesystem.view({ pid: opts.pid, cred: opts.cred });
    const engineDir = await engineKey(view, this.store, '/' + projDir);
    // One install into a node_modules tree at a time (core npm-tree.ts
    // holdTree), keyed by the tree itself: its path with every link
    // resolved, so two projects whose node_modules is one tree wait for each
    // other. One that the command stops while it waits never starts.
    const held = holdTree(this.store, await canonicalTreePath(async (path) => view.realpath(path), '/' + nmDir), opts.signal);
    const release = typeof held === 'function' ? held : await held;
    // The session's installs share this installer, and the terminal and npm
    // log each speaks to are its own: they are passed down the install, never
    // kept on the installer, where another install would take them over.
    // Progress goes to this invocation's terminal while the command runs.
    // Work that outlives it (the background pre-bundle) still logs through
    // `log`, and once the command has returned and the prompt is back, that
    // goes to the console instead: never into the next command's output, nor
    // this one's prompt.
    const progress = opts.onProgress ?? this.onProgress;
    let returned = false;
    const log = (msg: string) => {
      if (!returned) {
        progress?.(msg);
        return;
      }
      try { console.log('[npm:late] ' + msg); } catch {}
    };
    // `--loglevel` is the invocation's; one that names none logs nothing.
    const npmLog: NpmLogEmitter = opts.npmLog ?? (() => {});

    // Reset phase to 'idle' on any exit path so /api/_diag/memory
    // never reports a stale phase after a crash unwound the install.
    // The DO reboot would zero this anyway; finally is defense against
    // a non-fatal mid-install throw.
    try {
      const result = await this._installInner(projDir, nmDir, opts, log, npmLog, start, view, engineDir);
      // What the caller publishes from the installed tree (a global prefix's bins), under the same hold.
      if (opts.whileHeld) result.linkedBins = await opts.whileHeld(result);
      return result;
    } finally {
      returned = true;
      setInstallPhase('idle');
      release();
    }
  }

  private async _installInner(
    projDir: string,
    nmDir: string,
    opts: NpmInstallOptions,
    log: (msg: string) => void,
    npmLog: NpmLogEmitter,
    start: number,
    view: ProcessView,
    engineDir: string | null,
  ): Promise<NpmInstallResult> {
    const registry = npmRegistryOrigin(opts?.registry);
    // Every request the install makes goes out through the invoking process's network.
    const network = this.network.forProcess(opts.pid);
    const phases: Record<string, number> = {};
    // What is installed and what failed, by placement: labelled once the outcome is settled.
    const installedAt = new Map<string, string>();
    const failed: string[] = [];
    let totalFiles = 0;
    let cachedHits = 0;

    // ── Phase 0: Lock-check ─────────────────────────────────────────
    setInstallPhase('idle');
    npmLog('verbose', npmTitleLine(opts?.packages ?? []));
    let phaseStart = Date.now();
    log('Checking lockfile...');
    const project = projectFs(view);
    // Where a mounted project's packages are staged; what an install cut
    // short left there goes first.
    const tmp = await engineKey(view, this.store, '/tmp');
    if (tmp !== null) this.sweepStaging(tmp);
    const principal = { pid: opts.pid, cred: opts.cred, view, tmp };
    const lockfile = this.cache.readLockfile(projDir);
    const { roots, named, devOnly, advised, manifest } = await this.buildRoots(projDir, project, opts, log);
    const omit = { dev: opts.production === true, optional: opts.omitOptional === true, peer: opts.omitPeer === true };
    const cache = opts.cache ?? 'default';
    const engine = {
      devOnly, advised, registry, cache, omit,
      global: opts.global === true, force: opts.force === true, strictPeerDeps: opts.strictPeerDeps === true,
      legacyPeerDeps: opts.legacyPeerDeps === true, preferDedupe: opts.preferDedupe === true,
    };
    // A global install builds what it names afresh, and changes nothing
    // outside their folders (reify's explicit requests): the rest of the
    // prefix, and its inventory, are as they were.
    const inScope = (at: string) => !opts.global || named.some(({ name }) => at === name || at.startsWith(`${name}/node_modules/`));

    // ── Phase 1: Resolve ──────────────────────────────────────────
    // The one engine's plan (core _shared/npm-arborist) over the tree installed
    // before: what the lockfile records (each placement's registry record),
    // its unmet edges resolved through the resolver fanout. npm ci plans
    // over the tree package-lock.json records, and the plan must be that
    // tree (validate-lockfile), or it fails before anything changes.
    phaseStart = Date.now();
    setInstallPhase('resolve');
    let tree: PlannedTree;
    let usedLockfile = false;
    if (opts.fromLockfile) {
      const locked = await this.treeFromPackageLock(network, projDir, project, log, npmLog, registry, cache, opts.legacyPeerDeps === true);
      tree = await this.resolveTreeViaFanout(network, roots, locked.installed, log, npmLog, { ...engine, locked: locked.suspect ? 'suspect' : 'trusted' });
      if (tree.plan.lockMismatches.length > 0) {
        throw new Error(
          `\`npm ci\` can only install packages when your package.json and ${locked.lockName} are in sync. ` +
          `Please update your lock file with \`npm install\` before continuing.\n` +
          tree.plan.lockMismatches.map((line) => `npm ERR! ${line}`).join('\n'),
        );
      }
      log(`Lockfile ${locked.lockName}: ${tree.plan.nodes.size} packages to place.`);
    } else {
      const installed = opts.global || lockfile === null ? [] : this.installedTree(projDir, lockfile, { registry, network: network.id });
      tree = await this.resolveTreeViaFanout(network, roots, installed, log, npmLog, engine);
      // The lockfile answered every edge: nothing resolved, nothing failed.
      usedLockfile = lockfile !== null && !tree.plan.resolvedAny && tree.plan.failures.length === 0;
      log(usedLockfile ? `Lockfile valid (${lockfile?.size ?? 0} packages). Skipping resolution.` : `Resolved ${tree.plan.nodes.size} packages.`);
    }
    phases['resolve'] = Date.now() - phaseStart;
    const { plan } = tree;

    // Refusals (npm's EBADPLATFORM) and requests no version meets: required
    // ones fail the install, which changes nothing; optional ones were left out.
    for (const r of tree.rejected) {
      if (!r.required) continue;
      failed.push(r.name);
      log(`npm ERR! ${r.name}: ${r.reason}`);
    }
    for (const [name, reason] of tree.unresolved) {
      failed.push(name);
      log(`npm ERR! could not resolve ${name}: ${reason}`);
    }
    if (failed.length > 0) {
      log(`npm ERR! install incomplete — ${failed.length} missing: ${failed.join(', ')}`);
      return { installed: [], failed, totalFiles: 0, elapsed: Date.now() - start, cachedHits: 0, phases };
    }
    // npm's engine check of the tree: under --engine-strict a mismatch fails
    // the install before anything changes; otherwise npm warns of each.
    const engines = checkEngines(manifest, plan, opts.force === true);
    if (opts.engineStrict === true && engines.length > 0) {
      return { installed: [], failed: [engines[0]!.pkgid ?? projDir], totalFiles: 0, elapsed: Date.now() - start, cachedHits: 0, phases, engines };
    }

    // ── Phase 2: Hoist ────────────────────────────────────────────────
    // The tree to install: what the plan holds, but what it leaves out and,
    // with --omit=dev, what only devDependencies reach.
    phaseStart = Date.now();
    setInstallPhase('hoist');
    /** The plan's placements still to install, root packages first: what it holds but has left out or omits. */
    const installing = (): PackagePlacement[] => {
      const kept: PackagePlacement[] = [];
      for (const [placement, node] of plan.nodes) {
        if (!plan.skipped.has(placement) && !plan.omits(placement, omit)) kept.push({ placement, pkg: node.pkg });
      }
      return [...kept.filter(({ placement }) => depthOf(placement) === 1), ...kept.filter(({ placement }) => depthOf(placement) > 1)];
    };
    phases['hoist'] = Date.now() - phaseStart;

    // A placement that cannot be installed fails the install where it is
    // required; an optional one is left out with its optional set, as npm's
    // reify handleOptionalFailure leaves it out (and removes it).
    const leftOut: string[] = [];
    const failedAt = new Set<string>();
    const cannotInstall = (target: PackagePlacement, reason: string): void => {
      const skippedBefore = new Set(plan.skipped);
      const set = plan.fail(target.placement, reason);
      if (set === null) {
        failed.push(`${target.pkg.name}@${target.pkg.version}`);
        failedAt.add(target.placement);
        log(`npm ERR! ${target.pkg.name}@${target.pkg.version}: ${reason}`);
        return;
      }
      log(`[resolve-fanout] [skip] ${target.pkg.name} — optional: ${reason}`);
      for (const at of set) {
        if (skippedBefore.has(at) || plan.omits(at, omit)) continue;
        installedAt.delete(at);
        leftOut.push(at);
      }
    };
    // Resolved metadata with no tarball cannot be installed: dropping it
    // left the package absent from node_modules and both outcome lists.
    for (const target of installing()) {
      if (!target.pkg.tarballUrl) cannotInstall(target, 'resolved metadata carries no tarball URL');
    }
    if (failed.length > 0) {
      log(`npm ERR! install incomplete — ${failed.length} missing: ${failed.join(', ')}`);
      return { installed: [], failed, totalFiles: 0, elapsed: Date.now() - start, cachedHits: 0, phases, engines };
    }

    // npm ci installs the lock into an empty node_modules: the old tree
    // goes first, once nothing stops the install. Releases before 0.13.2
    // pre-bundled into it as root.
    if (opts.fromLockfile && await project.exists(nmDir)) {
      opts.signal?.throwIfAborted();
      await this.handKernelArtifact(principal, `/${nmDir}/.nimbus-synthetic`);
      await project.removeRecursive(nmDir);
    }

    // ── Phase 3: Diff (cache check) ─────────────────────────────────
    // Per placement: a nested copy is checked at its own directory, read
    // once through the invoking principal's view (and its read cache).
    phaseStart = Date.now();
    setInstallPhase('diff');
    const toFetch: PackagePlacement[] = [];
    /** The version of the package at a placement, by its package.json; undefined where there is none, or it is corrupt. */
    const installedVersion = async (placement: string): Promise<string | undefined> => {
      try {
        const { version }: { version?: unknown } = JSON.parse(await project.readFileString(`${nmDir}/${placement}/package.json`));
        return typeof version === 'string' ? version : undefined;
      } catch { return undefined; }
    };

    for (const target of installing()) {
      const { pkg } = target;
      // Already installed at the placement: that version, and (where the
      // lockfile records it) the same package, an alias's target included.
      const locked = lockfile?.get(target.placement);
      if (locked === undefined || locked.integrity === pkg.integrity) {
        if ((await installedVersion(target.placement)) === pkg.version) {
          installedAt.set(target.placement, `${pkg.name}@${pkg.version}`);
          cachedHits++;
          continue;
        }
      }

      // Not present in the VFS at the right version — fetch it. The batch
      // facet consults the shared L2 (caches.default) + L3 (R2) tarball
      // tiers itself, so a cross-DO warm cache still lands here.
      toFetch.push(target);
    }

    phases['diff'] = Date.now() - phaseStart;
    log(`To fetch: ${toFetch.length}, already installed: ${cachedHits}`);

    // ── Phase 4+5: Fetch + Write (wave-based) ───────────────────────
    phaseStart = Date.now();
    setInstallPhase('fetch');

    // Fetch + extract + write new packages.
    //
    // Single fetch path: one IsolatePool isolate (the batch facet)
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
    // A stop now changes nothing: this is the first write into the tree.
    opts.signal?.throwIfAborted();
    const published: PackagePlacement[] = [];
    if (toFetch.length > 0) {
      log(`Fetching ${toFetch.length} packages... (path: batch-facet)`);
      const batchResult = engineDir !== null
        ? await this.fetchViaBatchFacet(toFetch, `${engineDir}/node_modules`, { engine: this.store.as(opts.cred), view }, opts.pid, cache, log, npmLog)
        : await this.fetchIntoMount(toFetch, nmDir, principal, cache, log, npmLog);
      totalFiles += batchResult.filesWritten;
      published.push(...batchResult.installed);
      for (const { placement, pkg } of batchResult.installed) installedAt.set(placement, `${pkg.name}@${pkg.version}`);
      for (const { target, reason } of batchResult.failed) cannotInstall(target, reason);
    }

    phases['fetch+write'] = Date.now() - phaseStart;
    const commitCount = this.storageCommitCount() - commitsBefore;

    // ── Prune ────────────────────────────────────────────────────────
    // What an earlier install placed that this tree no longer holds is
    // extraneous (a dependency the project dropped, or one a replacement no
    // longer needs), and npm removes it on install, with what an optional
    // failure left out. An install a required failure stopped removes nothing.
    const pruned = failed.length === 0
      ? await withRecall(() => this.pruneExtraneous([...(lockfile?.keys() ?? [])].filter(inScope).concat(leftOut), installing(), nmDir, project, log))
      : 0;

    // ── Phase 6: Link bins ──────────────────────────────────────────
    phaseStart = Date.now();
    setInstallPhase('link-bins');
    // The tree is the whole project's, so its root packages' bins are all of
    // them, but those of a package that failed.
    // Linking a bin again links it as before: repeatable, so it waits for a delegation it meets.
    const linked = rootPackages(installing().filter(({ placement }) => !failedAt.has(placement)));
    // A global install's bins join those of the prefix's other packages.
    const manifestPath = npmBinManifestPath(nmDir);
    const keptBins = opts.global && await project.exists(manifestPath)
      ? Object.values(parseNpmBinManifest(await project.readFileString(manifestPath))?.bins ?? {}).filter((bin) => !inScope(bin.packageName))
      : [];
    await withRecall(() => this.linkBins(linked, engineDir === null ? { fs: project, nmDir } : { engine: this.store.as(opts.cred), nmDir: `${engineDir}/node_modules` }, keptBins));
    phases['link-bins'] = Date.now() - phaseStart;

    // ── Write lockfile ──────────────────────────────────────────────
    // The lockfile is the inventory pruning reads, so it records what is on
    // disk: the tree, or, after a required failure, what it held before with
    // what this install published over it.
    if (failed.length > 0) this.writeLockfile(projDir, published, nmDir, lockfile, opts.fromLockfile ? null : lockfile);
    else if (!usedLockfile || pruned > 0) {
      const placements = installing();
      const written = this.writeLockfile(projDir, placements, nmDir, lockfile, opts.global ? new Map([...lockfile ?? []].filter(([at]) => !inScope(at))) : null);
      // npm ci's packages are the lock's, not the registry records' an install reads.
      if (!opts.global && !opts.fromLockfile) this.installedTrees.set(projDir, { revision: lockRevision(written, { registry, network: network.id }), installed: placements.map(({ placement, pkg }) => ({ at: placement, pkg })) });
    }

    const installed = [...installedAt.values()];

    // ── Update package.json if explicit packages were added ─────────
    if (named.length > 0 && failed.length === 0 && opts.save !== false && !opts.global) {
      await this.updatePackageJson(projDir, project, principal, named, (name) => (plan.skipped.has(name) ? null : plan.nodes.get(name)?.pkg.version ?? null), opts.savePrefix);
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
    // Pre-bundling slices node_modules out of the engine for the bundle
    // pool and warms the dev server's cache, which serves projects on
    // SQLite only; a mounted project skips it.
    if (this.esbuild && engineDir !== null) {
      // Releases before 0.13.2 pre-bundled as root.
      await this.handKernelArtifact(principal, `/${engineDir}/node_modules/.nimbus-synthetic`);
      phaseStart = Date.now();
      setInstallPhase('bundle');
      // Fire-and-forget: the install resolves now and the bundle finishes in
      // the background (see the Phase 7 design note above). Its progress goes
      // through this invocation's `log`, which turns to the console once the
      // command has returned, so a late line never lands on the redrawn
      // prompt or in another install's output.
      void withRecall(() => this.prebundleUsedModules(engineDir, rootPackages(installing()), this.store.as(opts.cred), log, opts.pid, opts.signal))
        .catch((e: unknown) => log(`pre-bundle skipped: ${errorText(e)}`));
      phases['bundle'] = Date.now() - phaseStart;
    }

    setInstallPhase('done');
    const elapsed = Date.now() - start;
    if (failed.length > 0) {
      // Never claim success for a partial install: the next command is
      // where the missing package surfaces, as an unrelated-looking error.
      // What it did publish is named, since the tree is not the one planned.
      log(
        `npm ERR! install incomplete — ${failed.length} failed: ${failed.join(', ')}; ` +
        `${published.length} published: ${published.map(({ pkg }) => `${pkg.name}@${pkg.version}`).join(', ') || 'none'}; ` +
        'nothing removed, package.json unchanged',
      );
    } else {
      const nested = installing().filter(({ placement }) => depthOf(placement) > 1).length;
      const nestedNote = nested > 0 ? ` (${nested} nested)` : '';
      log(`Done! ${installed.length} packages${nestedNote}, ${totalFiles} files in ${(elapsed / 1000).toFixed(1)}s`);
      // npm's own summary line, unstyled: the styled one the command site
      // prints carries a colour prefix that no log parser matches. Carried
      // at `http` — the level from which this stream is machine-readable —
      // so a caller reading prose never sees the summary twice.
      npmLog('http', npmAddedLine(installed.length, elapsed));
    }
    if (cachedHits > 0) {
      log(`  (${cachedHits} from cache)`);
    }
    // The per-phase timings were computed on every install and then
    // dropped, so "install took 60s" carried no information about which
    // phase owned the 60s. Emit the breakdown next to the total it
    // decomposes. `bundle` is dispatch-only (Phase 7 is fire-and-forget).
    log(
      '  phases: ' +
      Object.entries(phases)
        .map(([name, ms]) => `${name}=${fmtPhaseMs(ms)}`)
        .join(' '),
    );
    log(`  storage: ${commitCount} transactions during fetch+write`);
    // The same breakdown in Workers Logs, under the session's Durable
    // Object: a slow install is traced there by phase, beside whatever else
    // that object ran meanwhile (tests/behavioral/perf-regression/install-warm.mjs).
    console.log(`[npm:phases] ${JSON.stringify({ installed: installed.length, failed: failed.length, cachedHits, elapsed, commits: commitCount, phases })}`);

    return { installed, failed, totalFiles, elapsed, cachedHits, phases, engines };
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
  private async resolveTreeViaFanout(
    /** The invoking process's network (WorkspaceNetwork.forProcess): every packument read goes through it. */
    network: WorkspaceNetwork,
    roots: readonly TreeRoot[],
    installed: ReadonlyArray<InstalledPackage<ResolvedPackage>>,
    log: (msg: string) => void,
    npmLog: NpmLogEmitter,
    opts: PlanOptions & {
      devOnly?: ReadonlySet<string>;
      advised?: Set<string>;
      registry?: string;
      /** npm's cache mode for the packuments read. */
      cache?: NpmCacheMode;
      /** What `--omit` leaves out is planned, not installed, and not announced. */
      omit?: OmitTypes;
    } = {},
  ): Promise<PlannedTree> {
    const t0 = Date.now();
    const registry = npmRegistryOrigin(opts.registry);
    const cache = opts.cache ?? 'default';
    const devOnly = opts.devOnly ?? new Set<string>();
    // Policy advisories already announced — one `note:` line per name
    // per install, shared with applyW6Registry which runs first.
    const advised = opts.advised ?? new Set<string>();
    const noteAdvisory = (ev: { from: string; reason: string; suggest?: string }) => {
      if (advised.has(ev.from)) return;
      advised.add(ev.from);
      const hint = ev.suggest ? ` … try: ${ev.suggest}` : '';
      const marker = devOnly.has(ev.from) ? ' (declared in devDependencies)' : '';
      log(`[npm] note: ${ev.from} has no Workers-compatible build${marker}: ${ev.reason}${hint}`);
    };
    const __f2Diag = ((globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');

    // Dependencies the plan could not resolve, name → reason.
    const unresolved = new Map<string, string>();
    // What the policy says of a package, announced once the plan says it
    // is installed: an advisory (no Workers-compatible build) by name, a
    // native executable by name@version, a refusal's hint by name.
    const advisories = new Map<string, { from: string; reason: string; suggest?: string }>();
    const nativeExecutables = new Map<string, { from: string; reason: string; suggest?: string }>();
    const refusalHints = new Map<string, string>();
    const cacheWritesPending: RegistryCacheEntry[] = [];
    let totalPackumentBytes = 0;
    let totalPackumentsDecoded = 0;
    let layerN = 0;
    let totalLayers = 0;
    let r2Wins = 0;
    let r2Losses = 0;
    // Layers are a hard barrier: layer N+1 cannot be built until every
    // task in layer N returns. `width@ms/route` per layer is what separates
    // "resolution is slow because there are many packuments" from
    // "resolution is slow because there are many barriers".
    const layerProfile: string[] = [];
    // Set by the pool as each layer is routed, before it dispatches.
    const layerRoute: { taken?: FanoutRoute } = {};
    // Every layer additionally splits into peer-DO dispatch phases, each its
    // own barrier, so the walk's real serialization is the barrier total
    // rather than the layer count.
    let dispatchBarriers = 0;
    // cache-obs-2: accumulator for per-tier cache events across all
    // resolve-one tasks in this fanout walk. Drained at end-of-walk
    // into the DO singleton via recordCacheStatEvents.
    const fanoutCacheStatEvents: NonNullable<ResolveOneResult['cacheStatEvents']> = [];

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
    const fanoutPool = new Fanout(this.env, this.ctx!, {
      tag: 'npm-resolve-fanout',
      network,
      // 5 minutes per layer is generous; typical layers complete in
      // 1-3 s. Per-task this gates each packument fetch + R2 race.
      timeoutMs: 5 * 60_000,
      preamble: NPM_RESOLVE_PREAMBLE,
      onDispatchPhase: () => { dispatchBarriers++; },
      onRoute: (route) => { layerRoute.taken = route; },
      // One peer per package is what this dispatched before, and resolving a
      // package is one cached-packument read — far too little work to pay a
      // sibling DO start for. A 123-package install walked 8 layers as 23
      // barriers (33-wide layer: 8.2 s to serve 33 reads that all hit the
      // cache), because a layer of width W costs ⌈min(W,32)/FANOUT_PHASE_SIZE⌉
      // of them. Capping peers here is the same fix INSTALL_PEER_CAP already
      // applies to the write side, and it does not cost concurrency: each peer
      // runs its bucket as wide as its own Dynamic Worker headroom allows.
      maxPeers: RESOLVE_PEER_CAP,
    });

    // The one engine's plan (core _shared/npm-arborist) over the
    // resolver facets, from the tree installed before (`installed`): each
    // batch of requests it makes dispatched as ONE submitMany batch, every
    // task settled on its own, so a request that fails is that request's
    // failure, classified where it is placed.
    const plan = await planTree<ResolvedPackage, ResolvedPackage>(
      roots,
      installed,
      {
        resolve: async (layer) => {
          if (totalLayers === 0) log(`Resolving ${layer.length} dependencies (path: fanout)...`);
          if (__f2Diag) log(`[f2-frontier] N=${layerN} width=${layer.length}`);
          // Track peak — the layer is dispatched in parallel inside the pool.
          if (layer.length > inFlightPeak) inFlightPeak = layer.length;
          totalLayers++;

          // An exact version's record, where this registry's (through this
          // network) is cached: the cache holds some versions of a package,
          // never the registry's whole list, so a range is the packument's
          // to answer (npm-pick-manifest's choice needs every version).
          const requests = layer.map(({ name, range }) => {
            const request = parseRegistryRequest(name, range);
            return { request, exact: exactVersion(request.range) };
          });
          const records = this.cache.getRegistryEntries({ registry, network: network.id },
            requests.flatMap(({ request, exact }): Array<[string, string]> => (exact === null ? [] : [[request.registryName, exact]])));
          const tasks = layer.map(({ name, range }, at) => {
            const { request, exact } = requests[at]!;
            const record = exact === null ? null : records.get(`${request.registryName}@${exact}`) ?? null;
            const taskSpec: ResolveOneSpec = {
              name,
              range,
              cachedEntries: record === null ? [] : [record],
              fetchTimeoutMs: 15_000,
              retries: 3,
              registry,
              cache,
            };
            return { key: `${name}@${range}`, args: taskSpec };
          });

          // Dispatch the layer. Fanout routes it in-DO when the session's
          // Dynamic Worker headroom holds the layer, else across sibling DOs.
          const layerT0 = Date.now();
          const results = await fanoutPool.submitManySettled<ResolveOneSpec, ResolveOneResult>(tasks, NPM_RESOLVE_ONE_TASK);
          layerProfile.push(`${layer.length}@${Date.now() - layerT0}ms/${layerRoute.taken?.topology}`);

          // Each dispatched request is answered: one the fanout failed to
          // deliver is that request's failure (no fallback, and no retry
          // beyond the task's own).
          const answers = layer.map(({ name: taskName }, i): TreeResolution<ResolvedPackage> => {
            const settled = results[i];
            if (!settled) return { failed: `resolver fanout returned no result at layer ${layerN}` };
            if (!settled.ok) {
              const reason = `resolver fanout failed: ${describeError(settled.error)} (${layerRoute.taken?.topology})`;
              log(`  resolver-fanout ${taskName}: ${reason}`);
              return { failed: reason };
            }
            const res = settled.value;

            // Forward messages + events. `advisory` events are the policy's
            // "cannot run here" list — one note per name per install.
            for (const m of res.messages) log(m);
            for (const ev of res.events) {
              try { emitRegistryEvent(ev); } catch { /* swallow sink errors */ }
              if (ev.type === 'advisory') advisories.set(ev.from, ev);
            }

            // Accumulate cache writes for end-of-walk flush.
            for (const cw of res.cacheWrites) cacheWritesPending.push(cw);
            // cache-obs-2: harvest per-task cache events for end-of-walk fold.
            if (res.cacheStatEvents) fanoutCacheStatEvents.push(...res.cacheStatEvents);
            // One `npm http` line per packument, reporting the tier that actually served it.
            if (res.packumentSource === 'network') {
              npmLog('http', npmHttpFetchLine(packumentUrl(taskName, registry), res.packumentElapsedMs));
            } else {
              npmLog('http', npmHttpCacheLine(packumentUrl(taskName, registry)));
            }
            totalPackumentBytes += res.packumentBytesDecoded;
            if (res.packumentSource === 'r2-cache') r2Wins++;
            else if (res.packumentSource === 'network') r2Losses++;
            if (res.packumentBytesDecoded > 0) totalPackumentsDecoded++;

            // w6-reject: an os/cpu/libc platform-gate refusal — npm's
            // EBADPLATFORM. Announced as a [skip] line now and classified
            // required-vs-optional at end of walk, when the required-edge
            // closure is final. Table rejects are advisories handled above and
            // never reach this branch.
            if (res.error && res.error.type === 'w6-reject') {
              if (res.error.suggest) refusalHints.set(taskName, ` … try: ${res.error.suggest}`);
              if (!res.pkg) return { failed: `the resolver refused ${taskName} without its package: ${res.error.reason}` };
              return { package: res.pkg, refused: res.error.reason };
            }
            // Resolution failure: a dependency the project asked for and did
            // not get; the plan skips it, with what needs it, if it is optional.
            if (res.error && res.error.type === 'unresolved') return { failed: res.error.reason };

            const pkg = res.pkg;
            // A package with no reason is a resolver bug: dropping it is how a
            // required dependency and its subtree once vanished from an
            // install that then reported success.
            if (!pkg) return { failed: 'resolver returned no package and no reason' };

            // What cannot run here is left out where the plan finds it
            // optional, over the complete graph: a native executable the
            // policy names (res.nativeExecutable), or a platform-native
            // binding (X.5-G G1). Where required, it installs, and says so.
            const binding = isOptionalNativeBinding({ name: pkg.name, os: pkg.os, cpu: pkg.cpu, libc: pkg.libc, main: pkg.main })
              ? `optional native binding (os=${pkg.os ?? '*'}, cpu=${pkg.cpu ?? '*'}, libc=${pkg.libc ?? '*'}, main=${pkg.main || '?'})`
              : undefined;
            const skipIfOptional = res.nativeExecutable?.reason ?? binding;
            if (res.nativeExecutable) nativeExecutables.set(`${pkg.name}@${pkg.version}`, res.nativeExecutable);
            return skipIfOptional === undefined ? { package: pkg } : { package: pkg, skipIfOptional };
          });
          layerN++;
          return answers;
        },
        // A peer conflict npm lets through: said the way npm does.
        warn: (message) => log(`npm WARN ${message}`),
      },
      opts,
    );

    // What the tree installs that cannot run here is said once.
    const installing = (at: string) => !plan.skipped.has(at) && !plan.omits(at, opts.omit ?? {});
    for (const [at, node] of plan.nodes) {
      if (!installing(at)) continue;
      const advisory = advisories.get(node.pkg.registryName ?? node.pkg.name) ?? advisories.get(node.pkg.name);
      if (advisory) noteAdvisory(advisory);
      const native = nativeExecutables.get(`${node.pkg.name}@${node.pkg.version}`);
      if (native) noteAdvisory(native);
    }
    // What could not be met: a required failure is unresolved (a refused
    // one, a refusal, below); an optional one is skipped, said as it was.
    for (const { id, edge, reason, refused } of plan.failures) {
      if (refused) continue;
      if (plan.required.has(id)) {
        unresolved.set(edge.name, reason);
        continue;
      }
      log(`[resolve-fanout] [skip] ${edge.name} — optional dep unresolved: ${reason}`);
      emitRegistryEvent({ type: 'transitive-skip', from: edge.name, reason: `optional dep unresolved: ${reason}` });
    }
    for (const [at, reason] of plan.reasons) {
      const node = plan.nodes.get(at);
      if (!node || plan.omits(at, opts.omit ?? {})) continue;
      log(`[resolve-fanout] [skip] ${node.pkg.name} — ${reason}${refusalHints.get(node.pkg.name) ?? ''}`);
      emitRegistryEvent({ type: 'transitive-skip', from: node.pkg.name, reason });
    }
    // Refusals: npm's EBADPLATFORM, required when a required path reaches them.
    const rejected: RejectedPackage[] = plan.failures
      .filter(({ refused }) => refused)
      .map(({ id, edge, reason }) => ({ name: edge.name, reason, required: plan.required.has(id) }));

    // A plan the lockfile answered whole resolved nothing: nothing to flush or report.
    if (totalLayers === 0) return { plan, unresolved, rejected };

    // End-of-walk: flush all cache writes in one RPC-equivalent call
    // (this.cache is a SQLite handle; one putRegistryEntries call =
    // O(N) prepared statements within a single DO event-loop turn,
    // atomically committed by the storage layer).
    let cacheWriteCount = 0;
    if (cacheWritesPending.length > 0) {
      const r = this.cache.putRegistryEntries({ registry, network: network.id }, cacheWritesPending);
      cacheWriteCount = r.written;
      if (r.failed > 0) log(`  resolver-fanout cache write: ${r.failed} entries failed`);
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
    log(
      `  resolver-fanout: ${plan.nodes.size} resolved, ` +
      `${totalPackumentsDecoded} packuments fetched (` +
      `${(totalPackumentBytes / (1024 * 1024)).toFixed(1)} MiB), ` +
      `peak in-flight=${inFlightPeak}, ` +
      `cache writes=${cacheWriteCount}` +
      r2WinSuffix +
      `, layers=${totalLayers} [${layerProfile.join(' ')}]` +
      `, dispatch barriers=${dispatchBarriers}, ` +
      `elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (unresolved.size > 0 ? `, unresolved=${unresolved.size}` : ''),
    );

    return { plan, unresolved, rejected };
  }

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
  private async fetchViaBatchFacet(
    toFetch: PackagePlacement[],
    nmDir: string,
    /**
     * The invoking principal's faces, which read back what a failed shard
     * published under `nmDir`: the engine, where its packages are; and its
     * namespace, which the batch's waves write through, for its receipts.
     */
    reader: { engine: CredentialedVfs; view: ProcessView },
    pid: number,
    /** npm's cache mode for the tarballs read (InstallBatchSpec.cache). */
    cache: NpmCacheMode,
    log: (msg: string) => void,
    npmLog: NpmLogEmitter,
  ): Promise<FetchOutcome> {
    const installed: PackagePlacement[] = [];
    const failed: FetchOutcome['failed'] = [];
    let filesWritten = 0;

    const mtime = Date.now();
    const { engine, view } = reader;
    // Each placement's completion marker, its package.json: the package it
    // names (name@version), before the dispatch and after it.
    const markerOf = (placement: string) => `${nmDir}/${placement}/package.json`;
    const identity = (placement: string): string | null => {
      if (engine.statIfPresent(markerOf(placement), false) === null) return null;
      try {
        const { name, version }: { name?: unknown; version?: unknown } = JSON.parse(engine.readFileString(markerOf(placement)));
        return typeof name === 'string' && typeof version === 'string' ? `${name}@${version}` : null;
      } catch { return null; }
    };
    const wanted = ({ pkg }: PackagePlacement) => `${pkg.registryName ?? pkg.name}@${pkg.version}`;
    const before = new Map<string, string | null>();
    for (const { placement } of toFetch) before.set(placement, await withRecall(() => identity(placement)));
    // A replacement whose marker already names it (the same name@version,
    // another tarball) is read back by its receipt instead, in the receipts
    // folder: what an install cut short left there goes first. Receipts are
    // read and removed through the namespace the waves write them through.
    const receipts = `/${nmDir}/${RECEIPTS_DIR}`;
    const receiptOf = new Map<string, string>();
    const unattributable = toFetch.filter((target) => before.get(target.placement) === wanted(target));
    if (unattributable.length > 0) {
      if (await view.exists(receipts)) for (const { name } of await view.readdir(receipts)) await view.remove(`${receipts}/${name}`, { recursive: true });
      const acquisition = crypto.randomUUID();
      unattributable.forEach(({ placement }, i) => receiptOf.set(placement, `${nmDir}/${RECEIPTS_DIR}/${acquisition}-${i}`));
    }
    /** Whether this batch published `target`: its receipt landed, or its marker now names it and named another before. */
    const landedHere = async (target: PackagePlacement): Promise<boolean> => {
      const receipt = receiptOf.get(target.placement);
      if (receipt !== undefined) return await view.exists(`/${receipt}`);
      return await withRecall(() => identity(target.placement)) === wanted(target);
    };

    // Every entry in `toFetch` has a tarball URL — the diff phase fails
    // the ones that don't rather than dropping them. `pkgDir` is the
    // spec's identity: one version may land at two placements.
    const specs: FacetPackageSpec[] = toFetch
      .map(({ placement, pkg: p }) => {
        const receipt = receiptOf.get(placement);
        return {
          name: p.name,
          version: p.version,
          tarballUrl: p.tarballUrl,
          integrity: p.integrity || '',
          pkgDir: nmDir + '/' + placement,
          installRoot: nmDir,
          mtime,
          ...(receipt === undefined ? {} : { receipt }),
        };
      });

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
    // A tarball's placements share a shard, which acquires it once.
    const byTarball = new Map<string, FacetPackageSpec[]>();
    for (const spec of specs) {
      const group = byTarball.get(spec.tarballUrl);
      if (group) group.push(spec);
      else byTarball.set(spec.tarballUrl, [spec]);
    }
    const shardCount = Math.min(byTarball.size, INSTALL_PEER_CAP);
    // Round-robin assignment: tarball at idx → shard idx % shardCount.
    // This produces ⌈tarballs / shardCount⌉ tarballs per shard at
    // most, with the imbalance bounded to ±1.
    const shards: FacetPackageSpec[][] = Array.from(
      { length: shardCount },
      () => [],
    );
    [...byTarball.values()].forEach((group, idx) => {
      shards[idx % shardCount].push(...group);
    });
    const nonEmptyShards = shards.filter((s) => s.length > 0);

    // Logged as Fanout routes the batch, so the line names the route taken.
    const batchRoute: { taken?: FanoutRoute } = {};
    const onRoute = (route: FanoutRoute) => {
      batchRoute.taken = route;
      log(
        `Dispatching ${specs.length} packages across ${route.tasks} ` +
        `shard${route.tasks === 1 ? '' : 's'} (${route.topology}, dynamic-worker headroom ${route.headroom}, internal pLimit=3)...`,
      );
    };

    // Peer shards dispatch in bounded phases and each phase is a barrier, so
    // the phase profile is what distinguishes shard work from barrier count.
    const phaseProfile: string[] = [];
    const fanoutPool = new Fanout(this.env, this.ctx!, {
      tag: 'npm-install-batch',
      network: this.network.forProcess(pid ?? 0),
      // Whole-batch timeout. With per-shard parallelism of N=8 peer
      // DOs each running pLimit(3), Mossaic-class 456 packages
      // typical 30-60 s wall clock. 10 min covers pathological cases.
      timeoutMs: 10 * 60_000,
      // W7: tar-stream + W7-frame preambles concatenated. Forwarded
      // to every facet (in-DO and per-peer) so each shard's facet
      // can encode its own write-batch stream.
      preamble: TAR_STREAM_PREAMBLE + '\n' + W7_FRAME_PREAMBLE + '\n' + WAVE_WRITER_PREAMBLE + '\n' + NPM_INSTALL_PREAMBLE,
      // Authorize each facet's writeBatchStream under the invoking
      // process credential; without a positive pid the supervisor
      // rejects the write (S2a cred enforcement).
      supervisorPid: pid,
      onDispatchPhase: (width, elapsedMs) => phaseProfile.push(`${width}@${elapsedMs}ms`),
      onRoute,
    });

    const tasks = nonEmptyShards.map((shardSpecs, shardIdx) => ({
      // Stable-id router key. Same shardIdx → same peer DO across
      // runs. Tests can predict placement via Fanout's
      // `peerSiblingId(key, peerCount)` helper.
      key: `shard-${shardIdx}`,
      args: { packages: shardSpecs, concurrency: 3, ...(cache === 'default' ? {} : { cache }) } as InstallBatchSpec,
    }));

    try {
      // Every shard settles on its own: one that fails costs its packages,
      // never what the others published.
      const settled = await fanoutPool.submitManySettled<InstallBatchSpec, InstallBatchResult>(tasks, NPM_INSTALL_BATCH_TASK);
      const shardResults = settled.flatMap((outcome) => (outcome.ok ? [outcome.value] : []));
      const readBack: InstallBatchResult['perPackage'] = [];
      // A shard that failed (or timed out, its writes perhaps landed) is
      // read back from disk: a package this batch published (landedHere) is
      // installed; the rest failed with it, a copy that was there before
      // included.
      for (const [index, outcome] of settled.entries()) {
        if (outcome.ok) continue;
        const reason = `install shard failed: ${describeError(outcome.error)} (${batchRoute.taken?.topology})`;
        log(`  [batch-fanout] ${reason}`);
        const dirs = new Set(tasks[index].args.packages.map((spec) => spec.pkgDir));
        for (const target of toFetch) {
          if (!dirs.has(`${nmDir}/${target.placement}`)) continue;
          const landed = await landedHere(target);
          readBack.push({ name: target.pkg.name, version: target.pkg.version, pkgDir: `${nmDir}/${target.placement}`, fileCount: 0, bytesWritten: 0, elapsed: 0, warnings: [], ...(landed ? {} : { errorText: reason }) });
        }
      }

      // Merge per-shard InstallBatchResult into a single result for
      // the rest of the function. Maintain input order: the
      // round-robin sharding means perPackage entries are NOT in
      // input order, but the rest of fetchViaBatchFacet uses set
      // semantics (installed/failed are unordered string lists,
      // filesWritten is summed) so we don't need to re-order.
      const result: InstallBatchResult = {
        perPackage: [...shardResults.flatMap((r) => r.perPackage), ...readBack],
        elapsed: Math.max(0, ...shardResults.map((r) => r.elapsed)),
        facetCounters: mergeFacetCounters(shardResults.map((r) => r.facetCounters)),
        // cache-obs-2: merge per-shard cacheStatEvents (flat
        // concatenation). Each shard's events are independent.
        cacheStatEvents: shardResults.flatMap((r) => r.cacheStatEvents),
      };

      let okCount = 0;
      let failCount = 0;
      const reported = new Set<string>();
      const specByDir = new Map(specs.map((s) => [s.pkgDir, s]));
      const targetByDir = new Map(toFetch.map((target) => [`${nmDir}/${target.placement}`, target]));
      for (const r of result.perPackage) {
        // A pre-placement shard reports no pkgDir; it only wrote root.
        const dir = r.pkgDir ?? `${nmDir}/${r.name}`;
        const target = targetByDir.get(dir);
        if (!target || reported.has(dir)) continue;
        reported.add(dir);
        // One `npm http` line per tarball, reporting the tier that served it.
        const spec = specByDir.get(dir);
        if (spec && r.tarballSource) {
          npmLog('http', r.tarballSource === 'registry'
            ? npmHttpFetchLine(spec.tarballUrl, r.tarballElapsedMs ?? 0)
            : npmHttpCacheLine(spec.tarballUrl, spec.integrity || undefined));
        }
        if (r.errorText) {
          failed.push({ target, reason: r.errorText });
          log(`  [warn] ${r.name}@${r.version}: ${r.errorText}`);
          failCount++;
          continue;
        }
        installed.push(target);
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
      for (const target of toFetch) {
        const dir = `${nmDir}/${target.placement}`;
        if (reported.has(dir)) continue;
        failed.push({ target, reason: 'install shard returned no result for this package' });
        failCount++;
        log(`  [warn] ${target.pkg.name}@${target.pkg.version}: install shard returned no result for this package (${dir})`);
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
      log(
        `Batch-facet complete: ${okCount}/${specs.length} packages, ` +
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
        (failCount > 0 ? ` (${failCount} failed)` : ''),
      );
      return { installed, failed, filesWritten };
    } catch (e: any) {
      // Final catch — preserved from the pre-fix shape so the error
      // log line shape stays consistent. Fanout's internal
      // pools dispose themselves at the end of each submitMany call,
      // so no explicit dispose() is needed here.
      // The earlier inner-catch already logged + threw; if we reach
      // here, the throw bubbled — re-throw to preserve the install
      // command's failure semantics.
      throw e instanceof Error ? e : new Error(describeError(e));
    } finally {
      // This batch's receipts go, then the folder where it is an empty one (not where something is mounted there).
      for (const receipt of receiptOf.values()) await view.remove(`/${receipt}`, { force: true }).catch(() => {});
      if (receiptOf.size > 0) await view.rmdir(receipts).catch(() => {});
    }
  }

  /**
   * A mounted project's packages. The batch facet writes only the engine,
   * so it extracts them into a staging directory in /tmp there, as the
   * invoking principal whose batch writes it authorizes. Each placed
   * package is then put in the mounted node_modules through the
   * principal's view whole or not at all (placeMountedPackage); a package
   * that cannot be put there fails alone. What an install cut short left in
   * /tmp or beside a package is swept by the next one.
   */
  private async fetchIntoMount(
    toFetch: PackagePlacement[],
    nmDir: string,
    principal: { pid: number; cred: VfsCred; view: ProcessView; tmp: string | null },
    cache: NpmCacheMode,
    log: (msg: string) => void,
    npmLog: NpmLogEmitter,
  ): Promise<FetchOutcome> {
    const { view, tmp } = principal;
    if (tmp === null) {
      throw new Error(`installing into /${nmDir} stages the packages in /tmp, which is not on the workspace filesystem`);
    }
    const staging = this.store.as(principal.cred);
    const stage = `${tmp}/${STAGE_PREFIX}${principal.pid}-${Date.now().toString(36)}`;
    // The engine's own calls here wait for a delegation they meet (withRecall): each is repeatable.
    await withRecall(() => staging.mkdir(stage, { recursive: true }));
    this.placing.add(stage);
    try {
      const result = await this.fetchViaBatchFacet(toFetch, `${stage}/node_modules`, { engine: staging, view }, principal.pid, cache, log, npmLog);
      const installed = [...result.installed];
      const failed = [...result.failed];
      // What failed is not put on the mount: its staged files (part of a
      // package, perhaps) go, also where they sit beneath one that landed.
      // Nor what was staged beneath it, which goes with it: failed too.
      for (const { target } of [...failed]) {
        const path = `${stage}/node_modules/${target.placement}`;
        if (await withRecall(() => staging.exists(path))) await withRecall(() => staging.removeRecursive(path));
        for (const nested of toFetch) {
          if (!nested.placement.startsWith(`${target.placement}/node_modules/`)) continue;
          const held = installed.indexOf(nested);
          if (held >= 0) installed.splice(held, 1);
          if (!failed.some((f) => f.target === nested)) failed.push({ target: nested, reason: `staged beneath ${target.pkg.name}@${target.pkg.version}, which failed` });
        }
      }
      const placed = new Set(toFetch.map(({ placement }) => placement));
      // A nested placement is put there with the package that holds it, when that is placed too.
      const tops = [...placed].filter((placement) => {
        for (let at = placement.lastIndexOf('/node_modules/'); at > 0; at = placement.lastIndexOf('/node_modules/', at - 1)) {
          if (placed.has(placement.slice(0, at))) return false;
        }
        return true;
      });
      log(`Copying ${tops.length} package${tops.length === 1 ? '' : 's'} into /${nmDir}...`);
      await view.mkdir(`/${nmDir}`, { recursive: true });
      const renames = await canRename(view, `/${nmDir}`);
      const swept = new Set<string>();
      for (const placement of tops) {
        const from = `${stage}/node_modules/${placement}`;
        if (!await withRecall(() => staging.exists(from))) continue;
        const dst = `/${nmDir}/${placement}`;
        const parent = dst.slice(0, dst.lastIndexOf('/'));
        try {
          await view.mkdir(parent, { recursive: true });
          if (!swept.has(parent)) {
            swept.add(parent);
            await this.sweepCopies(view, parent);
          }
          await this.placeMountedPackage(staging, from, view, dst, renames);
        } catch (error) {
          // The package, and every placement put there with it, is not installed.
          const reason = `could not be put in ${dst}: ${describeError(error)}`;
          for (const target of toFetch) {
            if (target.placement !== placement && !target.placement.startsWith(`${placement}/node_modules/`)) continue;
            const held = installed.indexOf(target);
            if (held >= 0) installed.splice(held, 1);
            if (!failed.some((f) => f.target === target)) failed.push({ target, reason });
          }
          log(`  [warn] ${placement}: could not be put in ${dst}: ${describeError(error)}`);
        }
      }
      return { installed, failed, filesWritten: result.filesWritten };
    } finally {
      this.placing.delete(stage);
      try { staging.removeRecursive(stage); } catch { /* the next install's sweep removes it */ }
    }
  }

  /** Staging directories in `tmp` no install in this session is using: an install cut short left them. */
  private sweepStaging(tmp: string): void {
    // Each as the user who owns it: another user's staging directory in the
    // sticky /tmp is still this installer's to clear, but what its owner
    // could not remove is not (a directory moved to a stage's name, holding
    // root's files, is not the kernel's to empty). As that user with no
    // group: a stage's group is no proof its owner is in it (a setgid
    // directory gives its own), and the owner's own files need none.
    const kernel = this.store.as(CRED_KERNEL);
    let entries: { name: string; type: string }[];
    try { entries = kernel.readdir(tmp); } catch { return; }
    for (const entry of entries) {
      const path = `${tmp}/${entry.name}`;
      if (entry.type !== 'directory' || !entry.name.startsWith(STAGE_PREFIX) || this.placing.has(path)) continue;
      try {
        const { uid } = kernel.lstat(path);
        this.store.as({ uid, gid: NO_GROUP, groups: [], umask: 0o022 }).removeRecursive(path);
      } catch { /* tried again next time */ }
    }
  }

  /** Copies beside the packages in `dir` (on a mount) no install in this session is using. */
  private async sweepCopies(view: ProcessView, dir: string): Promise<void> {
    for (const entry of await view.readdir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (!entry.name.startsWith(COPY_PREFIX) || this.placing.has(path)) continue;
      await view.remove(path, { recursive: true });
    }
  }

  /**
   * The package staged at `src` on the engine, put at `dst` on a mount. It is
   * copied beside `dst` and renamed into place, so `dst` holds the old
   * package or the whole new one; packages the old one held in its own
   * node_modules that the new one does not bring stay. On a mount that
   * cannot rename, the files go in place with package.json last, so a copy
   * cut short reads as not installed and the next install puts it there.
   */
  private async placeMountedPackage(from: CredentialedVfs, src: string, view: ProcessView, dst: string, renames: boolean): Promise<void> {
    if (!renames) {
      if (await view.exists(`${dst}/package.json`)) await view.unlink(`${dst}/package.json`);
      await copyTreeInto(from, src, view, dst, true);
      return;
    }
    const cut = dst.lastIndexOf('/');
    const copy = `${dst.slice(0, cut)}/${COPY_PREFIX}${dst.slice(cut + 1)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const old = `${copy}-old`;
    this.placing.add(copy).add(old);
    try {
      await copyTreeInto(from, src, view, copy, false);
      if ((await view.stat(dst, { follow: false })) === null) {
        await view.rename(copy, dst);
        return;
      }
      await view.rename(dst, old);
      try {
        await view.rename(copy, dst);
      } catch (error) {
        await view.rename(old, dst).catch(() => { /* the next install puts it there */ });
        throw error;
      }
      const kept = `${old}/node_modules`;
      if (await view.isDirectory(kept)) {
        for (const name of await nodeModulesNames(view, kept)) {
          const into = `${dst}/node_modules/${name}`;
          if ((await view.stat(into, { follow: false })) !== null) continue;
          const scope = name.includes('/') ? `/${name.slice(0, name.indexOf('/'))}` : '';
          await view.mkdir(`${dst}/node_modules${scope}`, { recursive: true });
          await view.rename(`${kept}/${name}`, into);
        }
      }
    } finally {
      for (const leftover of [copy, old]) {
        try { if ((await view.stat(leftover, { follow: false })) !== null) await view.remove(leftover, { recursive: true }); }
        catch { /* swept by the next install */ }
        this.placing.delete(leftover);
      }
    }
  }

  /** An artifact this installer wrote as root in an earlier release, handed to its directory's owner (see handKernelArtifact). */
  private async handKernelArtifact(principal: { cred: VfsCred; view: ProcessView }, path: string): Promise<void> {
    await handKernelArtifact(this.filesystem, principal.view, principal.cred, path);
  }

  // ── Spec building ─────────────────────────────────────────────────────

  /**
   * The install's roots (core npm-tree.ts projectRoots): every declared
   * dependency, and the packages named on the command line (`npm install
   * react react-dom@18.2.0`), explicit requests saved where npm saves them
   * (namedPackages); a global prefix's roots are only what is named.
   * What cannot run here is named by the advisory pass below, and a
   * swap rewrites a root's range to its target (applyW6Registry); nothing a
   * project declares is quietly left out of node_modules.
   */
  private async buildRoots(
    projDir: string,
    fs: ProjectFs,
    opts: { packages?: string[]; production?: boolean; saveDev?: boolean; saveOptional?: boolean; global?: boolean; legacyPeerDeps?: boolean },
    log: (msg: string) => void,
  ): Promise<{ roots: TreeRoot[]; named: NamedPackage[]; devOnly: Set<string>; advised: Set<string>; manifest: ProjectManifest | null }> {
    // Which names only a devDependency asked for — diagnostics only, so an
    // advisory can say whether anything this project RUNS actually needs
    // the package. A devDependency is still a required root.
    const devOnly = new Set<string>();
    // Names the top-level pass already announced — the walk dedupes its
    // own advisories against it.
    const advised = new Set<string>();
    const pkgJsonPath = projDir + '/package.json';
    // A package.json the install cannot read fails it; a corrupt one declares nothing; a global prefix has none.
    const manifest = !opts.global && await fs.exists(pkgJsonPath) ? readPackageJson(await fs.readFileString(pkgJsonPath))?.manifest ?? null : null;
    const named = namedPackages(manifest, opts.packages ?? [], opts);
    const roots = projectRoots(manifest, named, { legacyPeerDeps: opts.legacyPeerDeps === true });
    const explicit = new Set(named.map(({ name }) => name));
    const rooted = new Set(roots.map(({ name }) => name));
    for (const name of Object.keys(manifest?.devDependencies ?? {})) {
      if (rooted.has(name) && !explicit.has(name) && !Object.hasOwn(manifest?.dependencies ?? {}, name) && !Object.hasOwn(manifest?.optionalDependencies ?? {}, name)) devOnly.add(name);
    }
    // A devDependency `--omit=dev` leaves out is planned, and not announced.
    const omitted = new Set(opts.production ? roots.filter(({ type }) => type === 'dev').map(({ name }) => name) : []);
    const swapped = this.applyW6Registry(Object.fromEntries(roots.map(({ name, range }) => [name, range])), log, { devOnly, advised, omitted });
    return { roots: roots.map((root) => ({ ...root, range: swapped[root.name] ?? root.range })), named, devOnly, advised, manifest };
  }

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
  private applyW6Registry(
    specs: Record<string, string>,
    log: (msg: string) => void,
    options: { devOnly?: ReadonlySet<string>; advised?: Set<string>; omitted?: ReadonlySet<string> } = {},
  ): Record<string, string> {
    const { specs: swapped, swaps } = applySwaps(specs);
    for (const s of swaps) {
      // `log` is unguarded everywhere else in this file; singling it out for
      // try/catch here would be inconsistent and could mask real bugs in the
      // progress hook.
      log(formatSwapNotice(s));
      // W6.5: telemetry — fire-and-forget; sink swallows its own errors.
      emitRegistryEvent({ type: 'swap', from: s.from, to: s.to, ctx: 'top' });
    }
    for (const r of findRejects(swapped, 'top')) {
      emitRegistryEvent({ type: 'advisory', from: r.from, reason: r.reason, suggest: r.suggest, ctx: 'top' });
      if (options.advised?.has(r.from) || options.omitted?.has(r.from)) continue;
      options.advised?.add(r.from);
      const hint = r.suggest ? ` … try: ${r.suggest}` : '';
      const marker = options.devOnly?.has(r.from) ? ' (declared in devDependencies)' : '';
      log(`[npm] note: ${r.from} has no Workers-compatible build${marker}: ${r.reason}${hint}`);
    }
    return swapped;
  }

  // ── Lockfile ──────────────────────────────────────────────────────────

  /**
   * A lockfile entry's record: its registry package's (the stable identity
   * an alias names), read once however often one install asks for it; null
   * where the cache holds none of that exact package. `entries`' records
   * are read together, up front.
   */
  private lockRecords(source: RecordSource, entries: Iterable<LockfileEntry> = []): (entry: LockfileEntry) => RegistryCacheEntry | null {
    const read = this.cache.getRegistryEntries(source, [...entries].map((entry): [string, string] => [entry.registryName || entry.name, entry.resolvedVer]));
    return (entry) => {
      const registryName = entry.registryName || entry.name;
      const key = `${registryName}@${entry.resolvedVer}`;
      let record = read.get(key);
      if (record === undefined) {
        record = this.cache.getRegistryEntry(source, registryName, entry.resolvedVer);
        read.set(key, record);
      }
      return record !== null && record.integrity === entry.integrity ? record : null;
    };
  }

  /**
   * Remove the placements of `previous` (the last install's lockfile, and
   * what an optional failure left out) that `plan` does not hold. Answers
   * how many were removed.
   */
  private async pruneExtraneous(
    previous: readonly string[],
    installing: readonly PackagePlacement[],
    nmDir: string,
    project: ProjectFs,
    log: (msg: string) => void,
  ): Promise<number> {
    const kept = new Set(installing.map(({ placement }) => placement));
    const removed = await this.removePlacements([...new Set(previous)].filter((placement) => !kept.has(placement)), installing, nmDir, project);
    if (removed.length > 0) log(`removed ${removed.length} extraneous ${removed.length === 1 ? 'package' : 'packages'}: ${removed.join(', ')}`);
    return removed.length;
  }

  /**
   * Remove `placements`, with the bins they linked, as the invoking
   * principal; a placement inside another removed one goes with it, and a
   * bin a root package of `installing` links stays. Answers the placements removed.
   */
  private async removePlacements(placements: string[], installing: readonly PackagePlacement[], nmDir: string, project: ProjectFs): Promise<string[]> {
    const extraneous = [...placements].sort();
    if (extraneous.length === 0) return [];
    const removed: string[] = [];
    // The bins a removed package links: what its own package.json names
    // (read before it goes) and what the bin manifest credits to it.
    const unlinked = new Set<string>();
    for (const placement of extraneous) {
      const key = `${nmDir}/${placement}`;
      const inRemoved = removed.some((parent) => placement.startsWith(parent + '/node_modules/'));
      if (!inRemoved && await project.exists(key)) {
        if (!placement.includes('/node_modules/')) for (const name of await declaredPackageBins(project, key)) unlinked.add(name);
        await project.removeRecursive(key);
      }
      removed.push(placement);
    }
    const manifestPath = npmBinManifestPath(nmDir);
    const manifest = await project.exists(manifestPath)
      ? parseNpmBinManifest(await project.readFileString(manifestPath))
      : null;
    for (const [name, bin] of Object.entries(manifest?.bins ?? {})) if (removed.includes(bin.packageName)) unlinked.add(name);
    // Unless a package that stays links the same name.
    for (const pkg of rootPackages(installing).values()) for (const entry of packageBinEntries(pkg, nmDir)) unlinked.delete(entry.name);
    for (const name of unlinked) {
      const shim = `${nmDir}/.bin/${name}`;
      if (await project.exists(shim)) await project.unlink(shim);
    }
    if (manifest !== null && [...unlinked].some((name) => name in manifest.bins)) {
      for (const name of unlinked) delete manifest.bins[name];
      await project.writeFile(manifestPath, enc.encode(JSON.stringify(manifest, null, 2) + '\n'), { mode: 0o644 });
    }
    return removed;
  }

  /**
   * npm ci: the tree package-lock.json (or npm-shrinkwrap.json) records,
   * each placement as it is locked, and whether the lock is suspect: its
   * root declares other dependencies than package.json (lockRootMatches).
   * The ABI policy the resolver applies still holds: what cannot run here
   * is left out where the plan finds it optional and refused where it is
   * required, and a swapped package resolves its swap target at the locked
   * version.
   */
  private async treeFromPackageLock(
    network: WorkspaceNetwork,
    projDir: string,
    fs: ProjectFs,
    log: (msg: string) => void,
    npmLog: NpmLogEmitter,
    registry: string,
    cache: NpmCacheMode,
    legacyPeerDeps: boolean,
  ): Promise<{ installed: Array<InstalledPackage<ResolvedPackage>>; lockName: string; suspect: boolean }> {
    let lockName: string | undefined;
    for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
      if (await fs.exists(`${projDir}/${name}`)) { lockName = name; break; }
    }
    if (!lockName) throw new Error('`npm ci` needs a package-lock.json or npm-shrinkwrap.json');
    const lock = parsePackageLock(await fs.readFileString(`${projDir}/${lockName}`), lockName);
    const pkgJsonPath = `${projDir}/package.json`;
    if (!await fs.exists(pkgJsonPath)) throw new Error('`npm ci` needs a package.json');
    const manifest = readPackageJson(await fs.readFileString(pkgJsonPath))?.manifest;
    if (!manifest) throw new Error('`npm ci` needs a package.json that is a JSON object');
    const lockRoot = packageJsonDocument(lock.packages[''] ?? {})?.manifest ?? {};
    const suspect = !lockRootMatches(lockRoot, projectRoots(manifest, [], { legacyPeerDeps }));
    const unsupported = Object.keys(lock.packages).find((key) => key !== '' && !key.startsWith('node_modules/'));
    if (unsupported !== undefined) {
      throw new Error(`${lockName} entry "${unsupported}" is a workspace or linked package, which \`npm ci\` here does not install`);
    }
    const installed = new Map<string, InstalledPackage<ResolvedPackage>>();
    // Swapped lock entries by placement: each resolves its swap target at its own locked version.
    const swapPlacements: { placement: string; folderName: string; spec: string }[] = [];
    // What a package (not the project) bundles comes in its archive: a name
    // its parent, or an ancestor between, bundles (inDepBundle).
    const inDepBundle = (placement: string): boolean => {
      for (let child = placement; child.includes('/node_modules/'); child = parentPlacement(child)) {
        const parent = packageJsonDocument(lock.packages[`node_modules/${parentPlacement(child)}`] ?? {})?.manifest ?? {};
        if (bundledNames(parent).includes(placementName(child))) return true;
      }
      return false;
    };
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === '') continue;
      const placement = key.slice('node_modules/'.length);
      if (inDepBundle(placement)) continue;
      const folderName = placementName(placement);
      const name = typeof entry.name === 'string' ? entry.name : folderName;
      const version = typeof entry.version === 'string' ? entry.version : '';
      const platform = {
        name,
        os: stringList(entry.os),
        cpu: stringList(entry.cpu),
        libc: stringList(entry.libc),
        main: '',
      };
      // Its edges as the lock records them, read as any manifest is (optional peers, bundles), and its flags.
      const manifest = packageJsonDocument(entry)?.manifest ?? {};
      // As load-virtual reads them: devOptional also where it is dev or optional.
      const lock = {
        dev: entry.dev === true, optional: entry.optional === true, peer: entry.peer === true, extraneous: entry.extraneous === true,
        devOptional: entry.devOptional === true || entry.dev === true || entry.optional === true,
      };
      const pkg: ResolvedPackage = {
        name: folderName,
        version,
        registryName: name,
        tarballUrl: typeof entry.resolved === 'string' ? entry.resolved : '',
        integrity: typeof entry.integrity === 'string' ? entry.integrity : '',
        dependencies: { ...manifest.dependencies },
        optionalDependencies: manifest.optionalDependencies,
        peerDependencies: manifest.peerDependencies,
        peerDependenciesMeta: manifest.peerDependenciesMeta,
        bundleDependencies: manifest.bundleDependencies,
        os: platform.os,
        cpu: platform.cpu,
        libc: platform.libc,
        ...(isEngines(manifest.engines) ? { engines: manifest.engines } : {}),
        main: '',
        bin: typeof entry.bin === 'string' ? { [folderName]: entry.bin } : stringRecord(entry.bin),
      };
      const platformReject = policyNativePlatformReject(PACKAGE_ABI_POLICY, platform);
      if (platformReject) {
        installed.set(placement, { at: placement, pkg, refused: platformReject.reason, lock });
        continue;
      }
      // Policy follows the registry identity (`name`), placement the folder the lock
      // names: an aliased entry (`node_modules/build`, name `esbuild`) resolves as
      // the alias `build@npm:esbuild@<locked>`, so the swap target lands in build.
      const swap = lookupSwap(name);
      if (swap && swapCoversVersion(swap, version)) {
        swapPlacements.push({ placement, folderName, spec: folderName === name ? version : `npm:${name}@${version}` });
        continue;
      }
      if (entry.link === true || typeof entry.resolved !== 'string' || !version) {
        installed.set(placement, { at: placement, failed: `${lockName} records no registry tarball for ${key}` });
        continue;
      }
      const reject = lookupReject(name);
      if (reject) log(`[npm] note: ${name} has no Workers-compatible build: ${reject.reason}${reject.suggest ? ` … try: ${reject.suggest}` : ''}`);
      const staged = lookupStagedArtifact(name);
      if (staged) applyStagedArtifact(pkg, staged);
      const binding = isOptionalNativeBinding(platform)
        ? `optional native binding (os=${platform.os ?? '*'}, cpu=${platform.cpu ?? '*'}, libc=${platform.libc ?? '*'})`
        : undefined;
      installed.set(placement, { at: placement, pkg, skipIfOptional: binding, lock });
    }

    // A swap resolves as its own tree, rebased under its placement: its
    // package there, anything it brings below it, unless the lock already
    // placed that path.
    for (const { placement, folderName, spec } of swapPlacements) {
      const swapped = await this.resolveTreeViaFanout(network, [{ name: folderName, range: spec, type: 'prod' }], [], log, npmLog, { registry, cache });
      const parent = placement.includes('/node_modules/') ? parentPlacement(placement) : null;
      const rebase = (path: string) => (parent === null ? path : `${parent}/node_modules/${path}`);
      const failed = new Map(swapped.plan.failures.map((failure) => [failure.id, failure]));
      for (const [path, node] of swapped.plan.nodes) {
        const at = rebase(path);
        const refused = failed.get(path)?.reason;
        if (!installed.has(at)) installed.set(at, refused === undefined ? { at, pkg: node.pkg } : { at, pkg: node.pkg, refused });
        failed.delete(path);
      }
      for (const failure of failed.values()) {
        const at = rebase(failure.id);
        if (!installed.has(at)) installed.set(at, { at, failed: failure.reason });
      }
    }
    return { installed: [...installed.values()], lockName, suspect };
  }

  /**
   * Write lockfile to SQLite.
   */
  private writeLockfile(
    projDir: string,
    placements: readonly PackagePlacement[],
    nmDir: string,
    /** What the table holds for the project now: only what changes is written. */
    previous: ReadonlyMap<string, LockfileEntry> | null,
    base: Map<string, LockfileEntry> | null = null,
  ): Map<string, LockfileEntry> {
    const entries = new Map<string, LockfileEntry>(base ?? []);
    for (const { placement, pkg } of placements) {
      entries.set(placement, {
        name: pkg.name,
        registryName: pkg.registryName ?? pkg.name,
        resolvedVer: pkg.version,
        integrity: pkg.integrity,
        hoistedPath: nmDir + '/' + placement,
      });
    }
    this.cache.writeLockfile(projDir, entries, this.ctx, previous);
    return entries;
  }

  /**
   * The installed tree `lockfile` records: each placement's package from its
   * registry package's record, under the name it installs as. A placement
   * whose record the cache does not hold is left out, and so planned anew;
   * a revision every record answered is kept (installedTrees).
   */
  private installedTree(projDir: string, lockfile: ReadonlyMap<string, LockfileEntry>, source: RecordSource): ReadonlyArray<InstalledPackage<ResolvedPackage>> {
    const revision = lockRevision(lockfile, source);
    const known = this.installedTrees.get(projDir);
    if (known?.revision === revision) return known.installed;
    const recordOf = this.lockRecords(source, lockfile.values());
    const installed = [...lockfile].flatMap(([at, entry]) => {
      const record = recordOf(entry);
      return record === null ? [] : [{ at, pkg: { ...resolvedFromRecord(record), name: entry.name, registryName: record.name } }];
    });
    if (installed.length === lockfile.size) this.installedTrees.set(projDir, { revision, installed });
    return installed;
  }

  // ── Bin linking ───────────────────────────────────────────────────────

  /**
   * Create node_modules/.bin/ entries for packages with "bin" fields: one
   * streamed batch through the engine as the invoking principal (`engine`,
   * at the project's engine key), or written one by one through the
   * principal's view (`fs`) for a mounted project. A shim the bin manifest
   * already records as it is, and that is there, is not written again; nor
   * is a manifest that does not change.
   */
  private async linkBins(
    resolved: Map<string, ResolvedPackage>,
    target: { nmDir: string } & ({ engine: CredentialedVfs } | { fs: ProjectFs }),
    /** Bins linked before, which the manifest keeps beside these. */
    kept: readonly NpmBinEntry[] = [],
  ): Promise<void> {
    const { nmDir } = target;
    const binDir = nmDir + '/.bin';
    const manifestEntries: NpmBinEntry[] = [];

    for (const [, pkg] of resolved) {
      for (const binEntry of packageBinEntries(pkg, nmDir)) {
        manifestEntries.push(binEntry);
      }
    }

    if (manifestEntries.length === 0) return;

    const read = 'fs' in target
      ? { exists: (path: string) => target.fs.exists(path), text: (path: string) => target.fs.readFileString(path) }
      : { exists: async (path: string) => target.engine.exists(path), text: async (path: string) => target.engine.readFileString(path) };
    const manifestPath = npmBinManifestPath(nmDir);
    const priorText = await read.exists(manifestPath) ? await read.text(manifestPath) : null;
    const prior = priorText === null ? null : parseNpmBinManifest(priorText);
    const linked = createNpmBinManifest(manifestEntries);
    const manifest = createNpmBinManifest([...kept, ...manifestEntries]);
    const files: Array<{ path: string; data: Uint8Array; mode: number }> = [];
    for (const binEntry of Object.values(linked.bins)) {
      const path = binDir + '/' + binEntry.name;
      const before = prior?.bins[binEntry.name];
      const unchanged = before !== undefined && before.packageName === binEntry.packageName && before.packageVersion === binEntry.packageVersion
        && before.packagePath === binEntry.packagePath && before.targetPath === binEntry.targetPath && await read.exists(path);
      if (!unchanged) files.push({ path, data: enc.encode(createNpmBinShim(binEntry, binDir)), mode: 0o755 });
    }
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    if (manifestText !== priorText) files.push({ path: manifestPath, data: enc.encode(manifestText), mode: 0o644 });
    if (files.length === 0) return;

    if ('fs' in target) {
      await target.fs.mkdir(binDir, { recursive: true });
      for (const file of files) await target.fs.writeFile(file.path, file.data, { mode: file.mode });
      return;
    }

    // The shims and the manifest in waves the writer cuts at W7's path and
    // byte bounds; the manifest goes last.
    const engine = target.engine;
    const writer = createWaveWriter({
      supervisor: { writeBatchStream: (stream) => this.filesystem.waves.writeStream(engine, stream) },
      root: binDir,
      mtimeMs: Date.now(),
    });
    for (const file of files) await writer.file(file.path, file.mode, file.data);
    await writer.flush();
  }

  // ── Package.json update ───────────────────────────────────────────────

  /**
   * package.json with what the command line named saved, as npm saves it
   * (core npm-tree.ts saveNamed): each under its save type, at `^version`
   * unless the range given is one that would widen. `resolved` is keyed by
   * the name the user typed — a swapped package resolves as an alias under
   * that name (applySwaps), so `esbuild` is saved as `esbuild`, never the
   * swap target. `version`: the version the tree holds under a name.
   */
  private async updatePackageJson(
    projDir: string,
    fs: ProjectFs,
    principal: { cred: VfsCred; view: ProcessView },
    named: readonly NamedPackage[],
    version: (name: string) => string | null,
    savePrefix?: string,
  ): Promise<void> {
    const pkgJsonPath = projDir + '/package.json';
    if (!await fs.exists(pkgJsonPath)) return;
    // A package.json the install cannot read or write fails it; a corrupt one is left as it is.
    const text = await fs.readFileString(pkgJsonPath);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    // A document that is not an object cannot take a field.
    const document = packageJsonDocument(parsed);
    if (document === null) throw new TypeError('package.json is not an object');
    const saved = saveNamed(document.json, named, version, savePrefix);
    // `npm init` and npm-fast before 0.13.2 wrote package.json as root.
    await this.handKernelArtifact(principal, `/${pkgJsonPath}`);
    await fs.writeFile(pkgJsonPath, JSON.stringify(saved, null, 2) + '\n');
  }

  // ── Pre-bundling ──────────────────────────────────────────────────────

  /**
   * Warm the browser bundles of what the project's browser source imports
   * from the packages this install put in node_modules (npm/browser-prebundle.ts,
   * the dev server's path for the same rows), in the background, one at a
   * time: each slice is walked in the supervisor just before its build, so at
   * most one is held. Best effort: the dev server bundles on demand whatever
   * is not warm.
   */
  private async prebundleUsedModules(
    projDir: string,
    installed: Map<string, ResolvedPackage>,
    fs: CredentialedVfs,
    progress: (msg: string) => void,
    pid: number,
    signal?: AbortSignal,
  ): Promise<void> {
    // Built in the session's build facet: a caller without esbuild (whose
    // parser scans the project) or without the pool does not warm.
    if (!this.esbuild || !this.bundlePool) return;
    const ctx: PrebundleContext = {
      vfs: fs, root: projDir, cache: this.cache, pool: this.bundlePool, parse: transformParser(this.esbuild), esbuild: this.esbuild, serviceFallback: false,
      signal, owner: { pid, session: this.ctx?.id.toString() },
    };
    const scan = await scanProject(ctx);
    if (scan.unread !== null) {
      progress(`  the scan of the project for its imports left ${scan.unread} unread: barrel packages are pre-bundled whole, not from the names it found`);
    }
    const pending: { specifier: string; barrel: BarrelInput | null }[] = [];
    for (const specifier of scan.bareSpecifiers) {
      const pkgName = packageNameFromSpecifier(specifier);
      if (isServerToolPackage(pkgName) || !installed.has(pkgName)) continue;
      const whole = barrelPackage(ctx, specifier);
      const barrel = whole && barrelInput(whole, scan);
      const stored = storedPrebundle(ctx, specifier, barrel);
      if (stored && await stored) continue;
      pending.push({ specifier, barrel });
    }
    if (pending.length === 0) return;
    // The supervisor's heap entering the phase, by the deterministic
    // estimator (process.memoryUsage() reads 0 in a Durable Object).
    const memBefore = this._estimateSupervisorHeapMiB();
    progress(`Pre-bundling ${pending.length} modules... (supervisor heap ${memBefore.toFixed(1)} MiB)`);
    // onProgress is the caller's, and may throw: the phase goes on.
    const safeProgress = (msg: string): void => {
      try { progress(msg); } catch (e: any) {
        try { console.error('[pre-bundle] onProgress threw:', e?.message || e); } catch {}
      }
    };
    const nmDir = projDir + '/node_modules';
    let okCount = 0;
    let attempted = 0;
    let errorCount = 0;
    let skippedCount = 0;
    // This batch's failures by module, for /api/_diag/memory.
    const errorsByModule: Record<string, string> = {};
    const failed = (specifier: string, message: string, line: string): void => {
      safeProgress(line);
      errorCount++;
      errorsByModule[specifier] = message;
    };
    // The pre-bundles not attempted because node_modules went away under
    // the phase: its session destroyed (its storage deleted) or the
    // directory removed. Each would only fail on a store that is gone.
    let abandoned = 0;
    const nodeModulesGone = (): boolean => {
      // Listed, not looked up: a lookup can be answered from the VFS's
      // cache of the store, a listing reads the store. Gone only when it
      // is confirmed so: node_modules not there (ENOENT), or the store
      // itself deleted. Any other failure (a node_modules that may be
      // searched but not listed, mode 0311) is not a disappearance: each
      // pre-bundle goes on, and fails with its own error if it must.
      try {
        fs.readdir(nmDir);
        return false;
      } catch (error) {
        return Reflect.get(Object(error), 'code') === 'ENOENT' || this.store.storeDeleted();
      }
    };
    const abandonRest = (left: number): void => {
      abandoned = left;
      safeProgress(`  pre-bundle stopped: ${nmDir} is gone (the session destroyed, or node_modules removed); ${abandoned} not pre-bundled`);
    };
    try {
      for (let i = 0; i < pending.length; i++) {
        const { specifier, barrel } = pending[i];
        if (nodeModulesGone()) {
          abandonRest(pending.length - i);
          break;
        }
        attempted++;
        let outcome: PrebundleOutcome<void>;
        try {
          outcome = await buildPrebundle(ctx, specifier, barrel, () => undefined);
        } catch (error) {
          if (nodeModulesGone()) {
            attempted--;
            abandonRest(pending.length - i);
            break;
          }
          const message = describeError(error);
          failed(specifier, message, `  pre-bundle failed for ${specifier}: ${message}`);
          continue;
        }
        if (outcome.kind === 'built') {
          for (const warning of outcome.warnings) safeProgress(`  [warn] ${specifier}: ${warning}`);
        }
        if (outcome.kind !== 'built' || outcome.changed || outcome.storeFailure !== null) {
          if (nodeModulesGone()) {
            attempted--;
            abandonRest(pending.length - i);
            break;
          }
        }
        switch (outcome.kind) {
          case 'built':
            // A package reinstalled while it was bundled: its bundle is not
            // stored under the manifests the slice read (the next install,
            // or the dev server on demand, bundles what is there now).
            if (outcome.changed) safeProgress(`  pre-bundle of ${specifier} not cached: its package changed while it was bundled`);
            else if (outcome.storeFailure !== null) failed(specifier, outcome.storeFailure, `  pre-bundle cache-write failed for ${specifier}: ${outcome.storeFailure}`);
            else okCount++;
            break;
          case 'refused':
          case 'unresolved':
            skippedCount++;
            safeProgress(`  skipped pre-bundle for ${specifier}: ${outcome.kind === 'refused' ? outcome.message : 'its entry does not resolve in node_modules'}`);
            break;
          case 'unavailable':
            // The pool is the session's: without it no pre-bundle can run.
            attempted--;
            safeProgress(`Pre-bundle skipped: ${outcome.message}`);
            return;
          case 'failed':
            failed(specifier, outcome.message, `  pre-bundle failed for ${specifier}: ${outcome.message}`);
            break;
        }
      }
    } finally {
      // The batch's outcomes, for /api/_diag/memory; a throw here must not unwind the phase.
      try {
        recordPreBundleSummary({ attempted, bundlesCompleted: okCount, errors: errorCount, skipped: skippedCount, errorsByModule });
      } catch (e: any) {
        try { console.error('[pre-bundle] recordPreBundleSummary threw:', e?.message || e); } catch {}
      }
      try {
        const memAfter = this._estimateSupervisorHeapMiB();
        const delta = memAfter - memBefore;
        safeProgress(
          `Pre-bundle complete: ${okCount}/${attempted} succeeded${abandoned > 0 ? `, ${abandoned} stopped` : ''}. (supervisor heap ${memAfter.toFixed(1)} MiB, Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} MiB)`,
        );
      } catch (e: any) {
        try { console.error('[pre-bundle] final-progress threw:', e?.message || e); } catch {}
      }
    }
  }

  /** Monotonic count of transactionSync calls this DO's VFS has executed. */
  private storageCommitCount(): number {
    return this.store.getStats().sql?.transactions?.durationMs?.count ?? 0;
  }

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
  private _estimateSupervisorHeapMiB(): number {
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
    } catch {
      return 0;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

// P5 (production reliability): readSupervisorHeap() removed. It called
// process.memoryUsage() which returns 0 for every field inside a
// Durable Object class context (only dynamic-worker isolates under
// nodejs_compat get the real implementation — see
// @nimbus-sh/platform/diag-counters.js:4). The deterministic
// supervisor-heap estimator is the C'.1 replacement; see
// NpmInstaller._estimateSupervisorHeapMiB.

/** What staging directories in /tmp and copies beside a mounted package are named. */
const STAGE_PREFIX = '.npm-stage-';
/**
 * The group a stage's sweep acts with: none. NaN equals no number, so it is
 * no inode's group, however that inode got its gid, and grants nothing (no
 * gid is reserved for that: nogroup is a group like any other). The sweep
 * only removes, so nothing is made with it.
 */
const NO_GROUP = Number.NaN;
const COPY_PREFIX = '.nimbus-copy-';

/**
 * `src`'s tree on the engine written into `dst` through `to`; with
 * `packageJsonLast`, its own package.json goes last. Each read of the engine
 * waits for a delegation it meets (withRecall); the writes go through the
 * view, which waits itself.
 */
async function copyTreeInto(from: CredentialedVfs, src: string, to: ProcessView, dst: string, packageJsonLast: boolean): Promise<void> {
  await to.mkdir(dst, { recursive: true });
  const entries = await withRecall(() => from.readdir(src));
  if (packageJsonLast) entries.sort((a, b) => Number(a.name === 'package.json') - Number(b.name === 'package.json'));
  for (const entry of entries) {
    const source = `${src}/${entry.name}`;
    const target = `${dst}/${entry.name}`;
    if (entry.type === 'directory') {
      await copyTreeInto(from, source, to, target, false);
    } else if (entry.type === 'symlink') {
      if ((await to.stat(target, { follow: false })) !== null) await to.unlink(target);
      await to.symlink(await withRecall(() => from.readlink(source)), target);
    } else {
      const [bytes, mode] = await withRecall(() => [from.readFile(source), from.stat(source).mode & 0o7777] as const);
      await to.writeFile(target, bytes, { mode });
    }
  }
}

/** Whether the mount holding `dir` renames in place: a backend with no rename answers EXDEV. */
async function canRename(view: ProcessView, dir: string): Promise<boolean> {
  const probe = `${dir}/${COPY_PREFIX}probe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await view.mkdir(probe);
  try {
    await view.rename(probe, `${probe}-moved`);
  } catch (error) {
    await view.rmdir(probe);
    if (isVfsError(error, 'EXDEV')) return false;
    throw error;
  }
  await view.rmdir(`${probe}-moved`);
  return true;
}

/** The packages in a node_modules directory, a scope's by `@scope/name`. */
async function nodeModulesNames(view: ProcessView, dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await view.readdir(dir)) {
    if (entry.name.startsWith(COPY_PREFIX)) continue;
    if (!entry.name.startsWith('@') || (await direntTypeIn(view, dir, entry)) !== 'directory') {
      names.push(entry.name);
      continue;
    }
    for (const scoped of await view.readdir(`${dir}/${entry.name}`)) names.push(`${entry.name}/${scoped.name}`);
  }
  return names;
}

/**
 * A warm install finishes in a few hundred ms, where a seconds-with-one-decimal
 * format rounds every phase to `0.0s` and the breakdown stops decomposing the
 * total it sits next to.
 */
function fmtPhaseMs(ms: number): string {
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
