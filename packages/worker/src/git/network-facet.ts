/**
 * git/network-facet.ts — Facet-based git clone/fetch/pull.
 *
 * Runs isomorphic-git's network operations (clone/fetch/pull) inside a
 * dynamic worker (LOADER.load) to escape the supervisor DO's CPU budget
 * and to avoid the known DO fetch() hang in wrangler local dev.
 *
 * Architecture:
 *   - Facet holds a buffered fs adapter: writes accumulate in memory
 *   - Pre-flush ordinary waves with headroom below W7's 128-path limit or
 *     before 4 MiB via ONE supervisor.writeBatchStream() RPC. Each published
 *     path is atomic; a later publish-group failure may leave a committed prefix.
 *   - Clone prepare durably flushes Git metadata, then a second entrypoint
 *     invocation validates HEAD and flushes the worktree/index.
 *   - Fresh clones carry a metadata-only closed-world overlay across the
 *     invocation boundary; regular-file bytes still fall through after flush.
 *
 * Why this fixes the hang:
 *   - CPU-heavy packfile delta resolution runs in facet (own CPU budget)
 *   - No per-file RPC round-trips — bounded path waves
 *   - Packfile network fetch works (facet fetch is reliable, DO fetch hangs)
 *   - cf-git's nonBlocking=true option yields to event loop between batches
 *
 * See docs/analysis in git-network-facet plan — the canonical write-up lives
 * in the PR that introduced this file.
 */

import { loaderOutbound, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { getCtxExports } from '@nimbus-sh/fabric/composition.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { applyFacetLimits, facetLimits, type FacetResourceLimits } from '@nimbus-sh/fabric/facet-limits.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
import { fetchGitBundleSource } from '../runtime/git-bundle-artifact.js';
import type { WaveStats } from '@nimbus-sh/platform/wave-writer.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { GIT_PACK_NODE_IMPORTS, GIT_PACK_SRC } from './pack/facet.generated.js';
import { createSupervisorRpcCounters, type MetadataOverlayStats, type SupervisorRpcCounters } from './pack/facet-supervisor.js';
import { tagsHeld, type CloneBatchResult, type ClonePrepared, type CloneStreamed, type CloneTag } from './pack/clone.js';
import { COMMITS_PER_CHUNK, treeSlices, type HistoryKind, type HistoryStepResult, type StagedFile } from './pack/history.js';
import { RETRY_ATTEMPTS, isLostTransport, retryDelay } from './pack/transport.js';
import { CHECKOUT_FAILED } from './pack/mount-writer.js';

export type GitNetworkOp = 'clone' | 'fetch' | 'push' | 'fetch-objects' | 'graph-filters';


/** One step of a clone's changed-path filters pass (git/pack/graph-filters.ts). */
export type GraphFiltersStep =
  | { step: 'plan' }
  | { step: 'piece'; layer: string; pass: string; from: number; to: number; budgetMs: number }
  | { step: 'assemble'; layer: string; pass: string; files: { name: string; bytes: number }[] }
  | { step: 'discard'; layer: string; pass: string };

export interface GitNetworkOpts {
  op: GitNetworkOp;
  /** For graph-filters: commits a piece is asked for, and its wall-time budget (tuning). */
  graphFilterPieceCommits?: number;
  graphFilterPieceBudgetMs?: number;
  /** Invoking process identity used to bind every supervisor filesystem RPC. */
  pid: number;
  /** Absolute working tree directory (e.g. "/home/user/project") */
  dir: string;
  /** For clone: repository URL */
  url?: string;
  /** `git clone -q`: no progress on the terminal; the result is unchanged. */
  quiet?: boolean;
  /** For fetch/pull: remote name (default "origin") */
  remote?: string;
  /** For clone: branch to clone (default remote HEAD); for pull: branch name (default current) */
  ref?: string;
  /** Shallow depth; omitted means the whole history (`git clone --no-shallow`). */
  depth?: number;
  /** Username + password/token */
  auth?: { username: string; password: string };
  /** Author and committer (for pull merges), as the supervisor's git resolved them. */
  author?: { name: string; email: string; timestamp?: number; timezoneOffset?: number };
  committer?: { name: string; email: string; timestamp?: number; timezoneOffset?: number };
  /** Total operation budget (ms). Clone default 30 min; other ops default 5 min. */
  timeout?: number;
  /** Clone-only: caller holds an exclusive mutation lease for dir. */
  exclusiveDestination?: boolean;
  /**
   * Clone-only, the DO's: the job's id (its record's, git/clone-job.ts, and
   * the marker's the clone writes first), and what the clone tells the
   * record when every object it fetches is in (its phase becomes
   * 'checkout': a failure after leaves the repository, as git's does).
   */
  cloneJobId?: string;
  onCloneCheckoutPhase?: () => Promise<void>;
  /** Clone-only: normalized root covered by the exclusive mutation lease. */
  exclusiveMutationRoot?: string;
  /** The repository (a clone's destination) is on a mounted filesystem (`dir` its namespace path), where a wave's files are bounded (pack/mount-writer.ts). */
  onMount?: boolean;
  /** Trusted supervisor-only lease owner; never sent to the dynamic worker. */
  mutationOwner?: string;
  /**
   * Trusted supervisor-only: hand the clone's lease to a new owner and return
   * it (SqliteVFS.rotateExclusiveMutation), so every write the old owner's
   * facets may still make is refused. Never sent to the dynamic worker.
   */
  rotateMutationOwner?: () => string;
  /**
   * The operation's stop (a Ctrl-C, a kill, a destroy): no further piece
   * starts, the one in flight is let go, and a clone's facets lose their
   * writes before it answers `cancelled`. Never sent to the dynamic worker.
   */
  signal?: AbortSignal;
  /** fetch: `depth` counts from the current shallow boundary (git fetch --deepen). */
  relative?: boolean;
  /** `git clone --filter=<spec>`, normalized: a partial clone of a promisor remote. */
  filter?: string;
  /** `git clone --sparse`: a cone-mode sparse checkout of the top's files only. */
  sparse?: boolean;
  /** Fast clone, full history: blobs per history request (tuning; history.ts by default). */
  historyBlobsPerBatch?: number;
  /** Fast clone, full history: root trees per history request (tuning; history.ts by default). */
  historyCommitsPerChunk?: number;
  /** Fast clone, full history: pieces in flight at once (tuning; CLONE_HISTORY_CONCURRENCY). */
  historyConcurrency?: number;
  /** Fast clone, full history: work units one invocation decodes (tuning; processor.ts by default). */
  historyBudgetUnits?: number;
  /** Fast clone: which attempt at a batch or history piece this is (its temporary pack's name). */
  attempt?: number;
  /** Fast clone: how long a batch or history piece may run before it is retried (tuning; CLONE_PIECE_TIMEOUT_MS). */
  pieceTimeoutMs?: number;
  /** fetch-objects: the promisor remote's url and the ids to fetch from it. */
  oids?: string[];
  /** Fast clone: blobs per batch (tuning; git/pack/clone.ts BLOBS_PER_BATCH by default). */
  blobsPerBatch?: number;
  /** Fast clone: batches in flight at once (tuning; CLONE_BATCH_CONCURRENCY by default). */
  batchConcurrency?: number;
}

export type GitCloneInvocationPhase =
  | 'clone-prepare'
  | 'clone-batch'
  | 'clone-history'
  | 'clone-finish';

export interface GitNetworkPhaseDiagnostic {
  phase: GitCloneInvocationPhase | 'operation';
  invocationId: string;
  startedAt: number;
  endedAt: number;
  elapsed: number;
  outcome: 'success' | 'error' | 'timeout';
  /** Whether the facet began mutating the clone destination. */
  mutated?: boolean;
  error?: string;
  lastProgress?: { phase: string; loaded: number; total?: number };
  w7Waves: number;
  supervisorRpc: SupervisorRpcCounters;
  /** The invocation's wave writer: what it published and how long it waited. */
  waves?: WaveStats;
}

const WAVE_DIAGNOSTIC_FIELDS = [
  'waves', 'files', 'bytes', 'rpcWallMs', 'maxRpcWallMs', 'producerWaitMs',
  'ownershipVisits', 'maxWavePaths', 'maxWaveBytes', 'retries', 'wholeWaves',
] as const satisfies readonly (keyof WaveStats)[];

/** The facet's wave writer counters, as it reported them. */
function parseWaveDiagnostic(value: unknown): WaveStats | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed: WaveStats = {
    waves: 0, files: 0, bytes: 0, rpcWallMs: 0, maxRpcWallMs: 0, producerWaitMs: 0,
    ownershipVisits: 0, maxWavePaths: 0, maxWaveBytes: 0, retries: 0, wholeWaves: 0,
  };
  for (const field of WAVE_DIAGNOSTIC_FIELDS) {
    parsed[field] = nonNegativeCounter(Reflect.get(value, field));
  }
  return parsed;
}

export type GitNetworkErrorCode = 'GitCloneBudgetExceeded';

export interface GitNetworkResult {
  success: boolean;
  error?: string;
  elapsed: number;
  filesWritten: number;
  bytesWritten: number;
  supervisorRpc: SupervisorRpcCounters;
  metadataOverlay: MetadataOverlayStats;
  phases?: GitNetworkPhaseDiagnostic[];
  errorPhase?: GitCloneInvocationPhase | 'operation';
  errorCode?: GitNetworkErrorCode;
  /** A write git would have failed: git's own lines for it (pack/mount-writer.ts GitWriteFailure). */
  gitFailure?: string;
  budget?: GitCloneBudgetDiagnostic;
  /** A clone that failed after it wrote: its caller cleans up (git/clone-job.ts). */
  cleanup?: boolean;
  /** It was stopped (GitNetworkOpts.signal): the stop's reason. */
  cancelled?: { reason: unknown };
  /** fetch-objects: objects the promisor pack holds. */
  fetchedObjects?: number;
  /** For graph-filters: the step's answer. */
  graphFilters?: unknown;
}

export interface GitCloneBudgetDiagnostic {
  phase: GitCloneInvocationPhase;
  /** Checkout batches finished, and the files they wrote. */
  batchesCompleted: number;
  filesWritten: number;
  elapsedMs: number;
  limitMs: number;
}

interface FacetInvocationResult {
  success?: unknown;
  error?: unknown;
  filesWritten?: unknown;
  bytesWritten?: unknown;
  supervisorRpc?: unknown;
  metadataOverlay?: unknown;
  diagnostic?: unknown;
  prepared?: unknown;
  mutated?: unknown;
  refused?: unknown;
  errorCode?: unknown;
  fetched?: unknown;
  gitFailure?: unknown;
  graphFilters?: unknown;
}

interface GitFacetEntrypoint {
  fetch(request: Request): Promise<Response>;
}

interface GitFacetWorker {
  getEntrypoint(name?: string, options?: { limits: FacetResourceLimits }): GitFacetEntrypoint;
}

const CLONE_PHASE_TIMEOUT_MS = 240_000;
const DEFAULT_CLONE_BUDGET_MS = 30 * 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;

const EMPTY_METADATA_OVERLAY_STATS: MetadataOverlayStats = {
  entries: 0,
  accountedBytes: 0,
  maxEntries: 0,
  maxAccountedBytes: 0,
};

function nonNegativeCounter(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function parseGitNetworkErrorCode(value: unknown): GitNetworkErrorCode | undefined {
  return value === 'GitCloneBudgetExceeded' ? value : undefined;
}

function parseSupervisorRpcCounters(value: unknown): SupervisorRpcCounters {
  const reported = value && typeof value === 'object'
    ? value as Partial<Record<keyof SupervisorRpcCounters, unknown>>
    : {};
  const counters = createSupervisorRpcCounters();
  for (const key of Object.keys(counters) as (keyof SupervisorRpcCounters)[]) counters[key] = nonNegativeCounter(reported[key]);
  return counters;
}

function parseMetadataOverlayStats(value: unknown): MetadataOverlayStats {
  const stats = value && typeof value === 'object'
    ? value as Partial<Record<keyof MetadataOverlayStats, unknown>>
    : {};
  return {
    entries: nonNegativeCounter(stats.entries),
    accountedBytes: nonNegativeCounter(stats.accountedBytes),
    maxEntries: nonNegativeCounter(stats.maxEntries),
    maxAccountedBytes: nonNegativeCounter(stats.maxAccountedBytes),
  };
}

function addSupervisorRpcCounters(
  total: SupervisorRpcCounters,
  value: unknown,
): void {
  const counters = parseSupervisorRpcCounters(value);
  for (const key of Object.keys(total) as (keyof SupervisorRpcCounters)[]) {
    total[key] += counters[key];
  }
}

function parseLastProgress(
  value: unknown,
): GitNetworkPhaseDiagnostic['lastProgress'] {
  if (!value || typeof value !== 'object') return undefined;
  const progress = value as Record<string, unknown>;
  if (typeof progress.phase !== 'string') return undefined;
  const loaded = nonNegativeCounter(progress.loaded);
  const total = progress.total === undefined
    ? undefined
    : nonNegativeCounter(progress.total);
  return { phase: progress.phase, loaded, total };
}

function parsePhaseDiagnostic(
  value: unknown,
  fallback: Omit<GitNetworkPhaseDiagnostic, 'w7Waves' | 'supervisorRpc'>,
  result: FacetInvocationResult,
): GitNetworkPhaseDiagnostic {
  const diagnostic = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const phase = diagnostic.phase === 'clone-prepare' ||
      diagnostic.phase === 'clone-batch' ||
      diagnostic.phase === 'clone-history' ||
      diagnostic.phase === 'clone-finish' ||
      diagnostic.phase === 'operation'
    ? diagnostic.phase
    : fallback.phase;
  const outcome = diagnostic.outcome === 'success' ||
      diagnostic.outcome === 'error' ||
      diagnostic.outcome === 'timeout'
    ? diagnostic.outcome
    : fallback.outcome;
  const supervisorRpc = parseSupervisorRpcCounters(
    diagnostic.supervisorRpc ?? result.supervisorRpc,
  );
  return {
    phase,
    invocationId: typeof diagnostic.invocationId === 'string'
      ? diagnostic.invocationId
      : fallback.invocationId,
    startedAt: nonNegativeCounter(diagnostic.startedAt) || fallback.startedAt,
    endedAt: nonNegativeCounter(diagnostic.endedAt) || fallback.endedAt,
    elapsed: nonNegativeCounter(diagnostic.elapsed) || fallback.elapsed,
    outcome,
    mutated: typeof diagnostic.mutated === 'boolean'
      ? diagnostic.mutated
      : typeof result.mutated === 'boolean'
        ? result.mutated
        : fallback.mutated,
    error: typeof diagnostic.error === 'string'
      ? diagnostic.error
      : fallback.error,
    lastProgress: parseLastProgress(diagnostic.lastProgress),
    w7Waves: nonNegativeCounter(diagnostic.w7Waves) ||
      supervisorRpc.writeBatchStream,
    supervisorRpc,
    waves: parseWaveDiagnostic(diagnostic.waves),
  };
}

/** The operation's stop (GitNetworkOpts.signal) ended it: what a piece throws instead of trying again. */
class GitNetworkCancelled extends Error {
  constructor(readonly reason: unknown) {
    super('git network operation stopped');
  }
}

/** Throws GitNetworkCancelled once `signal` has stopped the operation. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GitNetworkCancelled(signal.reason);
}

/** A promise that rejects GitNetworkCancelled when `signal` stops the operation; `off` lets it go. */
function cancellation(signal: AbortSignal | undefined): { stopped: Promise<never>; off: () => void } {
  if (signal === undefined) return { stopped: new Promise<never>(() => {}), off: () => {} };
  let off = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new GitNetworkCancelled(signal.reason));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    off = () => signal.removeEventListener('abort', onAbort);
  });
  return { stopped, off };
}

class GitClonePhaseError extends Error {
  readonly phase: GitCloneInvocationPhase;
  readonly diagnostic: GitNetworkPhaseDiagnostic;
  readonly mutated: boolean | undefined;
  readonly errorCode: GitNetworkErrorCode | undefined;
  /** A write git would have failed: git's lines (GitNetworkResult.gitFailure). */
  readonly gitFailure: string | undefined;

  constructor(
    phase: GitCloneInvocationPhase,
    message: string,
    diagnostic: GitNetworkPhaseDiagnostic,
    errorCode?: GitNetworkErrorCode,
    gitFailure?: string,
  ) {
    super(message);
    this.name = 'GitClonePhaseError';
    this.phase = phase;
    this.diagnostic = diagnostic;
    this.mutated = diagnostic.mutated;
    this.errorCode = errorCode;
    this.gitFailure = gitFailure;
  }
}

class GitCloneBudgetExceededError extends GitClonePhaseError {
  readonly code = 'GitCloneBudgetExceeded';
  readonly budget: GitCloneBudgetDiagnostic;

  constructor(
    phase: GitCloneInvocationPhase,
    budget: GitCloneBudgetDiagnostic,
    diagnostic: GitNetworkPhaseDiagnostic,
  ) {
    super(
      phase,
      `git clone budget exhausted after ${budget.batchesCompleted} batches / ` +
        `${budget.filesWritten} files (elapsed=${budget.elapsedMs}ms limit=${budget.limitMs}ms)`,
      diagnostic,
      'GitCloneBudgetExceeded',
    );
    this.name = 'GitCloneBudgetExceededError';
    this.budget = budget;
  }
}

interface GitCloneBudgetContext {
  startedAt: number;
  limitMs: number;
  batchesCompleted: number;
  filesWritten: number;
}

function cloneBudgetDiagnostic(
  phase: GitCloneInvocationPhase,
  context: GitCloneBudgetContext,
  now: number,
): GitCloneBudgetDiagnostic {
  return {
    phase,
    batchesCompleted: context.batchesCompleted,
    filesWritten: context.filesWritten,
    elapsedMs: Math.max(0, now - context.startedAt),
    limitMs: context.limitMs,
  };
}

async function hashCloneOptions(opts: GitNetworkOpts): Promise<string> {
  const immutable = JSON.stringify({
    op: opts.op,
    dir: opts.dir,
    url: opts.url,
    remote: opts.remote ?? 'origin',
    ref: opts.ref ?? null,
    depth: opts.depth ?? null,
    exclusiveDestination: opts.exclusiveDestination === true,
    exclusiveMutationRoot: opts.exclusiveMutationRoot ?? null,
  });
  return sha256Hex(immutable);
}

function phaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invokeFacet(
  entrypoint: GitFacetEntrypoint,
  phase: GitCloneInvocationPhase,
  invocationId: string,
  body: Record<string, unknown>,
  outerDeadline: number,
  phaseLimitMs: number,
  budgetContext?: GitCloneBudgetContext,
  signal?: AbortSignal,
): Promise<{ result: FacetInvocationResult; diagnostic: GitNetworkPhaseDiagnostic }> {
  throwIfCancelled(signal);
  const startedAt = Date.now();
  const remaining = outerDeadline - startedAt;
  const timeoutMs = Math.min(phaseLimitMs, remaining);
  if (timeoutMs <= 0) {
    const diagnostic: GitNetworkPhaseDiagnostic = {
      phase,
      invocationId,
      startedAt,
      endedAt: startedAt,
      elapsed: 0,
      outcome: 'timeout',
      error: `git clone budget exhausted before ${phase}`,
      w7Waves: 0,
      supervisorRpc: createSupervisorRpcCounters(),
    };
    if (budgetContext) {
      throw new GitCloneBudgetExceededError(
        phase,
        cloneBudgetDiagnostic(phase, budgetContext, startedAt),
        diagnostic,
      );
    }
    throw new GitClonePhaseError(phase, diagnostic.error!, diagnostic);
  }

  const controller = new AbortController();
  const phaseDeadline = startedAt + timeoutMs;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const outerBudgetLimited = remaining <= phaseLimitMs && budgetContext !== undefined;
      const message = outerBudgetLimited
        ? 'git clone total budget reached during ' + phase
        : `git ${phase} timed out after ${timeoutMs / 1000}s`;
      controller.abort(message);
      if (outerBudgetLimited) {
        const endedAt = Date.now();
        const diagnostic: GitNetworkPhaseDiagnostic = {
          phase,
          invocationId,
          startedAt,
          endedAt,
          elapsed: endedAt - startedAt,
          outcome: 'timeout',
          error: message,
          w7Waves: 0,
          supervisorRpc: createSupervisorRpcCounters(),
        };
        reject(new GitCloneBudgetExceededError(
          phase,
          cloneBudgetDiagnostic(phase, budgetContext, Math.max(endedAt, outerDeadline)),
          diagnostic,
        ));
      } else {
        reject(new Error(message));
      }
    }, timeoutMs);
  });

  const stop = cancellation(signal);
  try {
    const call = entrypoint.fetch(new Request(
      `http://git/git/${phase}/${encodeURIComponent(invocationId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ ...body, phase, invocationId, phaseDeadline }),
        signal: controller.signal,
      },
    )).then((response) => {
      if (controller.signal.aborted) disposeRpcResource(response);
      return response;
    });
    const response = await Promise.race([call, timeout, stop.stopped]);
    let result: FacetInvocationResult;
    try {
      result = await response.json() as FacetInvocationResult;
    } finally {
      disposeRpcResource(response);
    }
    const endedAt = Date.now();
    const diagnostic = parsePhaseDiagnostic(result.diagnostic, {
      phase,
      invocationId,
      startedAt,
      endedAt,
      elapsed: endedAt - startedAt,
      outcome: result.success === true ? 'success' : 'error',
      error: typeof result.error === 'string' ? result.error : undefined,
    }, result);
    return { result, diagnostic };
  } catch (error) {
    if (error instanceof GitClonePhaseError) throw error;
    if (error instanceof GitNetworkCancelled) {
      // The facet's call is let go; what it may still write loses its authority with the clone's lease.
      controller.abort(error.reason);
      throw error;
    }
    const endedAt = Date.now();
    const message = phaseErrorMessage(error);
    const diagnostic: GitNetworkPhaseDiagnostic = {
      phase,
      invocationId,
      startedAt,
      endedAt,
      elapsed: endedAt - startedAt,
      outcome: controller.signal.aborted ? 'timeout' : 'error',
      error: message,
      w7Waves: 0,
      supervisorRpc: createSupervisorRpcCounters(),
    };
    throw new GitClonePhaseError(phase, message, diagnostic);
  } finally {
    stop.off();
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** The supervisor stub surface this module calls: terminal progress, nothing else. */
interface GitSupervisorStub {
  /** Process output is bytes on the relay; this text producer encodes. */
  stdout(data: Uint8Array): Promise<unknown>;
}
const GIT_PROGRESS_ENCODER = new TextEncoder();

async function writeClonePhaseProgress(
  supervisor: GitSupervisorStub,
  diagnostic: GitNetworkPhaseDiagnostic,
): Promise<void> {
  try {
    const rpcCount = Object.values(diagnostic.supervisorRpc)
      .reduce((total, count) => total + count, 0);
    const status = diagnostic.outcome === 'success' ? 'complete' : diagnostic.outcome;
    const result = await supervisor.stdout(GIT_PROGRESS_ENCODER.encode(
      `\n[git] ${diagnostic.phase} ${status} ` +
      `(invocation=${diagnostic.invocationId} wall=${diagnostic.elapsed}ms ` +
      `w7=${diagnostic.w7Waves} rpc=${rpcCount})` +
      (diagnostic.outcome === 'success' || !diagnostic.error ? '' : `: ${diagnostic.error}`) + '\n',
    ));
    disposeRpcResource(result);
  } catch {
    // Terminal progress is best-effort; the phase result remains authoritative.
  }
}

/**
 * Batches of a fast clone that run at once. Facets loaded by one session
 * share its thread (measured: four 4.2 s CPU burners took 18.8 s), so more
 * at once buy only overlapping network waits, and each holds its own
 * buffers (two waves of up to 4 MiB, a 4 MiB base cache). Measured
 * 2026-10-05, vscode depth 1 at four: the session object peaked at 207 MiB
 * and was reset (GraphQL fatalInternalErrors 1).
 */
const CLONE_BATCH_CONCURRENCY = 2;

/**
 * The facets a clone's invocations go to. A piece whose answer timed out may
 * still be running, and writing: before it runs again, `fence` hands the
 * clone's lease to a new owner, which revokes every write of the facets
 * loaded so far (theirs are ESTALE from then on), and loads a facet that
 * writes as the new owner. Each fence bumps `epoch`, so a piece that was in
 * flight on an older facet knows its failure may be the fence's doing.
 * `fence` is null without a lease to rotate: then nothing hung is retried.
 */
interface CloneFacets {
  entrypoint: GitFacetEntrypoint;
  epoch: number;
  fence: (() => void) | null;
}

interface CloneBatchRun {
  facets: CloneFacets;
  outerDeadline: number;
  budgetContext: GitCloneBudgetContext;
  phases: GitNetworkPhaseDiagnostic[];
  accountResult(result: FacetInvocationResult): void;
  progress: GitSupervisorStub | null;
  /** git's error for each worktree file a batch could not write, by batch: the checkout fails once all are done. */
  checkoutErrors: Map<number, string[]>;
  /** The clone's stop (GitNetworkOpts.signal). */
  signal?: AbortSignal;
}

/**
 * Run `items` through `run`, `concurrency` at a time. A failure stops new
 * items; those in flight are awaited before it is thrown, so an abort never
 * races a writer.
 */
async function runPool<T>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        await run(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure !== null) throw failure;
}

/**
 * A batch or history piece that failed in transit, or hung, is tried again
 * under the one lost-transport policy (pack/transport.ts): seen live as a
 * request to the git server failing (UploadPackError) and a piece hung
 * (react's first batch, three times in five clones). A write wave whose
 * answer is lost is the wave writer's to re-send. Its earlier attempt's
 * temporary pack is discarded.
 */
const CLONE_PIECE_ATTEMPTS = RETRY_ATTEMPTS;
/**
 * A piece takes seconds to minutes: react's largest history piece 51 s,
 * Linux's batches 21-41 s, its heaviest (46 MB of large files, 133 waves)
 * 132 s live, which a 150 s bound cut off twice. One that has run this long
 * is taken as hung and retried; a lost wave is the writer's to re-send.
 */
const CLONE_PIECE_TIMEOUT_MS = 300_000;

function transientPieceFailure(diagnostic: GitNetworkPhaseDiagnostic, error: string): boolean {
  return diagnostic.outcome === 'timeout' || isLostTransport(error);
}

/** One fast-clone facet invocation after prepare; its failure is the clone's. */
async function invokeClonePhase(
  phase: 'clone-batch' | 'clone-history' | 'clone-finish',
  opts: Record<string, unknown>,
  run: CloneBatchRun,
): Promise<{ result: FacetInvocationResult; diagnostic: GitNetworkPhaseDiagnostic }> {
  let invocation!: { result: FacetInvocationResult; diagnostic: GitNetworkPhaseDiagnostic };
  for (let attempt = 1; attempt <= CLONE_PIECE_ATTEMPTS; attempt++) {
    const epoch = run.facets.epoch;
    try {
      invocation = await invokeFacet(
        run.facets.entrypoint,
        phase,
        crypto.randomUUID(),
        { ...opts, attempt } as Omit<GitNetworkOpts, 'mutationOwner'>,
        run.outerDeadline,
        phase === 'clone-finish'
          ? CLONE_PHASE_TIMEOUT_MS
          : positiveSafeInteger(opts.pieceTimeoutMs, CLONE_PIECE_TIMEOUT_MS, 'piece timeout'),
        run.budgetContext,
        run.signal,
      );
    } catch (error) {
      // A piece that hung (or whose facet call broke) throws rather than answers; a stopped clone tries nothing again.
      if (!(error instanceof GitClonePhaseError) || error instanceof GitCloneBudgetExceededError ||
          phase === 'clone-finish' || attempt === CLONE_PIECE_ATTEMPTS ||
          !transientPieceFailure(error.diagnostic, error.message)) {
        throw error;
      }
      if (error.diagnostic.outcome === 'timeout') {
        // It may still be running: its writes lose their authority first.
        if (run.facets.fence === null) throw error;
        if (run.facets.epoch === epoch) run.facets.fence();
      }
      run.phases.push(error.diagnostic);
      if (run.progress) {
        await writeCloneProgressLine(run.progress, `\n[git] ${phase} attempt ${attempt} failed: ${error.message}\n`);
      }
      await retryDelay(attempt - 1);
      throwIfCancelled(run.signal);
      continue;
    }
    run.phases.push(invocation.diagnostic);
    run.accountResult(invocation.result);
    const error = typeof invocation.result.error === 'string' ? invocation.result.error : '';
    // A fence for another piece revoked this one's writes while it ran.
    const fenced = run.facets.epoch !== epoch;
    if (invocation.result.success === true || phase === 'clone-finish' ||
        !(fenced || transientPieceFailure(invocation.diagnostic, error))) break;
    if (run.progress) {
      await writeCloneProgressLine(run.progress, `\n[git] ${phase} attempt ${attempt} failed: ${error}\n`);
    }
    if (attempt < CLONE_PIECE_ATTEMPTS) await retryDelay(attempt - 1);
    throwIfCancelled(run.signal);
  }
  if (invocation.result.success !== true) {
    throw new GitClonePhaseError(
      phase,
      typeof invocation.result.error === 'string' ? invocation.result.error : phase + ' failed',
      invocation.diagnostic,
      undefined,
      typeof invocation.result.gitFailure === 'string' ? invocation.result.gitFailure : undefined,
    );
  }
  return invocation;
}

/** The fast clone after prepare: its blob batches, CLONE_BATCH_CONCURRENCY at a time. Returns the index shares. */
async function runCloneBatches(
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  fast: ClonePrepared,
  run: CloneBatchRun,
  /** A streamed clone's batches read their blobs from its stored pack. */
  local = false,
): Promise<{ name: string; bytes: number }[]> {
  const shares: { name: string; bytes: number }[] = [...fast.shares];
  let completed = 0;
  const concurrency = positiveSafeInteger(facetOpts.batchConcurrency, CLONE_BATCH_CONCURRENCY, 'batch concurrency');
  await runPool(fast.batches, concurrency, async (batch) => {
    const invocation = await invokeClonePhase('clone-batch', {
      ...facetOpts, ...identity, batch: { index: batch.index, bytes: batch.bytes }, capabilities: fast.capabilities, partial: fast.partial,
      local: local === true,
    }, run);
    const result = (invocation.result as { batch?: CloneBatchResult }).batch;
    if (result === undefined) throw new GitClonePhaseError('clone-batch', 'clone-batch returned no batch', invocation.diagnostic);
    shares.push({ name: 'index-' + result.index, bytes: result.indexBytes });
    if (result.checkoutErrors !== undefined) run.checkoutErrors.set(result.index, result.checkoutErrors);
    completed++;
    run.budgetContext.batchesCompleted++;
    run.budgetContext.filesWritten += result.files;
    if (run.progress) {
      await writeCloneProgressLine(run.progress,
        `\n[git] clone-batch ${completed}/${fast.batches.length} complete (blobs=${result.blobs} files=${result.files} ` +
        (result.pack === null ? '' : `pack=${(result.pack.packBytes / 1048576).toFixed(1)}MB `) +
        `wall=${invocation.diagnostic.elapsed}ms ` +
        `w7=${invocation.diagnostic.w7Waves})\n`);
    }
  });
  return shares;
}

/**
 * History pieces run one at a time: each holds a base cache and a window of
 * stored bytes (~30 MB), and facets count against the session's memory.
 */
const CLONE_HISTORY_CONCURRENCY = 1;

/**
 * A clone's history (git/pack/history.ts): commits, then trees, then blobs;
 * all of it, or (`facetOpts.depth`) a shallow clone's commits. Returns the
 * commits' records for the commit-graph, or null when one did not parse (no
 * graph).
 */
async function runCloneHistory(
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  fast: ClonePrepared,
  run: CloneBatchRun,
  tagsFound: Set<string>,
): Promise<StagedFile[] | null> {
  const base = { ...facetOpts, ...identity, capabilities: fast.capabilities };
  let pieces = 0;
  let packBytes = 0;
  const invoke = async (history: Record<string, unknown>): Promise<{ step: HistoryStepResult; elapsed: number }> => {
    const invocation = await invokeClonePhase('clone-history', { ...base, history }, run);
    const step = (invocation.result as { history?: HistoryStepResult }).history;
    if (step === undefined) throw new GitClonePhaseError('clone-history', 'clone-history returned nothing', invocation.diagnostic);
    return { step, elapsed: invocation.diagnostic.elapsed };
  };
  /** A piece, and its continuations while its decoding runs past a budget. */
  // The commits piece meets every commit and annotated tag of the history: it watches for the tags'.
  const tagInterest = [...new Set(fast.tags.flatMap((tag) => [tag.oid, tag.peeled]))];
  let graph: StagedFile[] | null = [];
  const piece = async (kind: HistoryKind, name: string, request: Record<string, unknown>): Promise<StagedFile[]> => {
    const watch = kind === 'commits' && tagInterest.length > 0 ? { tagInterest } : {};
    const recorded = (step: HistoryStepResult) => {
      if (step.graphLists === null || graph === null) graph = null;
      else graph.push(...step.graphLists ?? []);
    };
    let { step, elapsed } = await invoke({ step: 'piece', kind, piece: name, ...request, ...watch });
    const lists = [...step.lists];
    recorded(step);
    for (const oid of step.tagsFound ?? []) tagsFound.add(oid);
    for (let part = 1; step.pending !== null; part++) {
      ({ step, elapsed } = await invoke({ step: 'resume', kind, piece: name, part, pending: step.pending, ...watch }));
      lists.push(...step.lists);
      recorded(step);
      for (const oid of step.tagsFound ?? []) tagsFound.add(oid);
    }
    pieces++;
    packBytes += step.pack?.packBytes ?? 0;
    if (run.progress) {
      await writeCloneProgressLine(run.progress,
        `\n[git] clone-history ${name} complete (objects=${step.pack?.objects ?? 0} ` +
        `pack=${((step.pack?.packBytes ?? 0) / 1048576).toFixed(1)}MB wall=${elapsed}ms)\n`);
    }
    return lists;
  };
  const roots = await piece('commits', 'commits', { head: fast.commit, ...(facetOpts.depth !== undefined ? { depth: facetOpts.depth } : {}) });
  const blobLists: StagedFile[] = [];
  const commitsPerChunk = positiveSafeInteger(facetOpts.historyCommitsPerChunk, COMMITS_PER_CHUNK, 'history commits per chunk');
  const concurrency = positiveSafeInteger(facetOpts.historyConcurrency, CLONE_HISTORY_CONCURRENCY, 'history concurrency');
  await runPool(treeSlices(roots, commitsPerChunk), concurrency, async (source, index) => {
    blobLists.push(...await piece('trees', 'trees-' + index, { source }));
  });
  const plan = await invokeClonePhase('clone-history', {
    ...base,
    history: { step: 'plan', lists: blobLists, present: fast.batches.map((batch) => ({ name: 'batch-' + batch.index, bytes: batch.bytes })) },
  }, run);
  const batches = (plan.result as { history?: { batches: StagedFile[] } }).history?.batches ?? [];
  await runPool(batches, concurrency, async (source, index) => {
    await piece('blobs', 'blobs-' + index, { source });
  });
  if (run.progress) {
    await writeCloneProgressLine(run.progress,
      `\n[git] clone-history complete (${pieces} requests, ${(packBytes / 1048576).toFixed(1)}MB)\n`);
  }
  return graph;
}

/**
 * A streamed clone after prepare: its pack's decoding continued from the
 * stored bytes while it stops at a budget, then the checkout planned from
 * the pack (clone.ts clonePlanFromStore).
 */
async function runCloneSnapshot(
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  stream: CloneStreamed['stream'],
  run: CloneBatchRun,
  tagsFound: Set<string>,
): Promise<ClonePrepared> {
  const base = { ...facetOpts, ...identity, capabilities: [] };
  const tagInterest = [...new Set(stream.tags.flatMap((tag) => [tag.oid, tag.peeled]))];
  let pending = stream.pending;
  for (let part = 1; pending !== null; part++) {
    const invocation = await invokeClonePhase('clone-history', {
      ...base, history: { step: 'resume', kind: 'snapshot', piece: 'snapshot', part, pending, tagInterest },
    }, run);
    const step = (invocation.result as { history?: HistoryStepResult }).history;
    if (step === undefined) throw new GitClonePhaseError('clone-history', 'clone-history returned nothing', invocation.diagnostic);
    for (const oid of step.tagsFound ?? []) tagsFound.add(oid);
    pending = step.pending;
  }
  const plan = await invokeClonePhase('clone-history', {
    ...base, history: { step: 'checkout-plan', commit: stream.commit },
  }, run);
  const planned = (plan.result as { history?: ClonePrepared }).history;
  if (planned === undefined) throw new GitClonePhaseError('clone-history', 'checkout-plan returned nothing', plan.diagnostic);
  return planned;
}

/** The index from the shares; a full clone's shallow file goes, and its commit-graph is written; then the marker. */
async function runCloneFinish(
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  shares: { name: string; bytes: number }[],
  full: boolean,
  cacheTreeBytes: number,
  tags: readonly CloneTag[],
  /** A full clone's commit records (runCloneHistory), for its commit-graph. */
  graph: StagedFile[] | null,
  run: CloneBatchRun,
  /** A file could not be written: no index, and the marker stays for the clone's cleanup. */
  checkoutFailed = false,
): Promise<void> {
  const finish = await invokeClonePhase('clone-finish', { ...facetOpts, ...identity, shares, full, cacheTreeBytes, tags, graph, checkoutFailed }, run);
  if (run.progress) await writeClonePhaseProgress(run.progress, finish.diagnostic);
}

async function writeCloneProgressLine(supervisor: GitSupervisorStub, line: string): Promise<void> {
  try {
    disposeRpcResource(await supervisor.stdout(GIT_PROGRESS_ENCODER.encode(line)));
  } catch {
    // Terminal progress is best-effort; the batch result remains authoritative.
  }
}

/** A piece's wall-time budget: within a facet invocation's limits, with room to write its file. */
const GRAPH_FILTERS_PIECE_BUDGET_MS = 20_000;
/** One step's limit: a piece stops at its budget, an assemble writes a layer. */
const GRAPH_FILTERS_STEP_TIMEOUT_MS = 120_000;
/** The whole pass's limit. */
const GRAPH_FILTERS_TIMEOUT_MS = 60 * 60_000;
/** Commits a piece is asked for; it stops earlier at its budget. */
const GRAPH_FILTERS_PIECE_COMMITS = 20_000;

/** How a clone's changed-path filters pass went. */
export interface GraphFiltersOutcome {
  /** The new layer's name, or null when the chain was left as it is. */
  layer: string | null;
  /**
   * Why the chain was left as it is: there is no graph, it is not one
   * unfiltered base layer, another writer holds its lock, or it changed
   * under the pass.
   */
  skipped?: 'no-graph' | 'not-a-base' | 'locked' | 'moved';
  commits: number;
  pieces: number;
  /** Trees read from the packs, and their bytes. */
  trees: number;
  treeBytes: number;
  elapsed: number;
}

/**
 * A full clone's commit-graph (git/pack/graph-filters.ts), after the clone
 * has answered: one facet loaded for the whole pass and invoked once a step,
 * as a clone invokes its phases (a facet loaded a step deepened each step's
 * subrequests until "Subrequest depth limit exceeded", measured on vscode's
 * fourteenth). Each piece holds a tree cache and the pack store's.
 */
export async function runGraphFilters(
  ctx: DurableObjectState,
  env: any,
  opts: { pid: number; dir: string; pieceBudgetMs?: number; pieceCommits?: number; onMount?: boolean },
  network: WorkspaceNetwork,
): Promise<GraphFiltersOutcome> {
  const result = await execGitNetwork(ctx, env, {
    op: 'graph-filters', pid: opts.pid, dir: opts.dir, quiet: true, timeout: GRAPH_FILTERS_TIMEOUT_MS,
    ...(opts.onMount === true ? { onMount: true } : {}),
    graphFilterPieceCommits: opts.pieceCommits, graphFilterPieceBudgetMs: opts.pieceBudgetMs,
  }, network);
  if (!result.success) throw new Error('graph-filters: ' + (result.error ?? 'failed'));
  return result.graphFilters as GraphFiltersOutcome;
}

/** The pass's steps, each one invocation of the facet `call` reaches. */
async function driveGraphFilters(
  call: (step: GraphFiltersStep) => Promise<unknown>,
  opts: { pieceBudgetMs?: number; pieceCommits?: number },
): Promise<GraphFiltersOutcome> {
  const started = Date.now();
  const step = async <T>(graphFilters: GraphFiltersStep): Promise<T> => await call(graphFilters) as T;
  const outcome: GraphFiltersOutcome = { layer: null, commits: 0, pieces: 0, trees: 0, treeBytes: 0, elapsed: 0 };
  const plan = await step<{ layer: string; commits: number; pass: string } | { skipped: NonNullable<GraphFiltersOutcome['skipped']> }>({ step: 'plan' });
  if ('skipped' in plan) return { ...outcome, skipped: plan.skipped, elapsed: Date.now() - started };
  outcome.commits = plan.commits;
  const files: { name: string; bytes: number }[] = [];
  const size = positiveSafeInteger(opts.pieceCommits, GRAPH_FILTERS_PIECE_COMMITS, 'graph filter piece commits');
  const budgetMs = positiveSafeInteger(opts.pieceBudgetMs, GRAPH_FILTERS_PIECE_BUDGET_MS, 'graph filter piece budget');
  try {
    for (let from = 0; from < plan.commits;) {
      const piece = await step<{ next: number; file: { name: string; bytes: number } | null; trees: number; treeBytes: number }>({
        step: 'piece', layer: plan.layer, pass: plan.pass, from, to: Math.min(from + size, plan.commits), budgetMs,
      });
      if (piece.next <= from) throw new Error('graph-filters piece made no progress at ' + from);
      if (piece.file !== null) files.push(piece.file);
      outcome.pieces++;
      outcome.trees += piece.trees;
      outcome.treeBytes += piece.treeBytes;
      from = piece.next;
    }
  } catch (error) {
    // The base layer stays, without filters, as git leaves one it was not asked to filter.
    await step({ step: 'discard', layer: plan.layer, pass: plan.pass }).catch(() => null);
    throw error;
  }
  const assembled = await step<{ layer: string | null; skipped?: GraphFiltersOutcome['skipped'] }>({ step: 'assemble', layer: plan.layer, pass: plan.pass, files });
  return { ...outcome, layer: assembled.layer, ...(assembled.skipped ? { skipped: assembled.skipped } : {}), elapsed: Date.now() - started };
}

/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export async function execGitNetwork(
  ctx: DurableObjectState,
  env: any,
  opts: GitNetworkOpts,  /**
   * The workspace's network (`workspace.network`): every facet this operation
   * loads goes out through its egress, when its host supplied one (prepare,
   * every batch and history piece, a fence's reload, fetch/pull/push).
   */
  network: WorkspaceNetwork,
): Promise<GitNetworkResult> {
  const start = Date.now();
  const timeoutMs = opts.timeout ?? (opts.op === 'clone'
    ? DEFAULT_CLONE_BUDGET_MS
    : DEFAULT_OPERATION_TIMEOUT_MS);
  const outerDeadline = start + timeoutMs;
  try {
    if (!Number.isInteger(opts.pid) || opts.pid <= 0) {
      throw new Error('git network operation requires a positive process pid');
    }
    if (!env?.LOADER?.load) {
      return {
        success: false,
        error: 'env.LOADER.load not available — cannot spawn git facet',
        elapsed: Date.now() - start,
        filesWritten: 0,
        bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
      };
    }

    const { mutationOwner, rotateMutationOwner, onCloneCheckoutPhase, signal, ...facetOpts } = opts;
    throwIfCancelled(signal);
    const ctxExports = getCtxExports();
    // One run for every binding this operation mints, a fence's included.
    const writerId = crypto.randomUUID();
    const bindingFor = (owner: string | undefined) => ctxExports!.SupervisorRPC!<GitSupervisorStub>({
      props: { ...supervisorBindingProps(ctx, opts.pid, { writerId, network }), mutationOwner: owner },
    });
    const supervisorBinding = ctxExports?.SupervisorRPC ? bindingFor(mutationOwner) : undefined;

    if (!supervisorBinding) {
      return {
        success: false,
        error: 'SupervisorRPC binding not available',
        elapsed: Date.now() - start,
        filesWritten: 0,
        bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
      };
    }

    let worker: GitFacetWorker | undefined;
    let entrypoint: GitFacetEntrypoint | undefined;
    // Facets a clone's fences loaded after the first (CloneFacets).
    const fencedLoads: { binding: unknown; worker: GitFacetWorker; entrypoint: GitFacetEntrypoint; endFetch: () => void }[] = [];
    // The unkeyed git worker is one distinct Dynamic Worker in flight on the
    // session's ledger from load to teardown — bracketed, never wrapped (see
    // beginLoaderFetch).
    const endFetch = beginLoaderFetch(ctx, `git-network:${crypto.randomUUID()}`);
    try {
      const gitBundleSource = await fetchGitBundleSource(env);
      const facetCode = (binding: unknown) => ({
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
        mainModule: 'git-network-worker.js',
        // Facet gets:
        //   - its own worker code (git-network-worker.js), with the
        //     W7 frame helpers (encodeWriteBatchStream + supporting
        //     state) prepended so the buffered fs adapter can call
        //     them as bare identifiers — the same shape IsolatePool's
        //     `preamble` option provides for npm install. This is the
        //     W7 v3 emits one bounded record per pull; the receiver owns
        //     the aggregate 8 MiB payload-credit and transaction limits.
        //   - the pre-bundled isomorphic-git (git-bundle.js), the staged
        //     copy of vendor/git.generated.mjs (runtime/git-bundle-artifact.ts)
        modules: {
          'git-network-worker.js': assembleGitNetworkFacetSource(),
          'git-bundle.js': gitBundleSource,
        },
        env: { SUPERVISOR: binding },
        // The git server is reached through the workspace's egress, when it has one.
        ...loaderOutbound(network),
      });
      const loadedWorker: GitFacetWorker = env.LOADER.load(applyFacetLimits('git', facetCode(supervisorBinding)));
      worker = loadedWorker;
      entrypoint = loadedWorker.getEntrypoint(undefined, { limits: facetLimits('git') });
      if (opts.op === 'clone') {
        const jobId = opts.cloneJobId ?? crypto.randomUUID();
        const optionsHash = await hashCloneOptions(opts);
        const phases: GitNetworkPhaseDiagnostic[] = [];
        const supervisorRpc = createSupervisorRpcCounters();
        let metadataOverlay = { ...EMPTY_METADATA_OVERLAY_STATS };
        let filesWritten = 0;
        let bytesWritten = 0;
        const budgetContext: GitCloneBudgetContext = {
          startedAt: start,
          limitMs: timeoutMs,
          batchesCompleted: 0,
          filesWritten: 0,
        };
        const facets: CloneFacets = {
          entrypoint,
          epoch: 0,
          fence: rotateMutationOwner === undefined ? null : () => {
            const binding = bindingFor(rotateMutationOwner());
            const endLoad = beginLoaderFetch(ctx, `git-network:${crypto.randomUUID()}`);
            const loaded: GitFacetWorker = env.LOADER.load(applyFacetLimits('git', facetCode(binding)));
            const fresh = loaded.getEntrypoint(undefined, { limits: facetLimits('git') });
            fencedLoads.push({ binding, worker: loaded, entrypoint: fresh, endFetch: endLoad });
            facets.entrypoint = fresh;
            facets.epoch++;
          },
        };

        const accountResult = (result: FacetInvocationResult): void => {
          filesWritten += nonNegativeCounter(result.filesWritten);
          bytesWritten += nonNegativeCounter(result.bytesWritten);
          addSupervisorRpcCounters(supervisorRpc, result.supervisorRpc);
          const overlay = parseMetadataOverlayStats(result.metadataOverlay);
          if (overlay.entries > 0 || overlay.accountedBytes > 0) {
            metadataOverlay = overlay;
          }
        };

        try {
          const prepareInvocationId = crypto.randomUUID();
          const prepare = await invokeFacet(
            entrypoint,
            'clone-prepare',
            prepareInvocationId,
            { ...facetOpts, jobId, optionsHash },
            outerDeadline,
            CLONE_PHASE_TIMEOUT_MS,
            budgetContext,
            signal,
          );
          phases.push(prepare.diagnostic);
          accountResult(prepare.result);
          if (prepare.result.success !== true ||
              !prepare.result.prepared ||
              typeof prepare.result.prepared !== 'object') {
            throw new GitClonePhaseError(
              'clone-prepare',
              typeof prepare.result.error === 'string'
                ? prepare.result.error
                : 'clone-prepare returned an invalid result',
              prepare.diagnostic,
              undefined,
              typeof prepare.result.gitFailure === 'string' ? prepare.result.gitFailure : undefined,
            );
          }
          if (!opts.quiet) await writeClonePhaseProgress(supervisorBinding, prepare.diagnostic);

          const prepared = prepare.result.prepared as { fast?: ClonePrepared; stream?: CloneStreamed['stream'] };
          // A partial clone's objects are in once its filtered pack is: its
          // batches are git's lazy fetch of what the checkout writes.
          if (facetOpts.filter !== undefined && prepared.fast !== undefined) {
            throwIfCancelled(signal);
            await onCloneCheckoutPhase?.();
          }
          const run: CloneBatchRun = {
            facets,
            outerDeadline,
            budgetContext,
            phases,
            accountResult,
            progress: opts.quiet ? null : supervisorBinding,
            checkoutErrors: new Map(),
            signal,
          };
          const identity = { jobId, optionsHash };
          let fast = prepared.fast;
          // The ids of the remote's tags the clone's packs held: finish writes those tags.
          const tagsFound = new Set(prepared.fast?.tagsFound ?? prepared.stream?.tagsFound ?? []);
          if (prepared.stream !== undefined) {
            // A server without wants by id sent one pack: finish decoding it, then plan the checkout from it.
            fast = await runCloneSnapshot(facetOpts, identity, prepared.stream, run, tagsFound);
            // The one pack is stored: what comes next only checks it out.
            throwIfCancelled(signal);
            await onCloneCheckoutPhase?.();
          }
          if (fast === undefined) throw new GitClonePhaseError('clone-prepare', 'clone-prepare returned no plan', prepare.diagnostic);
          const shares = await runCloneBatches(facetOpts, identity, fast, run, prepared.stream !== undefined);
          const full = facetOpts.depth === undefined;
          let graph: StagedFile[] | null = null;
          // Commits past the worktree's have blobs it did not fetch: a full
          // clone's history, and a --depth N clone's (N > 1) unless partial.
          const older = full || (facetOpts.depth! > 1 && facetOpts.filter === undefined);
          if (older && prepared.fast !== undefined && fast.commit !== null) {
            const records = await runCloneHistory(facetOpts, identity, fast, run, tagsFound);
            // The commit-graph is a full clone's: git writes none in a shallow repository.
            if (full) graph = records;
          }
          // A clone that is not partial has every object once its batches (and history) are in.
          if (prepared.fast !== undefined && facetOpts.filter === undefined) {
            throwIfCancelled(signal);
            await onCloneCheckoutPhase?.();
          }
          const tags = tagsHeld(prepared.fast?.tags ?? prepared.stream?.tags ?? [], tagsFound);
          // A file a batch could not write: as git, every object fetched first, the clone
          // finished but its index, then the checkout's failure with git's errors (its repository kept).
          const checkoutErrors = [...run.checkoutErrors.entries()].sort(([a], [b]) => a - b).flatMap(([, errors]) => errors);
          await runCloneFinish(facetOpts, identity, shares, full, fast.cacheTreeBytes, tags, graph, run, checkoutErrors.length > 0);
          if (checkoutErrors.length > 0) {
            facets.fence?.();
            return {
              success: false,
              error: 'unable to checkout working tree',
              errorPhase: 'clone-finish',
              gitFailure: checkoutErrors.join('') + CHECKOUT_FAILED,
              cleanup: true,
              elapsed: Date.now() - start,
              filesWritten,
              bytesWritten,
              supervisorRpc,
              metadataOverlay,
              phases,
            };
          }
          return {
            success: true,
            elapsed: Date.now() - start,
            filesWritten,
            bytesWritten,
            supervisorRpc,
            metadataOverlay,
            phases,
          };
        } catch (error) {
          if (error instanceof GitNetworkCancelled) {
            // Its facets' writes lose their authority before it answers (as a fence's, with no facet loaded):
            // what they wrote is its caller's to clean up, or not.
            rotateMutationOwner?.();
            return {
              success: false,
              error: error.message,
              cancelled: { reason: error.reason },
              cleanup: true,
              elapsed: Date.now() - start,
              filesWritten,
              bytesWritten,
              supervisorRpc,
              metadataOverlay,
              phases,
            };
          }
          const phaseError = error instanceof GitClonePhaseError
            ? error
            : new GitClonePhaseError(
                'clone-prepare',
                phaseErrorMessage(error),
                {
                  phase: 'clone-prepare',
                  invocationId: 'unavailable',
                  startedAt: start,
                  endedAt: Date.now(),
                  elapsed: Date.now() - start,
                  outcome: 'error',
                  error: phaseErrorMessage(error),
                  w7Waves: 0,
                  supervisorRpc: createSupervisorRpcCounters(),
                },
              );
          if (!phases.some(phase => phase.invocationId === phaseError.diagnostic.invocationId)) {
            phases.push(phaseError.diagnostic);
          }
          // What the clone wrote is its caller's to clean up (git/clone-job.ts),
          // once no piece of it can write: a prepare that failed before it wrote leaves nothing.
          const cleanup = !(phaseError.phase === 'clone-prepare' && phaseError.mutated === false);
          if (cleanup) facets.fence?.();

          return {
            success: false,
            error: phaseError.message,
            errorPhase: phaseError.phase,
            errorCode: phaseError instanceof GitCloneBudgetExceededError
              ? phaseError.code
              : phaseError.errorCode,
            gitFailure: phaseError.gitFailure,
            budget: phaseError instanceof GitCloneBudgetExceededError
              ? phaseError.budget
              : undefined,
            cleanup,
            elapsed: Date.now() - start,
            filesWritten,
            bytesWritten,
            supervisorRpc,
            metadataOverlay,
            phases,
          };
        }
      }

      if (opts.op === 'graph-filters') {
        // The whole pass in this one facet, a step an invocation.
        const facet = entrypoint;
        const graphFilters = await driveGraphFilters(async (step) => {
          const remaining = Math.min(GRAPH_FILTERS_STEP_TIMEOUT_MS, outerDeadline - Date.now());
          if (remaining <= 0) throw new Error(`git graph-filters timed out after ${timeoutMs / 1000}s`);
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`git graph-filters ${step.step} timed out after ${remaining / 1000}s`)), remaining);
          });
          const call = facet.fetch(new Request('http://git/op', {
            method: 'POST',
            body: JSON.stringify({ ...facetOpts, graphFilters: step, invocationId: crypto.randomUUID() }),
          })).then(async (response: Response) => {
            try {
              return await response.json() as FacetInvocationResult;
            } finally {
              disposeRpcResource(response);
            }
          });
          let result: FacetInvocationResult;
          try {
            result = await Promise.race([call, timeout]);
          } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          }
          if (result.success !== true) throw new Error(`graph-filters ${step.step}: ${typeof result.error === 'string' ? result.error : 'failed'}`);
          return result.graphFilters;
        }, { pieceCommits: opts.graphFilterPieceCommits, pieceBudgetMs: opts.graphFilterPieceBudgetMs });
        return {
          success: true,
          elapsed: Date.now() - start,
          filesWritten: 0,
          bytesWritten: 0,
          supervisorRpc: createSupervisorRpcCounters(),
          metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
          graphFilters,
        };
      }

      const invocationId = crypto.randomUUID();
      const startedAt = Date.now();
      const remaining = outerDeadline - startedAt;
      if (remaining <= 0) {
        throw new Error(`git ${opts.op} timed out after ${timeoutMs / 1000}s`);
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`git ${opts.op} timed out after ${timeoutMs / 1000}s`)),
          remaining,
        );
      });
      const call = entrypoint.fetch(new Request('http://git/op', {
        method: 'POST',
        body: JSON.stringify({ ...facetOpts, invocationId }),
        signal,
      })).then(async (response: Response) => {
        try {
          return await response.json() as FacetInvocationResult;
        } finally {
          disposeRpcResource(response);
        }
      });
      const stop = cancellation(signal);
      let result: FacetInvocationResult;
      try {
        result = await Promise.race([call, timeout, stop.stopped]);
      } catch (error) {
        if (!(error instanceof GitNetworkCancelled)) throw error;
        // A fetch, pull or push stopped: what its facet wrote stays, as git's interrupted fetch leaves its objects.
        return {
          success: false,
          error: error.message,
          cancelled: { reason: error.reason },
          elapsed: Date.now() - start,
          filesWritten: 0,
          bytesWritten: 0,
          supervisorRpc: createSupervisorRpcCounters(),
          metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
        };
      } finally {
        stop.off();
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
      const endedAt = Date.now();
      const diagnostic = parsePhaseDiagnostic(result.diagnostic, {
        phase: 'operation',
        invocationId,
        startedAt,
        endedAt,
        elapsed: endedAt - startedAt,
        outcome: result.success === true ? 'success' : 'error',
        error: typeof result.error === 'string' ? result.error : undefined,
      }, result);
      return {
        success: result.success === true,
        error: typeof result.error === 'string' ? result.error : undefined,
        errorPhase: result.success === true ? undefined : 'operation',
        elapsed: Date.now() - start,
        filesWritten: nonNegativeCounter(result.filesWritten),
        bytesWritten: nonNegativeCounter(result.bytesWritten),
        supervisorRpc: parseSupervisorRpcCounters(result.supervisorRpc),
        metadataOverlay: parseMetadataOverlayStats(result.metadataOverlay),
        phases: [diagnostic],
        fetchedObjects: result.fetched && typeof result.fetched === 'object' && 'fetched' in result.fetched
          ? nonNegativeCounter(result.fetched.fetched)
          : undefined,
        ...(result.graphFilters !== undefined ? { graphFilters: result.graphFilters } : {}),
      };
    } finally {
      // Tear down the facet's RPC stubs regardless of success / timeout.
      // `entrypoint` and `worker` are both cross-isolate stubs; disposing
      // them lets workerd reclaim the dynamic worker's memory eagerly.
      // `supervisorBinding` is the SupervisorRPC stub we minted above —
      // it's from ctxExports (local to the supervisor's own isolate) so
      // in theory it doesn't leak across isolates, but disposing is cheap
      // and symmetric with how the facet's env.SUPERVISOR is handled on
      // the other side.
      disposeRpcResource(entrypoint);
      disposeRpcResource(worker);
      disposeRpcResource(supervisorBinding);
      for (const load of fencedLoads) {
        disposeRpcResource(load.entrypoint);
        disposeRpcResource(load.worker);
        disposeRpcResource(load.binding);
        load.endFetch();
      }
      endFetch();
    }
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || String(e),
      ...(e instanceof GitNetworkCancelled ? { cancelled: { reason: e.reason } } : {}),
      elapsed: Date.now() - start,
      filesWritten: 0,
      bytesWritten: 0,
      supervisorRpc: createSupervisorRpcCounters(),
      metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
    };
  }
}

/**
 * The git network facet's module: the pack layer's bundle (pack/facet.ts),
 * whose network worker (pack/network-worker.ts) it exports.
 */
export function assembleGitNetworkFacetSource(): string {
  return GIT_PACK_NODE_IMPORTS + '\n' + GIT_PACK_SRC + '\nexport default __nimbusGitPack.networkWorker;\n';
}
