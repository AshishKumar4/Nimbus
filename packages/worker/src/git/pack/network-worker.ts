/**
 * git/pack/network-worker.ts — the git network facet's worker: one
 * invocation per request, its options in the body (network-facet.ts
 * execGitNetwork and invokeClonePhase build them). A clone's phases run the
 * pack layer (clone.ts, history.ts); fetch and push run cf-git, its fs the
 * buffered writer (buffered-fs.ts) through the one git fs adapter
 * (../git-fs.ts), its packs this layer (facet-packs.ts).
 */
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { createWaveWriter } from '@nimbus-sh/platform/wave-writer.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { createGitFs } from '../git-fs.js';
import type { GitNetworkOp, GraphFiltersStep } from '../network-facet.js';
import { GIT_CLONE_JOB_MARKER } from '../clone-job.js';
import { createBufferedFs, overlayEntryOf, type OverlayEntry } from './buffered-fs.js';
import {
  cloneBatch, cloneDiscover, cloneFast, cloneFinish, clonePlanFromStore, fetchObjects, type CloneContext, type CloneReceipt, type CloneTag,
  type PendingPack,
} from './clone.js';
import {
  counted, createSupervisorRpcCounters, emptyMetadataOverlayStats, facetFileApi, facetPacksSupervisor, supervisorNames,
  type FacetStats, type GitFacetSupervisor, type MetadataOverlayStats,
} from './facet-supervisor.js';
import { facetPacks } from './facet-packs.js';
import { graphFiltersAssemble, graphFiltersDiscard, graphFiltersPiece, graphFiltersPlan, type GraphContext } from './graph-filters.js';
import { historyPlan, historyResume, historyStep, type HistoryKind, type StagedFile } from './history.js';
import { GitWriteFailure, mountWriter } from './mount-writer.js';
import { discover, requestPack } from './upload-pack.js';
import { retryingGitHttp, type GitHttp } from './transport.js';

/** cf-git, as the facet's module record carries it (scripts/bundle-git.mjs). */
interface GitBundle {
  git: {
    fetch(options: Record<string, unknown>): Promise<unknown>;
    push(options: Record<string, unknown>): Promise<unknown>;
  };
  gitHttp: GitHttp;
}

type ClonePhase = 'clone-prepare' | 'clone-batch' | 'clone-history' | 'clone-finish';

/** A history step a clone-history invocation runs (network-facet.ts runCloneHistory). */
type HistoryRequest =
  | { step: 'checkout-plan'; commit: unknown }
  | { step: 'plan'; lists: StagedFile[]; present: StagedFile[] }
  | { step: 'resume'; kind: HistoryKind; piece: string; part: number; pending: PendingPack; tagInterest?: readonly string[] }
  | { step?: undefined; kind: HistoryKind; piece: string; head?: string; depth?: number; source?: StagedFile & { offset?: number; length?: number }; tagInterest?: readonly string[] };

/** The body an invocation is sent. */
interface FacetRequest {
  op: GitNetworkOp;
  phase?: string;
  invocationId?: unknown;
  dir: unknown;
  url?: string;
  quiet?: boolean;
  remote?: string;
  ref?: string;
  depth?: number;
  relative?: boolean;
  filter?: string;
  sparse?: boolean;
  auth?: { username: string; password: string };
  jobId?: unknown;
  optionsHash?: unknown;
  attempt?: number;
  exclusiveDestination?: boolean;
  exclusiveMutationRoot?: string;
  onMount?: boolean;
  phaseDeadline?: unknown;
  batch?: { index?: unknown; bytes?: unknown };
  capabilities: readonly string[];
  partial?: boolean;
  local?: boolean;
  history?: HistoryRequest;
  historyBudgetUnits?: number;
  historyBlobsPerBatch?: number;
  blobsPerBatch?: number;
  shares: { name: string; bytes: number }[];
  full?: boolean;
  cacheTreeBytes?: number;
  tags?: readonly CloneTag[];
  graph?: { name: string; bytes: number }[] | null;
  checkoutFailed?: boolean;
  graphFilters?: GraphFiltersStep;
  oids: readonly string[];
}

const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function protocolError(message: string): Error {
  return new Error('git clone protocol: ' + message);
}

function requireProtocolString(value: unknown, label: string, maxLength = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw protocolError(label + ' is invalid');
  return value;
}

function requireOid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) throw protocolError(label + ' is invalid');
  return value;
}

function requireMetadataNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw protocolError(label + ' is invalid');
  return value;
}

function requirePositiveMetadataNumber(value: unknown, label: string): number {
  const number = requireMetadataNumber(value, label);
  if (number === 0) throw protocolError(label + ' is invalid');
  return number;
}

function cloneJobMarkerPath(dir: string): string {
  return normalizeVfsPath(dir) + '/.git/' + GIT_CLONE_JOB_MARKER;
}

/** The marker a clone's phases write first: it names the job that owns .git (git/clone-job.ts reads it). */
function cloneJobMarker(opts: FacetRequest): string {
  return JSON.stringify({ version: 1, jobId: opts.jobId, optionsHash: opts.optionsHash });
}

/**
 * A piece's earlier attempts may have left a partial temporary pack (each
 * attempt names its own): it goes before the piece runs again. What the
 * failed attempt published otherwise (files, a named pack) is the same
 * content addressed by the same names, which this attempt rewrites.
 */
async function discardEarlierAttempts(context: CloneContext, opts: FacetRequest, prefix: string, suffix: string): Promise<void> {
  if (!((opts.attempt ?? 0) > 1)) return;
  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  for (let attempt = 1; attempt < opts.attempt!; attempt++) {
    const name = opts.jobId + (attempt > 1 ? '_' + attempt : '') + suffix;
    await writer.remove('.git/objects/pack/' + prefix + name);
    // Its idx and rev, if it reached install.ts.
    await writer.remove('.git/objects/pack/tmp_idx_' + name);
    await writer.remove('.git/objects/pack/tmp_rev_' + name);
  }
  await writer.flush();
}

/**
 * What the pack layer needs of this facet: the supervisor's ranged writes
 * (under the clone's lease, which the binding presents), and wave writers
 * rooted at the clone that report each published wave's receipts.
 */
function gitPackContext(
  supervisor: GitFacetSupervisor, stats: FacetStats, opts: FacetRequest, root: string | null, deadline: number | null,
  log: (message: string) => void, worktreeRoot: string | null = null,
): GraphContext {
  const dir = normalizeVfsPath(String(opts.dir));
  // A pack's ranged writes, as its waves (the wave writer's deadline), stop at the phase deadline.
  const mutation = <T>(name: 'fsWriteRange' | 'rename' | 'lock', call: () => Promise<T>): Promise<T> => {
    if (deadline !== null && Date.now() >= deadline) return Promise.reject(new Error('git ' + (opts.phase || opts.op) + ' passed its phase deadline'));
    return counted(stats, name, call);
  };
  return {
    supervisor: {
      fsWriteRange: (path, offset, bytes) => mutation('fsWriteRange', () => supervisor.fsWriteRange(path, offset, bytes)),
      fsTruncate: (path, size) => mutation('fsWriteRange', () => supervisor.fsTruncate(path, size)),
      fsReadRange: (path, offset, length) => counted(stats, 'fsReadRange', () => supervisor.fsReadRangeUncached(path, offset, length)),
      rename: (from, to) => mutation('rename', () => supervisor.rename(from, to)),
      // A commit-graph chain's lock (graph-filters.ts): created exclusively, written, made read-only, removed.
      fsOpen: (path, flags) => mutation('lock', () => supervisor.fsOpen(path, flags)),
      fsWrite: (handle, offset, bytes) => mutation('lock', () => supervisor.fsWrite(handle, offset, bytes)),
      fsClose: (handle) => counted(stats, 'lock', () => supervisor.fsClose(handle)),
      chmod: (path, mode) => mutation('lock', () => supervisor.chmod(path, mode)),
      unlink: (path) => mutation('lock', () => supervisor.unlink(path)),
      readdir: (path) => supervisorNames(supervisor, stats, path),
    },
    writer(onReceipts?: (receipts: CloneReceipt[]) => void) {
      const waves = createWaveWriter({
        supervisor: {
          // The writer's fence for this attempt goes with it: the session refuses a late original.
          writeBatchStream(stream, fence) {
            stats.supervisorRpc.writeBatchStream++;
            return supervisor.writeBatchStream(stream, fence);
          },
          // The session issues the epoch the writer's waves are admitted under.
          openWaveWriter() {
            return typeof supervisor.openWaveWriter === 'function' ? supervisor.openWaveWriter() : Promise.resolve(null);
          },
        },
        root,
        worktreeRoot,
        base: dir,
        deadline,
        onWave(report) {
          stats.filesWritten += report.files;
          stats.bytesWritten += report.bytes;
          if (onReceipts) onReceipts(report.receipts);
        },
      });
      if (opts.onMount !== true) return waves;
      // On a mount a file past a wave's limit is written through the session's file API (pack/mount-writer.ts).
      return mountWriter(waves, facetFileApi(supervisor, stats, deadline), dir, (receipts) => {
        stats.filesWritten += receipts.length;
        for (const receipt of receipts) stats.bytesWritten += receipt.size;
        if (onReceipts) onReceipts(receipts);
      });
    },
    dir,
    url: opts.url ?? '',
    auth: opts.auth,
    marker: { path: '.git/' + GIT_CLONE_JOB_MARKER, text: cloneJobMarker(opts) },
    onProgress: (line) => log('remote: ' + line + '\n'),
  };
}

/** A clone's ownership checks before prepare writes anything; its authoritative root and that root's metadata. */
async function prepareDestination(
  supervisor: GitFacetSupervisor, stats: FacetStats, opts: FacetRequest,
): Promise<{ root: string | null; rootMetadata: OverlayEntry | null }> {
  if (opts.op !== 'clone') throw protocolError('prepare requires clone operation');
  requireProtocolString(opts.jobId, 'job id', 128);
  requireProtocolString(opts.optionsHash, 'options hash', 128);
  if (!opts.url) throw new Error('clone: url required');
  const notEmpty = () => new Error("fatal: destination path '" + opts.dir + "' already exists and is not an empty directory.");
  const cloneRoot = normalizeVfsPath(String(opts.dir));
  if (!cloneRoot) throw new Error('fatal: destination path ' + JSON.stringify(opts.dir) + ' already exists and is not an empty directory.');
  let existing = null;
  let firstMissing: string | null = null;
  const cloneRootParts = cloneRoot.split('/');
  for (let index = 0; index < cloneRootParts.length; index++) {
    const candidate = cloneRootParts.slice(0, index + 1).join('/');
    const isFinal = index === cloneRootParts.length - 1;
    const candidateStat = await counted(stats, 'lstat', () => supervisor.lstat(candidate));
    const isDirectory = candidateStat && (candidateStat.type === 'directory' || candidateStat.type === 'dir');
    if ((!isFinal && candidateStat && !isDirectory) || (isFinal && candidateStat && candidateStat.type === 'symlink')) throw notEmpty();
    if (!candidateStat && firstMissing === null) firstMissing = candidate;
    if (isFinal) existing = candidateStat;
  }
  const exclusiveRoot = normalizeVfsPath(opts.exclusiveMutationRoot || cloneRoot);
  if (opts.exclusiveDestination === true &&
      (exclusiveRoot !== (firstMissing || cloneRoot) ||
       (cloneRoot !== exclusiveRoot && !cloneRoot.startsWith(exclusiveRoot + '/')))) {
    throw new Error('git clone exclusive mutation root does not cover its destination');
  }
  const hasLegacySymlink = await counted(stats, 'legacySymlinkSubtree', () => supervisor.hasLegacySymlinkUnder(exclusiveRoot));
  if (hasLegacySymlink === true) throw notEmpty();
  let rootMetadata: OverlayEntry | null = null;
  if (existing) {
    if (!(existing.type === 'directory' || existing.type === 'dir')) throw notEmpty();
    const entries = await counted(stats, 'readdir', () => supervisor.readdir(cloneRoot));
    if (!Array.isArray(entries) || entries.length !== 0) throw notEmpty();
    if (opts.exclusiveDestination === true) rootMetadata = overlayEntryOf(existing);
  }
  return { root: opts.exclusiveDestination === true ? exclusiveRoot : null, rootMetadata };
}

/** The worker the git network facet exports. */
export const networkWorker = {
  async fetch(request: Request, workerEnv: { SUPERVISOR?: GitFacetSupervisor }): Promise<Response> {
    const supervisor = workerEnv && workerEnv.SUPERVISOR;
    if (!supervisor) {
      return Response.json({
        success: false, error: 'SUPERVISOR binding missing in facet env',
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 500 });
    }

    let opts: FacetRequest;
    try {
      opts = await request.json();
    } catch (e) {
      return Response.json({
        success: false, error: 'Invalid request body: ' + (e as Error | undefined)?.message,
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 400 });
    }

    const phase: ClonePhase | 'operation' = opts.phase === 'clone-prepare' || opts.phase === 'clone-batch' ||
        opts.phase === 'clone-history' || opts.phase === 'clone-finish'
      ? opts.phase
      : 'operation';
    const invocationId = typeof opts.invocationId === 'string' ? opts.invocationId : 'unavailable';
    const startedAt = Date.now();
    const startedMonotonic = performance.now();
    const stats: FacetStats = { filesWritten: 0, bytesWritten: 0, supervisorRpc: createSupervisorRpcCounters() };
    let mutated = false;
    let lastProgress: { phase: string; loaded: number; total?: number } | null = null;
    let flushWave = async (): Promise<void> => {};
    let overlayStats: () => MetadataOverlayStats = emptyMetadataOverlayStats;
    let waveStats: () => unknown = () => undefined;
    const respond = (success: boolean, payload: Record<string, unknown> = {}, status = 200): Response => {
      const error = !success && typeof payload.error === 'string' ? payload.error : undefined;
      return Response.json({
        success,
        ...payload,
        mutated,
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
        supervisorRpc: stats.supervisorRpc,
        diagnostic: {
          phase,
          invocationId,
          startedAt,
          endedAt: Date.now(),
          elapsed: Math.max(0, Math.round(performance.now() - startedMonotonic)),
          outcome: success ? 'success' : 'error',
          mutated,
          error,
          lastProgress,
          w7Waves: stats.supervisorRpc.writeBatchStream,
          supervisorRpc: stats.supervisorRpc,
          waves: waveStats(),
        },
      }, { status });
    };
    if (phase !== 'operation') {
      const expectedPath = '/git/' + phase + '/' + encodeURIComponent(invocationId);
      if (new URL(request.url).pathname !== expectedPath) {
        return respond(false, {
          error: 'git clone protocol: request trace marker does not match its phase identity',
          metadataOverlay: emptyMetadataOverlayStats(),
        }, 400);
      }
    }
    const log = (msg: string) => {
      if (opts.quiet) return;
      stats.supervisorRpc.stdout++;
      try { useRpcResource(supervisor.stdout(new TextEncoder().encode(msg)), () => undefined).catch(() => {}); } catch { /* the line is best-effort */ }
    };

    // cf-git and its HTTP client: a module of the facet's own record
    // (scripts/bundle-git.mjs), there only when the facet is loaded.
    let bundle: GitBundle;
    try {
      bundle = await import('./git-bundle.js');
    } catch (e) {
      return respond(false, {
        error: 'Failed to load bundled isomorphic-git: ' + (e as Error | undefined)?.message,
        metadataOverlay: emptyMetadataOverlayStats(),
      }, 500);
    }
    const git = bundle.git;
    const http = retryingGitHttp(bundle.gitHttp);

    // Keep progress bounded: phase transitions and completions, plus one
    // timed update every two seconds. cf-git fires this callback per pack
    // object, and each line is a facet-to-supervisor RPC that takes input-gate
    // time on the session (shell keystrokes included).
    let lastLogAt = 0;
    let lastLoggedPhase = '';
    const onProgress = async (e: { phase?: string; loaded?: number; total?: number } | undefined) => {
      if (!e || !e.phase) return;
      const now = Date.now();
      lastProgress = {
        phase: e.phase,
        loaded: Number(e.loaded) || 0,
        total: Number.isFinite(Number(e.total)) ? Number(e.total) : undefined,
      };
      const phaseChanged = e.phase !== lastLoggedPhase;
      const phaseDone = e.total && e.loaded === e.total;
      const dueByTime = now - lastLogAt >= 2000;
      if (!phaseChanged && !phaseDone && !dueByTime) return;
      lastLogAt = now;
      lastLoggedPhase = e.phase;
      log('\r[git] ' + e.phase + ' ' + (e.loaded || 0) + '/' + (e.total || '?'));
    };
    const onAuth = () => opts.auth || { username: '', password: '' };

    try {
      if (typeof opts.dir !== 'string') throw new Error('git ' + opts.op + ': dir required');
      const phaseDeadline = phase === 'operation' ? null : requireMetadataNumber(opts.phaseDeadline, 'phase deadline');
      if (phase === 'clone-batch' || phase === 'clone-history' || phase === 'clone-finish') {
        if (opts.op !== 'clone') throw protocolError(phase + ' requires clone operation');
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
        if (opts.exclusiveDestination !== true) throw protocolError(phase + ' requires an exclusive destination');
        const root = normalizeVfsPath(opts.exclusiveMutationRoot || opts.dir);
        const context = gitPackContext(supervisor, stats, opts, root, phaseDeadline, log);
        const jobId = opts.jobId + ((opts.attempt ?? 0) > 1 ? '_' + opts.attempt : '');
        mutated = true;
        if (phase === 'clone-batch') {
          await discardEarlierAttempts(context, opts, 'tmp_pack_', '_' + (opts.batch && opts.batch.index));
          const batch = await cloneBatch(context, {
            jobId,
            index: requireMetadataNumber(opts.batch && opts.batch.index, 'batch index'),
            batchBytes: requirePositiveMetadataNumber(opts.batch && opts.batch.bytes, 'batch bytes'),
            capabilities: opts.capabilities,
            partial: opts.partial === true,
            local: opts.local === true,
          });
          return respond(true, { batch, metadataOverlay: emptyMetadataOverlayStats() });
        }
        if (phase === 'clone-history') {
          const history = opts.history ?? ({} as HistoryRequest);
          let step;
          if (history.step === 'checkout-plan') {
            step = await clonePlanFromStore(context, {
              commit: requireOid(history.commit, 'streamed commit'),
              blobsPerBatch: opts.blobsPerBatch,
              sparse: opts.sparse === true,
            });
          } else if (history.step === 'plan') {
            step = await historyPlan(context, { lists: history.lists, present: history.present, blobsPerBatch: opts.historyBlobsPerBatch });
          } else if (history.step === 'resume') {
            step = await historyResume(context, { ...history, budgetUnits: opts.historyBudgetUnits });
          } else {
            await discardEarlierAttempts(context, opts, 'tmp_pack_', '_' + history.piece);
            step = await historyStep(context, {
              jobId,
              kind: history.kind,
              piece: history.piece,
              head: history.head,
              depth: history.depth,
              source: history.source,
              capabilities: opts.capabilities,
              budgetUnits: opts.historyBudgetUnits,
              tagInterest: history.tagInterest,
            });
          }
          return respond(true, { history: step, metadataOverlay: emptyMetadataOverlayStats() });
        }
        const finished = await cloneFinish(context, {
          shares: opts.shares,
          full: opts.full === true,
          cacheTreeBytes: opts.cacheTreeBytes,
          tags: opts.tags,
          graph: opts.graph,
          checkoutFailed: opts.checkoutFailed === true,
        });
        // The marker goes last: until it does, a failure leaves the clone abortable.
        // A checkout that failed keeps it: the clone's cleanup (git's junk mode) is still to come.
        if (opts.checkoutFailed !== true) {
          const writer = context.writer();
          await writer.remove('.git/' + GIT_CLONE_JOB_MARKER);
          await writer.flush();
        }
        return respond(true, { finished, metadataOverlay: emptyMetadataOverlayStats() });
      }
      let authoritativeRoot: string | null = null;
      let authoritativeRootMetadata: OverlayEntry | null = null;
      if (phase === 'clone-prepare') {
        ({ root: authoritativeRoot, rootMetadata: authoritativeRootMetadata } = await prepareDestination(supervisor, stats, opts));
      } else if (opts.op === 'clone') {
        throw protocolError('clone requires its phases (prepare, batch, history, finish)');
      }

      const buffered = createBufferedFs(
        supervisor,
        stats,
        authoritativeRoot,
        authoritativeRootMetadata,
        phaseDeadline,
        // fetch, pull and push work in a repository that already exists.
        phase === 'operation' ? normalizeVfsPath(opts.dir) : null,
        opts.onMount === true,
      );
      // cf-git reads packed objects by range and stores a fetched pack as it arrives (git/pack/facet-packs.ts).
      const fs = createGitFs(buffered.backend, facetPacks(facetPacksSupervisor(supervisor, stats, async (dir) => {
        // A clone's objects/pack may exist only in this fs's pending writes: publish it first.
        await buffered.backend.mkdir(normalizeVfsPath(dir));
        await buffered.flushWave();
      })));
      flushWave = buffered.flushWave;
      overlayStats = buffered.overlayStats;
      waveStats = buffered.waveStats;

      if (phase === 'clone-prepare') {
        if (opts.filter !== undefined && opts.depth === undefined) {
          throw new Error('fatal: --filter with --no-shallow is not supported yet: clone with --depth <n>');
        }
        if (opts.exclusiveDestination !== true) throw protocolError('clone requires an exclusive destination');
        const context = gitPackContext(supervisor, stats, opts, authoritativeRoot, phaseDeadline, log);
        // Nothing is written until the server is known to serve the clone.
        const advertisement = await cloneDiscover(context, { filter: opts.filter });
        if (authoritativeRoot !== null && authoritativeRoot !== normalizeVfsPath(opts.dir)) {
          mutated = true;
          await fs.promises.mkdir(opts.dir);
          await flushWave();
        }
        mutated = true;
        buffered.pinFile(cloneJobMarkerPath(opts.dir), cloneJobMarker(opts));
        await fs.promises.mkdir(normalizeVfsPath(opts.dir) + '/.git');
        await fs.promises.writeFile(cloneJobMarkerPath(opts.dir), cloneJobMarker(opts));
        // No Git metadata wave starts until ownership is durable. If this first
        // W7 stream loses its response, a cold abort can still prove ownership
        // from the marker; a missing or mismatched marker is never authority.
        await flushWave();
        // A full clone through the fast path starts as a depth-1 one: its
        // worktree first, its history after (clone-history). A server
        // without filter or wants by id sends its one pack (cloneStream).
        const started = await cloneFast(context, {
          ref: opts.ref || undefined,
          depth: opts.depth === undefined ? 1 : opts.depth,
          history: opts.depth === undefined,
          jobId: String(opts.jobId),
          filter: opts.filter,
          blobsPerBatch: opts.blobsPerBatch,
          budgetUnits: opts.historyBudgetUnits,
          sparse: opts.sparse === true,
        }, advertisement);
        const prepared = 'stream' in started ? { stream: started.stream } : { fast: started };
        return respond(true, { prepared, metadataOverlay: overlayStats() });
      } else if (opts.op === 'graph-filters') {
        // A full clone's changed-path filters (git/pack/graph-filters.ts):
        // reads the repository's packs, writes its commit-graph only.
        const root = normalizeVfsPath(opts.dir);
        const context = gitPackContext(supervisor, stats, opts, null, null, log, root);
        const step = opts.graphFilters ?? { step: 'plan' };
        const graphFilters = step.step === 'plan'
          ? await graphFiltersPlan(context)
          : step.step === 'piece'
            ? await graphFiltersPiece(context, step)
            : step.step === 'discard'
              ? await graphFiltersDiscard(context, step)
              : await graphFiltersAssemble(context, step);
        return respond(true, { graphFilters, metadataOverlay: overlayStats() });
      } else if (opts.op === 'fetch-objects') {
        // A partial clone's missing objects (git/promisor.ts): one request,
        // stored as a promisor pack. Writes land below the repository only.
        const root = normalizeVfsPath(opts.dir);
        const context = gitPackContext(supervisor, stats, opts, null, null, log, root);
        const fetched = await fetchObjects(context, { oids: opts.oids, jobId: invocationId });
        return respond(true, { fetched, metadataOverlay: overlayStats() });
      } else if (opts.op === 'fetch') {
        // ref is the branch a pull merges; without it, the current branch's, as git fetch picks.
        await git.fetch({
          fs, http,
          uploadPack: { discover, requestPack },
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref || undefined,
          depth: opts.depth,
          relative: opts.relative === true,
          singleBranch: true,
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'push') {
        await git.push({ fs, http, dir: opts.dir, remote: opts.remote || 'origin', ref: opts.ref, onProgress, onAuth });
      } else {
        throw new Error('Unknown op: ' + opts.op);
      }

      await flushWave();
      return respond(true, { metadataOverlay: overlayStats() });
    } catch (e) {
      // Best-effort flush of partial state so user can inspect what landed
      try { await flushWave(); } catch { /* the failure below is the one to report */ }
      const error = e as (Error & { code?: unknown }) | undefined;
      return respond(false, {
        error: (error && error.message) || String(e),
        errorCode: error && typeof error.code === 'string' ? error.code : undefined,
        // A write git would have failed: git's own lines (pack/mount-writer.ts).
        gitFailure: e instanceof GitWriteFailure ? e.lines : undefined,
        metadataOverlay: overlayStats(),
      });
    }
  },
};
