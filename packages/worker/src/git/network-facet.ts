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

import { getCtxExports } from '@nimbus-sh/fabric/composition.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform/limits.js';
import { fetchGitBundleSource } from '../runtime/git-bundle-artifact.js';
import { W7_FRAME_PREAMBLE } from '../loaders/generated-workers.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { GIT_WAVE_WRITER_SRC } from './wave-writer.generated.js';
import { GIT_PACK_NODE_IMPORTS, GIT_PACK_SRC } from './pack/facet.generated.js';
import type { CloneBatchResult, ClonePrepared } from './pack/clone.js';
import { COMMITS_PER_CHUNK, treeSlices, type HistoryKind, type HistoryStepResult, type StagedFile } from './pack/history.js';

export type GitNetworkOp = 'clone' | 'fetch' | 'pull' | 'push' | 'fetch-objects';

/**
 * The clone's job marker, in its git directory from prepare until the clone
 * is whole: the proof an abort needs that the destination is the clone's,
 * and what tells every other git command the repository is not yet one.
 */
export const GIT_CLONE_JOB_MARKER = 'nimbus-clone-job';

export interface GitNetworkOpts {
  op: GitNetworkOp;
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
  /** Clone-only: normalized root covered by the exclusive mutation lease. */
  exclusiveMutationRoot?: string;
  /** Trusted supervisor-only lease owner; never sent to the dynamic worker. */
  mutationOwner?: string;
  /** Clone-only bounded checkout entries per fresh facet invocation. */
  checkoutChunkMaxEntries?: number;
  /** Clone-only decoded blob bytes per fresh facet invocation. */
  checkoutChunkMaxDecodedBytes?: number;
  /** Clone-only coarse wall guard per checkout chunk; not a CPU limit. */
  checkoutChunkMaxWallMs?: number;
  /** fetch: `depth` counts from the current shallow boundary (git fetch --deepen). */
  relative?: boolean;
  /** `git clone --filter=<spec>`, normalized: a partial clone of a promisor remote. */
  filter?: string;
  /** Fast clone, full history: blobs per history request (tuning; history.ts by default). */
  historyBlobsPerBatch?: number;
  /** Fast clone, full history: root trees per history request (tuning; history.ts by default). */
  historyCommitsPerChunk?: number;
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

export interface GitSupervisorRpcCounters {
  stat: number;
  lstat: number;
  readdir: number;
  readFile: number;
  fsReadRange: number;
  /** Pack appends (and a thin pack's count rewrite): one per <=448 KiB piece. */
  fsWriteRange: number;
  rename: number;
  writeBatchStream: number;
  readlink: number;
  symlink: number;
  legacySymlinkSubtree: number;
  stdout: number;
}

export interface GitMetadataOverlayStats {
  entries: number;
  accountedBytes: number;
  maxEntries: number;
  maxAccountedBytes: number;
}

export type GitCloneInvocationPhase =
  | 'clone-prepare'
  | 'clone-batch'
  | 'clone-history'
  | 'clone-finish'
  | 'clone-checkout'
  | 'clone-abort';

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
  supervisorRpc: GitSupervisorRpcCounters;
  /** Whether clone-checkout started without module-local job state. */
  cold?: boolean;
  /** The invocation's wave writer: what it published and how long it waited. */
  waves?: GitWaveDiagnostic;
}

/** The facet's wave writer counters (git/wave-writer.ts WaveStats). */
export interface GitWaveDiagnostic {
  waves: number;
  files: number;
  bytes: number;
  rpcWallMs: number;
  maxRpcWallMs: number;
  producerWaitMs: number;
  ownershipVisits: number;
  maxWavePaths: number;
  maxWaveBytes: number;
}

const WAVE_DIAGNOSTIC_FIELDS = [
  'waves', 'files', 'bytes', 'rpcWallMs', 'maxRpcWallMs', 'producerWaitMs',
  'ownershipVisits', 'maxWavePaths', 'maxWaveBytes',
] as const;

function parseWaveDiagnostic(value: unknown): GitWaveDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed: GitWaveDiagnostic = {
    waves: 0, files: 0, bytes: 0, rpcWallMs: 0, maxRpcWallMs: 0, producerWaitMs: 0,
    ownershipVisits: 0, maxWavePaths: 0, maxWaveBytes: 0,
  };
  for (const field of WAVE_DIAGNOSTIC_FIELDS) {
    parsed[field] = nonNegativeCounter(Reflect.get(value, field));
  }
  return parsed;
}

export type GitNetworkErrorCode =
  | 'GitCloneBudgetExceeded'
  | 'FreshCheckoutDirectoryLimitError';

export interface GitNetworkResult {
  success: boolean;
  error?: string;
  elapsed: number;
  filesWritten: number;
  bytesWritten: number;
  supervisorRpc: GitSupervisorRpcCounters;
  metadataOverlay: GitMetadataOverlayStats;
  phases?: GitNetworkPhaseDiagnostic[];
  errorPhase?: GitCloneInvocationPhase | 'operation';
  errorCode?: GitNetworkErrorCode;
  budget?: GitCloneBudgetDiagnostic;
  cleanupError?: string;
  /** fetch-objects: objects the promisor pack holds. */
  fetchedObjects?: number;
}

export interface GitCloneBudgetDiagnostic {
  phase: GitCloneInvocationPhase;
  chunksCompleted: number;
  processedEntries: number;
  decodedBytes: number;
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
  nextCursor?: unknown;
  treeEntriesVisited?: unknown;
  decodedBytes?: unknown;
  indexEntries?: unknown;
  errorCode?: unknown;
  cold?: unknown;
  fetched?: unknown;
}

interface GitFacetEntrypoint {
  fetch(request: Request): Promise<Response>;
}

interface GitFacetWorker {
  getEntrypoint(): GitFacetEntrypoint;
}

interface GitHttpRequest {
  url: unknown;
  method?: string;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
  [key: string]: unknown;
}

interface GitHttpResponse {
  statusCode: number;
  body?: {
    cancel?: () => unknown;
  } | null;
  [key: string]: unknown;
}

interface GitHttp {
  request(req: GitHttpRequest): Promise<GitHttpResponse>;
}

interface GitHttpRetryOptions {
  maxAttempts?: number;
  backoffMs?: readonly number[];
}

const CLONE_PHASE_TIMEOUT_MS = 240_000;
const CLONE_ABORT_TIMEOUT_MS = 30_000;
const DEFAULT_CLONE_BUDGET_MS = 30 * 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_CHECKOUT_CHUNK_MAX_ENTRIES = 10_000;
const DEFAULT_CHECKOUT_CHUNK_MAX_DECODED_BYTES = 32 * 1024 * 1024;
const DEFAULT_CHECKOUT_CHUNK_MAX_WALL_MS = 150_000;

const EMPTY_SUPERVISOR_RPC_COUNTERS: GitSupervisorRpcCounters = {
  stat: 0,
  lstat: 0,
  readdir: 0,
  readFile: 0,
  fsReadRange: 0,
  fsWriteRange: 0,
  rename: 0,
  writeBatchStream: 0,
  readlink: 0,
  symlink: 0,
  legacySymlinkSubtree: 0,
  stdout: 0,
};

const EMPTY_METADATA_OVERLAY_STATS: GitMetadataOverlayStats = {
  entries: 0,
  accountedBytes: 0,
  maxEntries: 0,
  maxAccountedBytes: 0,
};

function nonNegativeCounter(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

interface GitCheckoutChunkBounds {
  maxEntries: number;
  maxDecodedBytes: number;
  maxWallMs: number;
}

interface GitCheckoutChunkProgress {
  nextCursor: Record<string, unknown> | null;
  treeEntriesVisited: number;
  decodedBytes: number;
  indexEntries: number;
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function checkoutChunkBounds(opts: GitNetworkOpts): GitCheckoutChunkBounds {
  return {
    maxEntries: positiveSafeInteger(
      opts.checkoutChunkMaxEntries,
      DEFAULT_CHECKOUT_CHUNK_MAX_ENTRIES,
      'checkoutChunkMaxEntries',
    ),
    maxDecodedBytes: positiveSafeInteger(
      opts.checkoutChunkMaxDecodedBytes,
      DEFAULT_CHECKOUT_CHUNK_MAX_DECODED_BYTES,
      'checkoutChunkMaxDecodedBytes',
    ),
    maxWallMs: positiveSafeInteger(
      opts.checkoutChunkMaxWallMs,
      DEFAULT_CHECKOUT_CHUNK_MAX_WALL_MS,
      'checkoutChunkMaxWallMs',
    ),
  };
}

function parseCheckoutChunkProgress(result: FacetInvocationResult): GitCheckoutChunkProgress {
  const nextCursor = result.nextCursor === null
    ? null
    : result.nextCursor && typeof result.nextCursor === 'object' &&
        !Array.isArray(result.nextCursor)
      ? result.nextCursor as Record<string, unknown>
      : undefined;
  if (nextCursor === undefined) {
    throw new Error('clone-checkout returned an invalid continuation cursor');
  }
  const treeEntriesVisited = nonNegativeCounter(result.treeEntriesVisited);
  if (nextCursor !== null && treeEntriesVisited === 0) {
    throw new Error('clone-checkout continuation made no progress');
  }
  return {
    nextCursor,
    treeEntriesVisited,
    decodedBytes: nonNegativeCounter(result.decodedBytes),
    indexEntries: nonNegativeCounter(result.indexEntries),
  };
}

function parseGitNetworkErrorCode(value: unknown): GitNetworkErrorCode | undefined {
  return value === 'GitCloneBudgetExceeded' ||
      value === 'FreshCheckoutDirectoryLimitError'
    ? value
    : undefined;
}

function parseSupervisorRpcCounters(value: unknown): GitSupervisorRpcCounters {
  const counters = value && typeof value === 'object'
    ? value as Partial<Record<keyof GitSupervisorRpcCounters, unknown>>
    : {};
  return {
    stat: nonNegativeCounter(counters.stat),
    lstat: nonNegativeCounter(counters.lstat),
    readdir: nonNegativeCounter(counters.readdir),
    readFile: nonNegativeCounter(counters.readFile),
    fsReadRange: nonNegativeCounter(counters.fsReadRange),
    fsWriteRange: nonNegativeCounter(counters.fsWriteRange),
    rename: nonNegativeCounter(counters.rename),
    writeBatchStream: nonNegativeCounter(counters.writeBatchStream),
    readlink: nonNegativeCounter(counters.readlink),
    symlink: nonNegativeCounter(counters.symlink),
    legacySymlinkSubtree: nonNegativeCounter(counters.legacySymlinkSubtree),
    stdout: nonNegativeCounter(counters.stdout),
  };
}

function parseMetadataOverlayStats(value: unknown): GitMetadataOverlayStats {
  const stats = value && typeof value === 'object'
    ? value as Partial<Record<keyof GitMetadataOverlayStats, unknown>>
    : {};
  return {
    entries: nonNegativeCounter(stats.entries),
    accountedBytes: nonNegativeCounter(stats.accountedBytes),
    maxEntries: nonNegativeCounter(stats.maxEntries),
    maxAccountedBytes: nonNegativeCounter(stats.maxAccountedBytes),
  };
}

function addSupervisorRpcCounters(
  total: GitSupervisorRpcCounters,
  value: unknown,
): void {
  const counters = parseSupervisorRpcCounters(value);
  for (const key of Object.keys(total) as (keyof GitSupervisorRpcCounters)[]) {
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
      diagnostic.phase === 'clone-checkout' ||
      diagnostic.phase === 'clone-abort' ||
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
    cold: typeof diagnostic.cold === 'boolean'
      ? diagnostic.cold
      : typeof result.cold === 'boolean'
        ? result.cold
        : undefined,
    waves: parseWaveDiagnostic(diagnostic.waves),
  };
}

class GitClonePhaseError extends Error {
  readonly phase: GitCloneInvocationPhase;
  readonly diagnostic: GitNetworkPhaseDiagnostic;
  readonly mutated: boolean | undefined;
  readonly errorCode: GitNetworkErrorCode | undefined;

  constructor(
    phase: GitCloneInvocationPhase,
    message: string,
    diagnostic: GitNetworkPhaseDiagnostic,
    errorCode?: GitNetworkErrorCode,
  ) {
    super(message);
    this.name = 'GitClonePhaseError';
    this.phase = phase;
    this.diagnostic = diagnostic;
    this.mutated = diagnostic.mutated;
    this.errorCode = errorCode;
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
      `git clone budget exhausted after ${budget.chunksCompleted} chunks / ` +
        `${budget.processedEntries} entries (elapsed=${budget.elapsedMs}ms ` +
        `limit=${budget.limitMs}ms decoded=${budget.decodedBytes}B)`,
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
  chunksCompleted: number;
  processedEntries: number;
  decodedBytes: number;
}

function cloneBudgetDiagnostic(
  phase: GitCloneInvocationPhase,
  context: GitCloneBudgetContext,
  now: number,
): GitCloneBudgetDiagnostic {
  return {
    phase,
    chunksCompleted: context.chunksCompleted,
    processedEntries: context.processedEntries,
    decodedBytes: context.decodedBytes,
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
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(immutable),
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
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
): Promise<{ result: FacetInvocationResult; diagnostic: GitNetworkPhaseDiagnostic }> {
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
      supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
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
          supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
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
    const response = await Promise.race([call, timeout]);
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
      supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
    };
    throw new GitClonePhaseError(phase, message, diagnostic);
  } finally {
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

async function writeCloneChunkProgress(
  supervisor: GitSupervisorStub,
  diagnostic: GitNetworkPhaseDiagnostic,
  chunk: number,
  progress: GitCheckoutChunkProgress,
): Promise<void> {
  try {
    const rpcCount = Object.values(diagnostic.supervisorRpc)
      .reduce((total, count) => total + count, 0);
    const result = await supervisor.stdout(GIT_PROGRESS_ENCODER.encode(
      `\n[git] clone-checkout chunk ${chunk} complete ` +
      `(entries=${progress.treeEntriesVisited} decoded=${progress.decodedBytes}B ` +
      `index=${progress.indexEntries} continuation=${progress.nextCursor === null ? 'done' : 'yes'} ` +
      `wall=${diagnostic.elapsed}ms w7=${diagnostic.w7Waves} rpc=${rpcCount} ` +
      `cold=${diagnostic.cold === true ? 'yes' : 'no'})\n`,
    ));
    disposeRpcResource(result);
  } catch {
    // Terminal progress is best-effort; the chunk result remains authoritative.
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

interface CloneBatchRun {
  outerDeadline: number;
  budgetContext: GitCloneBudgetContext;
  phases: GitNetworkPhaseDiagnostic[];
  accountResult(result: FacetInvocationResult): void;
  progress: GitSupervisorStub | null;
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
 * Attempts at a batch or history piece that failed in transit: its request
 * (UploadPackError), its writes to the session ("Network connection lost":
 * Linux depth 1, twice, the session itself healthy by GraphQL), or the
 * piece as a whole, hung (react's first batch, three times in five clones,
 * with no stall from its request). A piece writes the same files and a pack
 * under its own name each time, so a retry is the same piece again.
 */
const CLONE_PIECE_ATTEMPTS = 3;
/** A piece takes seconds (Linux's batches ~17 s, react's largest history piece 51 s): one hung this long is retried. */
const CLONE_PIECE_TIMEOUT_MS = 150_000;

function transientPieceFailure(diagnostic: GitNetworkPhaseDiagnostic, error: string): boolean {
  return diagnostic.outcome === 'timeout' ||
    error.startsWith('git upload-pack: ') ||
    error.includes('Network connection lost');
}

/** One fast-clone facet invocation after prepare; its failure is the clone's. */
async function invokeClonePhase(
  entrypoint: GitFacetEntrypoint,
  phase: 'clone-batch' | 'clone-history' | 'clone-finish',
  opts: Record<string, unknown>,
  run: CloneBatchRun,
): Promise<{ result: FacetInvocationResult; diagnostic: GitNetworkPhaseDiagnostic }> {
  let invocation!: { result: FacetInvocationResult; diagnostic: GitNetworkPhaseDiagnostic };
  for (let attempt = 1; attempt <= CLONE_PIECE_ATTEMPTS; attempt++) {
    try {
      invocation = await invokeFacet(
        entrypoint,
        phase,
        crypto.randomUUID(),
        { ...opts, attempt } as Omit<GitNetworkOpts, 'mutationOwner'>,
        run.outerDeadline,
        phase === 'clone-finish'
          ? CLONE_PHASE_TIMEOUT_MS
          : positiveSafeInteger(opts.pieceTimeoutMs, CLONE_PIECE_TIMEOUT_MS, 'piece timeout'),
        run.budgetContext,
      );
    } catch (error) {
      // A piece that hung (or whose facet call broke) throws rather than answers.
      if (!(error instanceof GitClonePhaseError) || error instanceof GitCloneBudgetExceededError ||
          phase === 'clone-finish' || attempt === CLONE_PIECE_ATTEMPTS ||
          !transientPieceFailure(error.diagnostic, error.message)) {
        throw error;
      }
      run.phases.push(error.diagnostic);
      if (run.progress) {
        await writeCloneProgressLine(run.progress, `\n[git] ${phase} attempt ${attempt} failed: ${error.message}\n`);
      }
      continue;
    }
    run.phases.push(invocation.diagnostic);
    run.accountResult(invocation.result);
    const error = typeof invocation.result.error === 'string' ? invocation.result.error : '';
    if (invocation.result.success === true || phase === 'clone-finish' || !transientPieceFailure(invocation.diagnostic, error)) break;
    if (run.progress) {
      await writeCloneProgressLine(run.progress, `\n[git] ${phase} attempt ${attempt} failed: ${error}\n`);
    }
  }
  if (invocation.result.success !== true) {
    throw new GitClonePhaseError(
      phase,
      typeof invocation.result.error === 'string' ? invocation.result.error : phase + ' failed',
      invocation.diagnostic,
    );
  }
  return invocation;
}

/** The fast clone after prepare: its blob batches, CLONE_BATCH_CONCURRENCY at a time. Returns the index shares. */
async function runCloneBatches(
  entrypoint: GitFacetEntrypoint,
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  fast: ClonePrepared,
  run: CloneBatchRun,
): Promise<{ name: string; bytes: number }[]> {
  const shares: { name: string; bytes: number }[] = [...fast.shares];
  let completed = 0;
  const concurrency = positiveSafeInteger(facetOpts.batchConcurrency, CLONE_BATCH_CONCURRENCY, 'batch concurrency');
  await runPool(fast.batches, concurrency, async (batch) => {
    const invocation = await invokeClonePhase(entrypoint, 'clone-batch', {
      ...facetOpts, ...identity, batch: { index: batch.index, bytes: batch.bytes }, capabilities: fast.capabilities, partial: fast.partial,
    }, run);
    const result = (invocation.result as { batch?: CloneBatchResult }).batch;
    if (result === undefined) throw new GitClonePhaseError('clone-batch', 'clone-batch returned no batch', invocation.diagnostic);
    shares.push({ name: 'index-' + result.index, bytes: result.indexBytes });
    completed++;
    run.budgetContext.processedEntries += result.files;
    if (run.progress) {
      await writeCloneProgressLine(run.progress,
        `\n[git] clone-batch ${completed}/${fast.batches.length} complete (blobs=${result.blobs} files=${result.files} ` +
        `pack=${(result.pack.packBytes / 1048576).toFixed(1)}MB wall=${invocation.diagnostic.elapsed}ms ` +
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

/** A full clone's history (git/pack/history.ts): commits, then trees, then blobs. */
async function runCloneHistory(
  entrypoint: GitFacetEntrypoint,
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  fast: ClonePrepared,
  run: CloneBatchRun,
): Promise<void> {
  const base = { ...facetOpts, ...identity, capabilities: fast.capabilities };
  let pieces = 0;
  let packBytes = 0;
  const invoke = async (history: Record<string, unknown>): Promise<{ step: HistoryStepResult; elapsed: number }> => {
    const invocation = await invokeClonePhase(entrypoint, 'clone-history', { ...base, history }, run);
    const step = (invocation.result as { history?: HistoryStepResult }).history;
    if (step === undefined) throw new GitClonePhaseError('clone-history', 'clone-history returned nothing', invocation.diagnostic);
    return { step, elapsed: invocation.diagnostic.elapsed };
  };
  /** A piece, and its continuations while its decoding runs past a budget. */
  const piece = async (kind: HistoryKind, name: string, request: Record<string, unknown>): Promise<StagedFile[]> => {
    let { step, elapsed } = await invoke({ step: 'piece', kind, piece: name, ...request });
    const lists = [...step.lists];
    for (let part = 1; step.pending !== null; part++) {
      ({ step, elapsed } = await invoke({ step: 'resume', kind, piece: name, part, pending: step.pending }));
      lists.push(...step.lists);
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
  const roots = await piece('commits', 'commits', { head: fast.commit });
  const blobLists: StagedFile[] = [];
  const commitsPerChunk = positiveSafeInteger(facetOpts.historyCommitsPerChunk, COMMITS_PER_CHUNK, 'history commits per chunk');
  await runPool(treeSlices(roots, commitsPerChunk), CLONE_HISTORY_CONCURRENCY, async (source, index) => {
    blobLists.push(...await piece('trees', 'trees-' + index, { source }));
  });
  const plan = await invokeClonePhase(entrypoint, 'clone-history', {
    ...base,
    history: { step: 'plan', lists: blobLists, present: fast.batches.map((batch) => ({ name: 'batch-' + batch.index, bytes: batch.bytes })) },
  }, run);
  const batches = (plan.result as { history?: { batches: StagedFile[] } }).history?.batches ?? [];
  await runPool(batches, CLONE_HISTORY_CONCURRENCY, async (source, index) => {
    await piece('blobs', 'blobs-' + index, { source });
  });
  if (run.progress) {
    await writeCloneProgressLine(run.progress,
      `\n[git] clone-history complete (${pieces} requests, ${(packBytes / 1048576).toFixed(1)}MB)\n`);
  }
}

/** The index from the shares; a full clone's shallow file goes; then the marker. */
async function runCloneFinish(
  entrypoint: GitFacetEntrypoint,
  facetOpts: Omit<GitNetworkOpts, 'mutationOwner'>,
  identity: { jobId: string; optionsHash: string },
  shares: { name: string; bytes: number }[],
  full: boolean,
  run: CloneBatchRun,
): Promise<void> {
  const finish = await invokeClonePhase(entrypoint, 'clone-finish', { ...facetOpts, ...identity, shares, full }, run);
  if (run.progress) await writeClonePhaseProgress(run.progress, finish.diagnostic);
}

async function writeCloneProgressLine(supervisor: GitSupervisorStub, line: string): Promise<void> {
  try {
    disposeRpcResource(await supervisor.stdout(GIT_PROGRESS_ENCODER.encode(line)));
  } catch {
    // Terminal progress is best-effort; the batch result remains authoritative.
  }
}

/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export async function execGitNetwork(
  ctx: DurableObjectState,
  env: any,
  opts: GitNetworkOpts,
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
        supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
        metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
      };
    }

    const { mutationOwner, ...facetOpts } = opts;
    const ctxExports = getCtxExports();
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC<GitSupervisorStub>({
          props: { ...supervisorBindingProps(ctx, opts.pid), mutationOwner },
        })
      : undefined;

    if (!supervisorBinding) {
      return {
        success: false,
        error: 'SupervisorRPC binding not available',
        elapsed: Date.now() - start,
        filesWritten: 0,
        bytesWritten: 0,
        supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
        metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
      };
    }

    let worker: GitFacetWorker | undefined;
    let entrypoint: GitFacetEntrypoint | undefined;
    // The unkeyed git worker is one distinct Dynamic Worker in flight on the
    // session's ledger from load to teardown — bracketed, never wrapped (see
    // beginLoaderFetch).
    const endFetch = beginLoaderFetch(ctx, `git-network:${crypto.randomUUID()}`);
    try {
      const gitBundleSource = await fetchGitBundleSource(env);
      const loadedWorker: GitFacetWorker = env.LOADER.load({
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
        env: { SUPERVISOR: supervisorBinding },
      });
      worker = loadedWorker;
      entrypoint = loadedWorker.getEntrypoint();
      if (opts.op === 'clone') {
        const jobId = crypto.randomUUID();
        const optionsHash = await hashCloneOptions(opts);
        const checkoutBounds = checkoutChunkBounds(opts);
        const phases: GitNetworkPhaseDiagnostic[] = [];
        const supervisorRpc = { ...EMPTY_SUPERVISOR_RPC_COUNTERS };
        let metadataOverlay = { ...EMPTY_METADATA_OVERLAY_STATS };
        let filesWritten = 0;
        let bytesWritten = 0;
        const budgetContext: GitCloneBudgetContext = {
          startedAt: start,
          limitMs: timeoutMs,
          chunksCompleted: 0,
          processedEntries: 0,
          decodedBytes: 0,
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
            );
          }
          if (!opts.quiet) await writeClonePhaseProgress(supervisorBinding, prepare.diagnostic);

          const fast = (prepare.result.prepared as { fast?: ClonePrepared }).fast;
          if (fast !== undefined) {
            const run: CloneBatchRun = {
              outerDeadline,
              budgetContext,
              phases,
              accountResult,
              progress: opts.quiet ? null : supervisorBinding,
            };
            const shares = await runCloneBatches(entrypoint, facetOpts, { jobId, optionsHash }, fast, run);
            const full = facetOpts.depth === undefined;
            if (full) await runCloneHistory(entrypoint, facetOpts, { jobId, optionsHash }, fast, run);
            await runCloneFinish(entrypoint, facetOpts, { jobId, optionsHash }, shares, full, run);
            return {
              success: true,
              elapsed: Date.now() - start,
              filesWritten,
              bytesWritten,
              supervisorRpc,
              metadataOverlay,
              phases,
            };
          }

          let checkoutCursor: Record<string, unknown> | null = null;
          let checkoutChunk = 0;
          do {
            checkoutChunk++;
            const checkout = await invokeFacet(
              entrypoint,
              'clone-checkout',
              crypto.randomUUID(),
              {
                ...facetOpts,
                jobId,
                optionsHash,
                prepared: prepare.result.prepared,
                checkoutCursor,
                checkoutBounds,
              },
              outerDeadline,
              CLONE_PHASE_TIMEOUT_MS,
              budgetContext,
            );
            phases.push(checkout.diagnostic);
            accountResult(checkout.result);
            if (checkout.result.success !== true) {
              throw new GitClonePhaseError(
                'clone-checkout',
                typeof checkout.result.error === 'string'
                  ? checkout.result.error
                  : 'clone-checkout failed',
                checkout.diagnostic,
                parseGitNetworkErrorCode(checkout.result.errorCode),
              );
            }
            let progress: GitCheckoutChunkProgress;
            try {
              progress = parseCheckoutChunkProgress(checkout.result);
            } catch (error) {
              throw new GitClonePhaseError(
                'clone-checkout',
                phaseErrorMessage(error),
                checkout.diagnostic,
              );
            }
            checkoutCursor = progress.nextCursor;
            budgetContext.chunksCompleted++;
            budgetContext.processedEntries += progress.treeEntriesVisited;
            budgetContext.decodedBytes += progress.decodedBytes;
            if (!opts.quiet) {
              await writeCloneChunkProgress(supervisorBinding, checkout.diagnostic, checkoutChunk, progress);
            }
          } while (checkoutCursor !== null);

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
                  supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                },
              );
          if (!phases.some(phase => phase.invocationId === phaseError.diagnostic.invocationId)) {
            phases.push(phaseError.diagnostic);
          }
          let cleanupError: string | undefined;
          const preMutationPrepareFailure = phaseError.phase === 'clone-prepare' &&
            phaseError.mutated === false;
          if (!preMutationPrepareFailure) {
            try {
              const abort = await invokeFacet(
                entrypoint,
                'clone-abort',
                crypto.randomUUID(),
                { ...facetOpts, jobId, optionsHash },
                Date.now() + CLONE_ABORT_TIMEOUT_MS,
                CLONE_ABORT_TIMEOUT_MS,
              );
              phases.push(abort.diagnostic);
              accountResult(abort.result);
              if (!opts.quiet) await writeClonePhaseProgress(supervisorBinding, abort.diagnostic);
              if (abort.result.success !== true) {
                cleanupError = typeof abort.result.error === 'string'
                  ? abort.result.error
                  : 'clone-abort failed';
              }
            } catch (abortError) {
              if (abortError instanceof GitClonePhaseError) {
                phases.push(abortError.diagnostic);
              }
              cleanupError = phaseErrorMessage(abortError);
            }
          }

          return {
            success: false,
            error: phaseError.message,
            errorPhase: phaseError.phase,
            errorCode: phaseError instanceof GitCloneBudgetExceededError
              ? phaseError.code
              : phaseError.errorCode,
            budget: phaseError instanceof GitCloneBudgetExceededError
              ? phaseError.budget
              : undefined,
            cleanupError,
            elapsed: Date.now() - start,
            filesWritten,
            bytesWritten,
            supervisorRpc,
            metadataOverlay,
            phases,
          };
        }
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
      endFetch();
    }
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || String(e),
      elapsed: Date.now() - start,
      filesWritten: 0,
      bytesWritten: 0,
      supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
      metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
    };
  }
}

export function createRetryingGitHttp(
  baseHttp: GitHttp,
  opts?: GitHttpRetryOptions,
): GitHttp {
  const transientStatuses = new Set([502, 503, 504, 522, 523, 524, 525]);
  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? 3));
  const backoffMs = opts?.backoffMs?.length ? opts.backoffMs : [400, 1200];

  const waitBeforeRetry = async (attempt: number): Promise<void> => {
    const baseMs = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
    const span = baseMs * 0.25;
    const delayMs = Math.max(0, Math.round(baseMs + (Math.random() * 2 - 1) * span));
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  };

  const collectBody = async (
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return chunks;
  };

  return {
    async request(req): Promise<GitHttpResponse> {
      const method = req.method ?? 'GET';
      const idempotent = method === 'GET' || String(req.url).includes('git-upload-pack');
      const body = idempotent && method !== 'GET' && req.body
        ? await collectBody(req.body)
        : undefined;
      const request = body ? { ...req, body } : req;
      let attempt = 0;

      while (true) {
        const lastAttempt = attempt + 1 >= maxAttempts;
        let response: GitHttpResponse;
        try {
          response = await baseHttp.request(request);
        } catch (error) {
          if (!idempotent || lastAttempt) throw error;
          await waitBeforeRetry(attempt);
          attempt++;
          continue;
        }

        if (!idempotent || !transientStatuses.has(response.statusCode) || lastAttempt) {
          return response;
        }
        try {
          if (response.body && typeof response.body.cancel === 'function') {
            await response.body.cancel();
          }
        } catch {}
        await waitBeforeRetry(attempt);
        attempt++;
      }
    },
  };
}

/**
 * Generate the dynamic worker code for the git network facet.
 *
 * Exports `default { async fetch(request, workerEnv) { ... } }`.
 * Reads op args from the POST body, runs isomorphic-git with a buffered
 * fs adapter, and flushes writes through W7 v3.
 */
export function assembleGitNetworkFacetSource(): string {
  return GIT_PACK_NODE_IMPORTS + '\n' + W7_FRAME_PREAMBLE + '\n' + GIT_WAVE_WRITER_SRC + '\n' + GIT_PACK_SRC + '\n' +
    generateGitNetworkFacetCode();
}

function generateGitNetworkFacetCode(): string {
  return `
// Must precede the .toString() embeds below, whose bodies call __name(...).
${ESBUILD_NAME_GLOBAL_SHIM}

const WHOLE_FILE_RPC_SAFE_BYTES = ${MAX_RPC_SAFE_PAYLOAD_BYTES};
const READ_RANGE_BYTES = 4 * 1024 * 1024;
const METADATA_MAX_ENTRIES = 100_000;
const METADATA_MAX_ACCOUNTED_BYTES = 32 * 1024 * 1024;
const METADATA_ENTRY_OVERHEAD_BYTES = 256;
const CHECKOUT_DIRECTORY_MAX_ENTRIES = 20_000;
const CHECKOUT_DIRECTORY_MAX_ACCOUNTED_BYTES = 4 * 1024 * 1024;
const CHECKOUT_INDEX_MAX_CHUNKS = 20_000;
const CLONE_JOB_MARKER = ${JSON.stringify(GIT_CLONE_JOB_MARKER)};
const cloneJobs = new Map();
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const protocolTextEncoder = new TextEncoder();

${createRetryingGitHttp.toString()}

function protocolError(message) {
  return new Error('git clone protocol: ' + message);
}

function requireProtocolString(value, label, maxLength = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw protocolError(label + ' is invalid');
  }
  return value;
}

function requireOid(value, label) {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) {
    throw protocolError(label + ' is invalid');
  }
  return value;
}

function requireMetadataNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError(label + ' is invalid');
  }
  return value;
}

function requirePositiveMetadataNumber(value, label) {
  const number = requireMetadataNumber(value, label);
  if (number === 0) throw protocolError(label + ' is invalid');
  return number;
}

function checkoutDirectoryLimitError(entries, accountedBytes) {
  const error = new Error(
    'git clone checkout directories exceeded their bound (' + entries + ' entries, ' +
    accountedBytes + ' accounted bytes)',
  );
  error.code = 'FreshCheckoutDirectoryLimitError';
  return error;
}

function validateCheckoutDirectories(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw protocolError('checkout directories are invalid');
  if (value.length > CHECKOUT_DIRECTORY_MAX_ENTRIES) {
    throw checkoutDirectoryLimitError(value.length, 0);
  }
  const directories = [];
  const seen = new Set();
  let accountedBytes = 0;
  for (const path of value) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 ||
        path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') ||
        seen.has(path)) {
      throw protocolError('checkout directory is invalid');
    }
    accountedBytes += protocolTextEncoder.encode(path).byteLength;
    if (accountedBytes > CHECKOUT_DIRECTORY_MAX_ACCOUNTED_BYTES) {
      throw checkoutDirectoryLimitError(value.length, accountedBytes);
    }
    seen.add(path);
    directories.push(path);
  }
  return directories;
}

function cloneJobMarkerPath(dir) {
  return normalizePath(dir) + '/.git/' + CLONE_JOB_MARKER;
}

function cloneMarkerPreparedIdentity(prepared) {
  return {
    commit: prepared.commit,
    tree: prepared.tree,
    headRef: prepared.headRef,
  };
}

function cloneJobMarker(opts, prepared = null, cursor = null, cursorSeq = 0) {
  if (prepared === null) {
    return JSON.stringify({ version: 1, jobId: opts.jobId, optionsHash: opts.optionsHash });
  }
  return JSON.stringify({
    version: 2,
    jobId: opts.jobId,
    optionsHash: opts.optionsHash,
    prepared: cloneMarkerPreparedIdentity(prepared),
    cursor,
    cursorSeq,
  });
}

function validateCloneMarkerCursor(value, tree) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || value.version !== 2 ||
      value.tree !== tree || !Array.isArray(value.stack) ||
      value.stack.length === 0 || value.stack.length > 4096 ||
      !Number.isSafeInteger(value.indexChunks) || value.indexChunks <= 0 ||
      value.indexChunks > CHECKOUT_INDEX_MAX_CHUNKS ||
      !Number.isSafeInteger(value.indexEntries) || value.indexEntries < 0) {
    throw protocolError('clone job marker cursor is invalid');
  }
  const stack = value.stack.map((frame, index) => {
    if (!frame || typeof frame !== 'object' || !OID_PATTERN.test(frame.treeOid) ||
        typeof frame.path !== 'string' || frame.path.length > 4096 ||
        (index === 0 ? frame.path !== '' : frame.path.length === 0) ||
        !Number.isSafeInteger(frame.nextChildIndex) || frame.nextChildIndex < 0) {
      throw protocolError('clone job marker cursor frame is invalid');
    }
    return {
      treeOid: frame.treeOid,
      path: frame.path,
      nextChildIndex: frame.nextChildIndex,
    };
  });
  if (stack[0].treeOid !== tree) {
    throw protocolError('clone job marker cursor root is invalid');
  }
  return {
    version: 2,
    tree,
    stack,
    directories: validateCheckoutDirectories(value.directories),
    indexChunks: value.indexChunks,
    indexEntries: value.indexEntries,
  };
}

function parseCloneJobMarker(raw, opts) {
  let marker;
  try { marker = JSON.parse(raw); }
  catch { return null; }
  if (!marker || marker.jobId !== opts.jobId || marker.optionsHash !== opts.optionsHash) {
    return null;
  }
  if (marker.version === 1) {
    return { version: 1, prepared: null, cursor: null, cursorSeq: 0 };
  }
  if (marker.version !== 2 || !marker.prepared || typeof marker.prepared !== 'object' ||
      !Number.isSafeInteger(marker.cursorSeq) || marker.cursorSeq < 0) {
    return null;
  }
  const emptyRepository = marker.prepared.commit === null && marker.prepared.tree === null;
  if (!emptyRepository &&
      (!OID_PATTERN.test(marker.prepared.commit) || !OID_PATTERN.test(marker.prepared.tree))) {
    return null;
  }
  if (marker.prepared.headRef !== null &&
      (typeof marker.prepared.headRef !== 'string' || marker.prepared.headRef.length === 0 ||
       marker.prepared.headRef.length > 4096)) {
    return null;
  }
  try {
    return {
      version: 2,
      prepared: cloneMarkerPreparedIdentity(marker.prepared),
      cursor: validateCloneMarkerCursor(marker.cursor, marker.prepared.tree),
      cursorSeq: marker.cursorSeq,
    };
  } catch {
    return null;
  }
}

/** Resolves { marker, raw } for an owned job, or null. raw carries the exact
 * durable bytes so a re-pin of identical content can skip the re-write. */
async function readCloneJobMarker(fs, opts) {
  let raw;
  try {
    raw = await fs.promises.readFile(cloneJobMarkerPath(opts.dir), { encoding: 'utf8' });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
  const marker = parseCloneJobMarker(raw, opts);
  return marker === null ? null : { marker, raw };
}

async function ownsCloneJob(fs, opts) {
  return await readCloneJobMarker(fs, opts) !== null;
}

function validateMetadataManifest(value, root) {
  if (!Array.isArray(value) || value.length > METADATA_MAX_ENTRIES) {
    throw protocolError('prepared metadata manifest is invalid');
  }
  const manifest = [];
  const seen = new Set();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 ||
        typeof item[0] !== 'string' || !item[1] || typeof item[1] !== 'object') {
      throw protocolError('prepared metadata entry is invalid');
    }
    const path = normalizePath(item[0]);
    if (path !== item[0] ||
        (path !== root && !path.startsWith(root + '/')) ||
        seen.has(path)) {
      throw protocolError('prepared metadata path is invalid');
    }
    seen.add(path);
    const raw = item[1];
    if (raw.kind !== 'dir' && raw.kind !== 'file' && raw.kind !== 'symlink') {
      throw protocolError('prepared metadata kind is invalid');
    }
    const entry = {
      kind: raw.kind,
      size: requireMetadataNumber(raw.size, 'prepared metadata size'),
      mode: requireMetadataNumber(raw.mode, 'prepared metadata mode'),
      mtimeMs: requireMetadataNumber(raw.mtimeMs, 'prepared metadata mtime'),
      ctimeMs: requireMetadataNumber(raw.ctimeMs, 'prepared metadata ctime'),
      atimeMs: requireMetadataNumber(raw.atimeMs, 'prepared metadata atime'),
    };
    if (raw.kind === 'symlink') {
      entry.target = requireProtocolString(raw.target, 'prepared symlink target', 64 * 1024);
    }
    manifest.push([path, entry]);
  }
  return manifest;
}

function validatePreparedClone(value, opts) {
  if (!value || typeof value !== 'object') throw protocolError('prepared result is missing');
  const root = normalizePath(opts.dir);
  const metadataRoot = normalizePath(opts.exclusiveMutationRoot || root);
  const emptyRepository = value.commit === null && value.tree === null;
  const prepared = {
    jobId: requireProtocolString(value.jobId, 'job id', 128),
    optionsHash: requireProtocolString(value.optionsHash, 'options hash', 128),
    dir: requireProtocolString(value.dir, 'prepared dir', 4096),
    commit: emptyRepository ? null : requireOid(value.commit, 'prepared commit'),
    tree: emptyRepository ? null : requireOid(value.tree, 'prepared tree'),
    headRef: value.headRef === null
      ? null
      : requireProtocolString(value.headRef, 'prepared HEAD ref', 4096),
    packOnlyObjectStore: value.packOnlyObjectStore === true,
    packs: value.packs,
    metadata: validateMetadataManifest(value.metadata, metadataRoot),
  };
  if (prepared.jobId !== opts.jobId ||
      prepared.optionsHash !== opts.optionsHash ||
      normalizePath(prepared.dir) !== root) {
    throw protocolError('prepared identity does not match checkout request');
  }
  if (!Array.isArray(prepared.packs) || prepared.packs.length > 32) {
    throw protocolError('prepared pack manifest is invalid');
  }
  prepared.packs = prepared.packs.map((pack) => {
    if (!pack || typeof pack !== 'object') throw protocolError('prepared pack is invalid');
    const packPath = requireProtocolString(pack.packPath, 'pack path', 4096);
    const idxPath = requireProtocolString(pack.idxPath, 'idx path', 4096);
    const packSha = requireOid(pack.packSha, 'pack sha');
    const packRoot = root + '/.git/objects/pack/';
    if (!packPath.startsWith(packRoot) || !idxPath.startsWith(packRoot) ||
        packPath !== packRoot + 'pack-' + packSha + '.pack' ||
        idxPath !== packRoot + 'pack-' + packSha + '.idx') {
      throw protocolError('prepared pack paths are invalid');
    }
    return {
      packPath,
      packBytes: requireMetadataNumber(pack.packBytes, 'pack bytes'),
      idxPath,
      idxBytes: requireMetadataNumber(pack.idxBytes, 'idx bytes'),
      packSha,
    };
  });
  const metadata = new Map(prepared.metadata);
  for (const pack of prepared.packs) {
    if (metadata.get(pack.packPath)?.size !== pack.packBytes ||
        metadata.get(pack.idxPath)?.size !== pack.idxBytes) {
      throw protocolError('prepared pack sizes do not match metadata');
    }
  }
  return prepared;
}

function disposeRpcResult(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === 'function') { try { dispose.call(value); } catch {} }
}

async function useRpcResult(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { disposeRpcResult(value); }
}

// normalizePath is provided by the W7 frame preamble (from _shared/w7-frame.ts),
// prepended to this facet worker — semantically identical, do not redeclare.

function parentOf(p) {
  return p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
}

// fs.promises.readFile takes its encoding bare as well as on an options
// object, and cf-git uses both spellings. Honouring only the object form
// hands text call sites raw bytes; see the supervisor-side adapter in
// ./commands.ts for what that silently cost .gitignore.
function wantsUtf8(options) {
  const encoding = typeof options === 'string' ? options : (options && options.encoding);
  return encoding === 'utf8' || encoding === 'utf-8';
}

function enoent(filepath) {
  const err = new Error('ENOENT: no such file or directory, ' + filepath);
  err.code = 'ENOENT'; err.errno = -2;
  return err;
}

function enotdir(filepath) {
  const err = new Error('ENOTDIR: not a directory, ' + filepath);
  err.code = 'ENOTDIR'; err.errno = -20;
  return err;
}

function eisdir(filepath) {
  const err = new Error('EISDIR: illegal operation on a directory, ' + filepath);
  err.code = 'EISDIR'; err.errno = -21;
  return err;
}

function enotempty(filepath) {
  const err = new Error('ENOTEMPTY: directory not empty, ' + filepath);
  err.code = 'ENOTEMPTY'; err.errno = -39;
  return err;
}

function einval(filepath) {
  const err = new Error('EINVAL: invalid argument, ' + filepath);
  err.code = 'EINVAL'; err.errno = -22;
  return err;
}

function eio(filepath, detail) {
  const err = new Error('EIO: failed to read ' + filepath + ': ' + detail);
  err.code = 'EIO'; err.errno = -5;
  return err;
}

function eloop(filepath) {
  const err = new Error('ELOOP: too many symbolic links encountered, ' + filepath);
  err.code = 'ELOOP'; err.errno = -40;
  return err;
}

function statObj(metadata, followSymlink) {
  const isLink = metadata.kind === 'symlink' && !followSymlink;
  const isDir = metadata.kind === 'dir';
  const isFile = metadata.kind === 'file' || (metadata.kind === 'symlink' && followSymlink);
  const mtimeMs = metadata.mtimeMs;
  const ctimeMs = metadata.ctimeMs;
  const atimeMs = metadata.atimeMs;
  return {
    isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => isLink,
    size: metadata.size,
    mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) | (metadata.mode & 0o7777),
    type: isLink ? 'symlink' : isDir ? 'dir' : 'file',
    mtimeMs, mtime: new Date(mtimeMs),
    ctimeMs, ctime: new Date(ctimeMs),
    atimeMs, atime: new Date(atimeMs),
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

function convertSupervisorStat(st) {
  if (!st) return null;
  const mtimeMs = Number(st.mtime) || Date.now();
  const ctimeMs = Number(st.ctime) || mtimeMs;
  const atimeMs = Number(st.atime) || mtimeMs;
  const isDir = st.type === 'directory' || st.type === 'dir';
  const isLink = st.type === 'symlink';
  return {
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,
    size: Number(st.size) || 0,
    mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) |
      ((Number(st.mode) || (isDir ? 0o755 : isLink ? 0o777 : 0o644)) & 0o7777),
    type: isDir ? 'dir' : isLink ? 'symlink' : 'file',
    mtimeMs, mtime: new Date(mtimeMs),
    ctimeMs, ctime: new Date(ctimeMs),
    atimeMs, atime: new Date(atimeMs),
    // The supervisor's git reports these same fields, so an index either side wrote stays warm.
    uid: Number(st.uid) || 0, gid: Number(st.gid) || 0,
    dev: Number(st.dev) || 0, ino: Number(st.ino) || 0, nlink: 1,
  };
}

function metadataFromSupervisorStat(st) {
  if (!st) return null;
  const converted = convertSupervisorStat(st);
  return {
    kind: converted.isDirectory() ? 'dir' : converted.isSymbolicLink() ? 'symlink' : 'file',
    size: converted.size,
    mode: converted.mode & 0o7777,
    mtimeMs: converted.mtimeMs,
    ctimeMs: converted.ctimeMs,
    atimeMs: converted.atimeMs,
  };
}

function createSupervisorRpcCounters() {
  return {
    stat: 0, lstat: 0, readdir: 0, readFile: 0,
    fsReadRange: 0, fsWriteRange: 0, rename: 0, writeBatchStream: 0, readlink: 0, symlink: 0,
    legacySymlinkSubtree: 0, stdout: 0,
  };
}

function emptyMetadataOverlayStats() {
  return {
    entries: 0,
    accountedBytes: 0,
    maxEntries: METADATA_MAX_ENTRIES,
    maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES,
  };
}

/** The supervisor's ranged calls, counted, as git/pack/facet-packs.ts takes them. */
function facetPacksSupervisor(supervisor, stats, ensureDirectory) {
  // Paths reach the supervisor as this facet's fs sends them: normalized.
  const counted = (name, call) => {
    stats.supervisorRpc[name]++;
    return useRpcResult(call(), (result) => result);
  };
  return {
    // Pack bytes bypass the session's content cache: a cached range pins its
    // chunks in the session's heap (512 x 64 KiB), which the clone shares.
    fsReadRange: (path, offset, length) => counted('fsReadRange', () => supervisor.fsReadRangeUncached(normalizePath(path), offset, length)),
    fsWriteRange: (path, offset, bytes) => counted('fsWriteRange', () => supervisor.fsWriteRange(normalizePath(path), offset, bytes)),
    fsTruncate: (path, size) => counted('fsWriteRange', () => supervisor.fsTruncate(normalizePath(path), size)),
    rename: (from, to) => counted('rename', () => supervisor.rename(normalizePath(from), normalizePath(to))),
    unlink: (path) => counted('rename', () => supervisor.unlink(normalizePath(path))),
    ensureDirectory,
    async size(path) {
      stats.supervisorRpc.stat++;
      const stat = await useRpcResult(supervisor.stat(normalizePath(path)), (result) => result);
      return stat && stat.type === 'file' ? stat.size : null;
    },
    async readdir(path) {
      stats.supervisorRpc.readdir++;
      try {
        const entries = await useRpcResult(supervisor.readdir(normalizePath(path)), (result) => result);
        return entries.map((entry) => typeof entry === 'string' ? entry : entry.name);
      } catch {
        return [];
      }
    },
  };
}

/**
 * What git/pack/clone.ts needs of this facet: the supervisor's ranged writes
 * (under the clone's lease, which the binding presents), and wave writers
 * rooted at the clone that report each published wave's receipts.
 */
function gitPackContext(supervisor, stats, opts, root, deadline, log, worktreeRoot = null) {
  const dir = normalizePath(opts.dir);
  const counted = (name, call) => {
    stats.supervisorRpc[name]++;
    return useRpcResult(call(), (result) => result);
  };
  return {
    supervisor: {
      fsWriteRange: (path, offset, bytes) => counted('fsWriteRange', () => supervisor.fsWriteRange(path, offset, bytes)),
      fsTruncate: (path, size) => counted('fsWriteRange', () => supervisor.fsTruncate(path, size)),
      fsReadRange: (path, offset, length) => counted('fsReadRange', () => supervisor.fsReadRangeUncached(path, offset, length)),
      rename: (from, to) => counted('rename', () => supervisor.rename(from, to)),
      async readdir(path) {
        stats.supervisorRpc.readdir++;
        try {
          const entries = await useRpcResult(supervisor.readdir(normalizePath(path)), (result) => result);
          return entries.map((entry) => typeof entry === 'string' ? entry : entry.name);
        } catch {
          return [];
        }
      },
    },
    writer(onReceipts) {
      return __nimbusGitWaveWriter.createWaveWriter({
        supervisor: {
          writeBatchStream(stream) {
            stats.supervisorRpc.writeBatchStream++;
            return supervisor.writeBatchStream(stream);
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
    },
    dir,
    url: opts.url,
    auth: opts.auth,
    marker: { path: '.git/' + CLONE_JOB_MARKER, text: cloneJobMarker(opts) },
    onProgress: (line) => log('remote: ' + line + '\\n'),
  };
}

/**
 * Create the buffered fs adapter isomorphic-git will use.
 * Writes buffer in-memory; reads check buffer then fall back to supervisor.
 *
 * Every write is a record for the wave writer (__nimbusGitWaveWriter, from
 * src/git/wave-writer.ts), which publishes them in W7 waves, one in flight
 * while the next buffers. The adapter keeps the closed-world metadata
 * overlay a clone reads back; the writer keeps the buffered bytes.
 *
 * With a worktreeRoot (fetch, pull, push in an existing repository) the
 * adapter writes that worktree the way git's checkout does (entry.c
 * create_directories, has_symlink_leading_path): below its top, .git
 * aside, a leading component that is not a real directory (a link, dangling
 * or not, or a file) is deleted and replaced by a directory rather than
 * followed, and a file replaces a link at its own path rather than writing
 * through it.
 */
function createBufferedFs(
  supervisor,
  stats,
  authoritativeRoot,
  authoritativeRootMetadata,
  initialMetadata = [],
  initialDirectories = [],
  phaseDeadline = null,
  authoritativeFallbackPaths = [],
  authoritativeFallbackRoots = [],
  worktreeRoot = null,
) {
  const metadata = new Map();
  const children = new Map();
  const textEncoder = new TextEncoder();
  let metadataAccountedBytes = 0;
  let overlayFailure = null;
  let mutationQueue = Promise.resolve();
  const fallbackPaths = new Set(authoritativeFallbackPaths.map(normalizePath));
  const fallbackRoots = authoritativeFallbackRoots.map(normalizePath);

  function stampEntry(entry, mtimeMs) {
    entry.atimeMs = mtimeMs;
    entry.mtimeMs = mtimeMs;
    entry.ctimeMs = mtimeMs;
  }

  // Each record carries its overlay metadata (fetch and pull have no other
  // record of a buffered file); a cut stamps the wave's mtime on it, so the
  // overlay's stat agrees with what the wave publishes.
  const writer = __nimbusGitWaveWriter.createWaveWriter({
    supervisor: {
      writeBatchStream(stream) {
        stats.supervisorRpc.writeBatchStream++;
        return supervisor.writeBatchStream(stream);
      },
    },
    root: authoritativeRoot,
    worktreeRoot,
    deadline: phaseDeadline,
    directoryMode(path) {
      const entry = metadata.get(path);
      return entry && entry.kind === 'dir' ? entry.mode : undefined;
    },
    onCut(cut) {
      for (const dir of cut.directories) {
        const entry = metadata.get(dir);
        if (entry && entry.kind === 'dir') stampEntry(entry, cut.mtimeMs);
      }
      for (const file of cut.files) {
        const entry = file.meta || metadata.get(file.path);
        if (entry && (entry.kind === 'file' || entry.kind === 'symlink')) stampEntry(entry, cut.mtimeMs);
      }
    },
    onWave(report) {
      stats.filesWritten += report.files;
      stats.bytesWritten += report.bytes;
    },
  });

  function assertFlushHealthy() {
    if (overlayFailure) throw overlayFailure;
    writer.assertHealthy();
  }

  async function awaitPendingFlush() {
    await writer.settled();
    assertFlushHealthy();
  }

  // No read reports a link, or resolves through one, before the link is
  // durable: a read waits out every link written and not yet published.
  async function awaitPublishedSymlinks() {
    if (writer.hasUnpublishedSymlinks) await flushWave();
  }

  // A read the overlay cannot answer goes to the supervisor, which must
  // already hold every write the adapter has made.
  async function awaitSupervisorReadable() {
    await awaitPublishedSymlinks();
    await awaitPendingFlush();
  }

  async function flushWave() {
    if (overlayFailure) throw overlayFailure;
    await writer.flush();
  }

  function isAuthoritativePath(path) {
    return authoritativeRoot !== null &&
      (path === authoritativeRoot || path.startsWith(authoritativeRoot + '/'));
  }

  function canFallThrough(path) {
    return fallbackPaths.has(path) || fallbackRoots.some(root =>
      path === root || path.startsWith(root + '/'));
  }

  function metadataCost(path, entry) {
    const targetBytes = entry.kind === 'symlink'
      ? textEncoder.encode(entry.target).byteLength
      : 0;
    return METADATA_ENTRY_OVERHEAD_BYTES + textEncoder.encode(path).byteLength + targetBytes;
  }

  function addChild(path) {
    const parent = parentOf(path);
    let names = children.get(parent);
    if (!names) children.set(parent, names = new Set());
    const name = path.slice(parent ? parent.length + 1 : 0);
    if (name) names.add(name);
  }

  function removeChild(path) {
    const parent = parentOf(path);
    const names = children.get(parent);
    if (!names) return;
    const name = path.slice(parent ? parent.length + 1 : 0);
    names.delete(name);
    if (names.size === 0) children.delete(parent);
  }

  function setMetadata(path, entry) {
    if (!isAuthoritativePath(path)) return;
    const previous = metadata.get(path);
    const previousCost = previous ? metadataCost(path, previous) : 0;
    const nextCost = metadataCost(path, entry);
    const nextEntries = metadata.size + (previous ? 0 : 1);
    const nextBytes = metadataAccountedBytes - previousCost + nextCost;
    if (nextEntries > METADATA_MAX_ENTRIES || nextBytes > METADATA_MAX_ACCOUNTED_BYTES) {
      const error = new Error(
        'git clone metadata overlay exceeded its bound (' + nextEntries + ' entries, ' +
        nextBytes + ' accounted bytes)',
      );
      overlayFailure = error;
      throw error;
    }
    metadata.set(path, entry);
    metadataAccountedBytes = nextBytes;
    if (!previous) addChild(path);
    if (entry.kind === 'dir' && !children.has(path)) children.set(path, new Set());
  }

  function removeMetadata(path, recursive) {
    if (!isAuthoritativePath(path)) return;
    const paths = [path];
    if (recursive) {
      for (let index = 0; index < paths.length; index++) {
        const parent = paths[index];
        for (const name of children.get(parent) || []) {
          paths.push(parent + '/' + name);
        }
      }
    }
    paths.sort((left, right) => right.length - left.length);
    for (const candidate of paths) {
      const previous = metadata.get(candidate);
      if (!previous) continue;
      metadataAccountedBytes -= metadataCost(candidate, previous);
      metadata.delete(candidate);
      children.delete(candidate);
      removeChild(candidate);
    }
  }

  function ensureMetadataParents(path, timestamp) {
    if (!isAuthoritativePath(path)) return;
    let parent = parentOf(path);
    while (isAuthoritativePath(parent)) {
      if (!metadata.has(parent)) {
        setMetadata(parent, {
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: timestamp, ctimeMs: timestamp, atimeMs: timestamp,
        });
      }
      if (parent === authoritativeRoot) break;
      parent = parentOf(parent);
    }
  }

  function recordDirectory(path) {
    if (!isAuthoritativePath(path)) return;
    const existing = metadata.get(path);
    if (existing && existing.kind === 'dir') return;
    const now = Date.now();
    ensureMetadataParents(path, now);
    setMetadata(path, {
      kind: 'dir', size: 0, mode: 0o755,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    });
  }

  function resolveMetadataPath(path, followFinal = true) {
    const seen = new Set();
    let current = normalizePath(path);
    for (let depth = 0; depth < 40; depth++) {
      const parts = current.split('/').filter(Boolean);
      let prefix = '';
      let followed = false;
      for (let index = 0; index < parts.length; index++) {
        prefix = prefix ? prefix + '/' + parts[index] : parts[index];
        const entry = metadata.get(prefix);
        if (!entry) continue;
        const isFinal = index === parts.length - 1;
        if (entry.kind === 'symlink' && (followFinal || !isFinal)) {
          if (seen.has(prefix)) throw eloop(path);
          seen.add(prefix);
          const target = entry.target.startsWith('/')
            ? normalizePath(entry.target)
            : normalizePath(parentOf(prefix) + '/' + entry.target);
          const remainder = parts.slice(index + 1).join('/');
          current = remainder ? normalizePath(target + '/' + remainder) : target;
          followed = true;
          break;
        }
        if (!isFinal && entry.kind !== 'dir') throw enotdir(path);
      }
      if (!followed) return { path: current, entry: metadata.get(current) };
    }
    throw eloop(path);
  }

  function overlayStats() {
    return {
      entries: metadata.size,
      accountedBytes: metadataAccountedBytes,
      maxEntries: METADATA_MAX_ENTRIES,
      maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES,
    };
  }

  function metadataSnapshot() {
    return [...metadata].map(([path, entry]) => [path, { ...entry }]);
  }

  if (authoritativeRoot !== null && authoritativeRootMetadata) {
    setMetadata(authoritativeRoot, authoritativeRootMetadata);
  }
  for (const [path, entry] of initialMetadata) setMetadata(path, entry);
  for (const path of initialDirectories) recordDirectory(path);

  // alreadyDurable records that these exact bytes are known to be durably
  // published at path (the caller read them back), so waves can assert the
  // pin's presence without ever re-writing unchanged content.
  function pinFile(path, data, alreadyDurable = false) {
    writer.setPin(normalizePath(path), data, alreadyDurable);
  }

  function unpinFile(path) {
    writer.clearPin(normalizePath(path));
  }

  // Mutations apply in call order: each waits for the one before it, and the
  // writer admits its record (cutting a wave first when it would not fit).
  function bufferMutation(mutate) {
    const operation = mutationQueue.then(async () => {
      assertFlushHealthy();
      return mutate();
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // A file the writer holds, or a stat of one, for a path no wave has published.
  function bufferedStat(path, followSymlink) {
    const buffered = writer.bufferedRecord(path);
    if (!buffered) return null;
    const now = Date.now();
    return statObj(buffered.meta || {
      kind: buffered.kind, size: buffered.size, mode: 0o644,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    }, followSymlink);
  }

  function bufferedDirectoryStat(followSymlink) {
    const now = Date.now();
    return statObj({
      kind: 'dir', size: 0, mode: 0o755,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    }, followSymlink);
  }

  function readBuffered(path, opts) {
    const data = writer.buffered(path);
    if (data === undefined) return undefined;
    return wantsUtf8(opts) ? new TextDecoder().decode(data) : data;
  }

  const fs = {
    promises: {
      async readFile(filepath, opts) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        // Check buffer first (insertion order preserves what git wrote)
        const buffered = readBuffered(p, opts);
        if (buffered !== undefined) return buffered;
        if (writer.isBufferedDelete(p)) throw enoent(filepath);
        const resolved = resolveMetadataPath(p);
        const durablePath = resolved.path;
        if (durablePath !== p) {
          const target = readBuffered(durablePath, opts);
          if (target !== undefined) return target;
        }
        if (resolved.entry && resolved.entry.kind === 'dir') throw enoent(filepath);
        if (!resolved.entry && isAuthoritativePath(durablePath) &&
            !canFallThrough(durablePath)) throw enoent(filepath);

        // Fall through to the supervisor. Ordinary RPC values have a 32 MiB
        // structured-clone ceiling, so reconstruct larger files through the
        // existing bounded range RPC instead of sending one oversized value.
        // This is intentionally size-based rather than pack-path-specific: it
        // preserves the fs.readFile contract for every large binary file.
        await awaitSupervisorReadable();
        let size = resolved.entry && resolved.entry.kind === 'file'
          ? resolved.entry.size
          : null;
        if (size === null) {
          stats.supervisorRpc.stat++;
          size = await useRpcResult(
            supervisor.stat(durablePath),
            (result) => result === null || result === undefined ? null : Number(result.size),
          );
        }
        if (size === null) throw enoent(filepath);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw eio(filepath, 'invalid file size ' + String(size));
        }

        let data;
        if (size > WHOLE_FILE_RPC_SAFE_BYTES) {
          data = new Uint8Array(size);
          for (let offset = 0; offset < size;) {
            const expected = Math.min(READ_RANGE_BYTES, size - offset);
            stats.supervisorRpc.fsReadRange++;
            const bytesRead = await useRpcResult(
              supervisor.fsReadRange(durablePath, offset, expected),
              (result) => {
                if (result === null || result === undefined) {
                  throw eio(filepath, 'range ' + offset + '..' + (offset + expected) + ' is missing');
                }
                const chunk = result instanceof Uint8Array ? result : new Uint8Array(result);
                if (chunk.byteLength !== expected) {
                  throw eio(
                    filepath,
                    'range ' + offset + '..' + (offset + expected) +
                      ' returned ' + chunk.byteLength + ' bytes',
                  );
                }
                data.set(chunk, offset);
                return chunk.byteLength;
              },
            );
            offset += bytesRead;
          }
        } else {
          stats.supervisorRpc.readFile++;
          data = await useRpcResult(supervisor.readFileBytes(durablePath), (result) => {
            if (result === null || result === undefined) throw enoent(filepath);
            const content = result instanceof Uint8Array ? result : new Uint8Array(result);
            return content.slice();
          });
        }
        if (wantsUtf8(opts)) return new TextDecoder().decode(data);
        return data;
      },

      async writeFile(filepath, data, opts) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        // Every buffered record owns its ArrayBuffer: the W7 stream transfers
        // what it enqueues, and isomorphic-git hands writeFile subarray views
        // of a pack-sized parent, and pako's pooled output as whole views of
        // a shared buffer (both detached a later wave in production). So the
        // bytes are copied here, once, unconditionally.
        let buf;
        if (typeof data === 'string') {
          buf = new TextEncoder().encode(data); // fresh ArrayBuffer
        } else {
          const src = data instanceof Uint8Array ? data : new Uint8Array(data);
          buf = new Uint8Array(src.length);
          buf.set(src);
        }
        return bufferMutation(async () => {
          const now = Date.now();
          ensureMetadataParents(p, now);
          const mode = opts && (Number(opts.mode) & 0o111) ? 0o755 : 0o644;
          const fileMetadata = {
            kind: 'file', size: buf.length, mode,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          };
          setMetadata(p, fileMetadata);
          await writer.file(p, mode, buf, fileMetadata);
        });
      },

      // unlink(2) and rmdir(2): a buffered delete removes the whole subtree at
      // its path, so neither may take a directory it would not take on disk.
      // unlink refuses a directory; rmdir refuses a non-directory and a
      // directory that still holds anything (untracked files a checkout leaves).
      async unlink(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if ((await fs.promises.lstat(filepath)).isDirectory()) throw eisdir(filepath);
        return bufferMutation(async () => {
          removeMetadata(p, false);
          await writer.remove(p);
        });
      },

      async readdir(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p);
        const local = resolved.entry;
        if (local || isAuthoritativePath(resolved.path)) {
          if (!local) throw enoent(filepath);
          if (local.kind !== 'dir') throw enotdir(filepath);
          return [...(children.get(resolved.path) || [])];
        }
        await awaitSupervisorReadable();
        // Start with supervisor's view
        let names = [];
        stats.supervisorRpc.readdir++;
        const entries = await useRpcResult(supervisor.readdir(resolved.path), (result) => result);
        names = Array.isArray(entries) ? entries.map(e => e.name) : [];
        const set = new Set(names);
        // Add buffered children: anything whose parent == p
        const prefix = resolved.path ? resolved.path + '/' : '';
        const buffered = writer.bufferedPaths();
        for (const paths of [buffered.files, buffered.directories]) {
          for (const bp of paths) {
            if (!bp.startsWith(prefix)) continue;
            const rest = bp.slice(prefix.length);
            if (!rest) continue;
            const firstSeg = rest.split('/')[0];
            if (firstSeg) set.add(firstSeg);
          }
        }
        // Remove deleted
        for (const dp of buffered.deletes) {
          if (!dp.startsWith(prefix)) continue;
          const rest = dp.slice(prefix.length);
          if (rest.indexOf('/') < 0) set.delete(rest);
        }
        return [...set];
      },

      async mkdir(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if (!p) return;
        return bufferMutation(async () => {
          recordDirectory(p);
          await writer.directory(p);
        });
      },

      async rmdir(filepath, options) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if (!(options && options.recursive)) {
          if (!(await fs.promises.lstat(filepath)).isDirectory()) throw enotdir(filepath);
          if ((await fs.promises.readdir(filepath)).length > 0) throw enotempty(filepath);
        }
        return bufferMutation(async () => {
          removeMetadata(p, true);
          await writer.remove(p, true);
        });
      },

      async rm(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        return bufferMutation(async () => {
          removeMetadata(p, true);
          await writer.remove(p, true);
        });
      },

      async stat(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p);
        if (resolved.entry) return statObj(resolved.entry, true);
        if (isAuthoritativePath(resolved.path) && !canFallThrough(resolved.path)) {
          throw enoent(filepath);
        }
        const buffered = bufferedStat(p, true);
        if (buffered) return buffered;
        if (writer.isBufferedDirectory(p)) return bufferedDirectoryStat(true);
        if (writer.isBufferedDelete(p)) throw enoent(filepath);
        if (!p) return bufferedDirectoryStat(true);
        await awaitSupervisorReadable();
        stats.supervisorRpc.stat++;
        const st = await useRpcResult(supervisor.stat(resolved.path), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async lstat(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p, false);
        const local = resolved.entry;
        if (local) return statObj(local, false);
        if (isAuthoritativePath(resolved.path) && !canFallThrough(resolved.path)) {
          throw enoent(filepath);
        }
        const buffered = bufferedStat(resolved.path, false);
        if (buffered) return buffered;
        if (writer.isBufferedDirectory(resolved.path)) return bufferedDirectoryStat(false);
        if (writer.isBufferedDelete(resolved.path)) throw enoent(filepath);
        if (!resolved.path) return bufferedDirectoryStat(false);
        await awaitSupervisorReadable();
        stats.supervisorRpc.lstat++;
        const st = await useRpcResult(supervisor.lstat(resolved.path), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async chmod() { /* no-op */ },
      async symlink(target, filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        const value = String(target);
        return bufferMutation(async () => {
          const now = Date.now();
          ensureMetadataParents(p, now);
          const linkMetadata = {
            kind: 'symlink', target: value,
            size: textEncoder.encode(value).byteLength,
            mode: 0o777,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          };
          setMetadata(p, linkMetadata);
          await writer.symlink(p, value, linkMetadata);
        });
      },
      async readlink(filepath) {
        assertFlushHealthy();
        await awaitPublishedSymlinks();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p, false);
        const local = resolved.entry;
        if (local && local.kind === 'symlink') return local.target;
        if (local) throw einval(filepath);
        if (isAuthoritativePath(resolved.path)) throw enoent(filepath);
        await awaitSupervisorReadable();
        stats.supervisorRpc.readlink++;
        return useRpcResult(supervisor.readlink(resolved.path), result => {
          if (result === null || result === undefined) throw enoent(filepath);
          return String(result);
        });
      },
    },
  };

  return {
    fs,
    flushWave,
    overlayStats,
    metadataSnapshot,
    pinFile,
    unpinFile,
    waveStats: () => writer.stats(),
  };
}

function preparedPackManifest(metadata, cloneRoot) {
  const files = new Map(
    metadata
      .filter(([, entry]) => entry.kind === 'file')
      .map(([path, entry]) => [path, entry]),
  );
  const packRoot = cloneRoot + '/.git/objects/pack/';
  const packs = [];
  for (const [packPath, packEntry] of files) {
    if (!packPath.startsWith(packRoot) || !packPath.endsWith('.pack')) continue;
    const filename = packPath.slice(packRoot.length);
    const match = /^pack-([0-9a-f]{40}(?:[0-9a-f]{24})?)\\.pack$/.exec(filename);
    if (!match) throw protocolError('persisted pack path is invalid');
    const idxPath = packPath.slice(0, -5) + '.idx';
    const idxEntry = files.get(idxPath);
    if (!idxEntry) throw protocolError('persisted pack is missing its index');
    packs.push({
      packPath,
      packBytes: packEntry.size,
      idxPath,
      idxBytes: idxEntry.size,
      packSha: match[1],
    });
  }
  packs.sort((left, right) => left.packPath.localeCompare(right.packPath));
  return packs;
}

function isPackOnlyObjectStore(metadata, cloneRoot) {
  const objectRoot = cloneRoot + '/.git/objects/';
  const packRoot = objectRoot + 'pack/';
  return metadata.every(([path, entry]) =>
    entry.kind !== 'file' ||
    !path.startsWith(objectRoot) ||
    path.startsWith(packRoot));
}

export default {
  async fetch(request, workerEnv) {
    const supervisor = workerEnv && workerEnv.SUPERVISOR;
    if (!supervisor) {
      return Response.json({
        success: false, error: 'SUPERVISOR binding missing in facet env',
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 500 });
    }

    let opts;
    try {
      opts = await request.json();
    } catch (e) {
      return Response.json({
        success: false, error: 'Invalid request body: ' + (e && e.message),
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 400 });
    }

    const phase = opts.phase === 'clone-prepare' ||
        opts.phase === 'clone-batch' ||
        opts.phase === 'clone-history' ||
        opts.phase === 'clone-finish' ||
        opts.phase === 'clone-checkout' ||
        opts.phase === 'clone-abort'
      ? opts.phase
      : 'operation';
    const invocationId = typeof opts.invocationId === 'string'
      ? opts.invocationId
      : 'unavailable';
    const startedAt = Date.now();
    const startedMonotonic = performance.now();
    const stats = {
      filesWritten: 0,
      bytesWritten: 0,
      supervisorRpc: createSupervisorRpcCounters(),
    };
    let mutated = false;
    let cold = false;
    let lastProgress = null;
    const respond = (success, payload = {}, status = 200) => {
      const endedAt = Date.now();
      const error = !success && typeof payload.error === 'string'
        ? payload.error
        : undefined;
      return Response.json({
        success,
        ...payload,
        mutated,
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
        supervisorRpc: stats.supervisorRpc,
        cold: phase === 'clone-checkout' ? cold : undefined,
        diagnostic: {
          phase,
          invocationId,
          startedAt,
          endedAt,
          elapsed: Math.max(0, Math.round(performance.now() - startedMonotonic)),
          outcome: success ? 'success' : 'error',
          mutated,
          error,
          lastProgress,
          w7Waves: stats.supervisorRpc.writeBatchStream,
          supervisorRpc: stats.supervisorRpc,
          cold: phase === 'clone-checkout' ? cold : undefined,
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
    const log = (msg) => {
      if (opts.quiet) return;
      stats.supervisorRpc.stdout++;
      try { useRpcResult(supervisor.stdout(new TextEncoder().encode(msg)), () => undefined).catch(() => {}); } catch {}
    };

    // Import the pre-bundled isomorphic-git + http/web.
    // The bundle is provided via LOADER.load()'s modules record;
    // see scripts/bundle-git.mjs and src/runtime/git-bundle-artifact.ts.
    let git, http;
    try {
      const bundle = await import('./git-bundle.js');
      git = bundle.git;
      // http/web has both { request } named and { default: { request } };
      // the namespace bundle.gitHttp exposes request directly, which is
      // what isomorphic-git looks for.
      http = createRetryingGitHttp(bundle.gitHttp);
    } catch (e) {
      return respond(false, {
        error: 'Failed to load bundled isomorphic-git: ' + (e && e.message),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, 500);
    }

    // Keep progress bounded: phase transitions/completions, plus one timed
    // update every two seconds.
    // isomorphic-git fires this callback per packfile object — thousands
    // of times for a medium repo. Each call does supervisor.stdout(...),
    // a facet→supervisor RPC that consumes input-gate time on the
    // supervisor DO and serialises behind other in-flight async work
    // (including shell keystrokes). Also emit unconditionally on phase
    // completion (loaded === total) so users still see the final frame
    // and any phase transition.
    let lastLogAt = 0;
    let lastLoggedPhase = '';
    const onProgress = async (e) => {
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
      log('\\r[git] ' + e.phase + ' ' + (e.loaded || 0) + '/' + (e.total || '?'));
    };
    const onAuth = () => opts.auth || { username: '', password: '' };

    let flushWave = async () => {};
    let overlayStats = emptyMetadataOverlayStats;
    let waveStats = () => undefined;
    try {
      if (typeof opts.dir !== 'string') throw new Error('git ' + opts.op + ': dir required');
      let authoritativeRoot = null;
      let authoritativeRootMetadata = null;
      let initialMetadata = [];
      let initialDirectories = [];
      let prepared = null;
      let checkoutResult = null;
      const phaseDeadline = phase === 'operation'
        ? null
        : requireMetadataNumber(opts.phaseDeadline, 'phase deadline');
      if (phase === 'clone-batch' || phase === 'clone-history' || phase === 'clone-finish') {
        if (opts.op !== 'clone') throw protocolError(phase + ' requires clone operation');
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
        if (opts.exclusiveDestination !== true) throw protocolError(phase + ' requires an exclusive destination');
        const root = normalizePath(opts.exclusiveMutationRoot || opts.dir);
        const context = gitPackContext(supervisor, stats, opts, root, phaseDeadline, log);
        mutated = true;
        if (phase === 'clone-batch') {
          const batch = await __nimbusGitPack.cloneBatch(context, {
            jobId: opts.jobId + (opts.attempt > 1 ? '_' + opts.attempt : ''),
            index: requireMetadataNumber(opts.batch && opts.batch.index, 'batch index'),
            batchBytes: requirePositiveMetadataNumber(opts.batch && opts.batch.bytes, 'batch bytes'),
            capabilities: opts.capabilities,
            partial: opts.partial === true,
          });
          return respond(true, { batch, metadataOverlay: emptyMetadataOverlayStats() });
        }
        if (phase === 'clone-history') {
          const history = opts.history || {};
          let step;
          if (history.step === 'plan') {
            step = await __nimbusGitPack.historyPlan(context, {
              lists: history.lists,
              present: history.present,
              blobsPerBatch: opts.historyBlobsPerBatch,
            });
          } else if (history.step === 'resume') {
            step = await __nimbusGitPack.historyResume(context, { ...history, budgetUnits: opts.historyBudgetUnits });
          } else {
            step = await __nimbusGitPack.historyStep(context, {
              jobId: opts.jobId + (opts.attempt > 1 ? '_' + opts.attempt : ''),
              kind: history.kind,
              piece: history.piece,
              head: history.head,
              source: history.source,
              capabilities: opts.capabilities,
              budgetUnits: opts.historyBudgetUnits,
            });
          }
          return respond(true, { history: step, metadataOverlay: emptyMetadataOverlayStats() });
        }
        const finished = await __nimbusGitPack.cloneFinish(context, { shares: opts.shares, full: opts.full === true });
        // The marker goes last: until it does, a failure leaves the clone abortable.
        const writer = context.writer();
        await writer.remove('.git/' + CLONE_JOB_MARKER);
        await writer.flush();
        return respond(true, { finished, metadataOverlay: emptyMetadataOverlayStats() });
      }
      if (phase === 'clone-prepare') {
        if (opts.op !== 'clone') throw protocolError('prepare requires clone operation');
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
        if (!opts.url) throw new Error('clone: url required');
        const cloneRoot = normalizePath(opts.dir);
        if (!cloneRoot) {
          throw new Error('fatal: destination path ' + JSON.stringify(opts.dir) +
            ' already exists and is not an empty directory.');
        }
        let existing = null;
        let firstMissing = null;
        const cloneRootParts = cloneRoot.split('/');
        for (let index = 0; index < cloneRootParts.length; index++) {
          const candidate = cloneRootParts.slice(0, index + 1).join('/');
          const isFinal = index === cloneRootParts.length - 1;
          stats.supervisorRpc.lstat++;
          const candidateStat = await useRpcResult(
            supervisor.lstat(candidate),
            result => result,
          );
          const isDirectory = candidateStat &&
            (candidateStat.type === 'directory' || candidateStat.type === 'dir');
          if ((!isFinal && candidateStat && !isDirectory) ||
              (isFinal && candidateStat && candidateStat.type === 'symlink')) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          if (!candidateStat && firstMissing === null) firstMissing = candidate;
          if (isFinal) existing = candidateStat;
        }
        const exclusiveRoot = normalizePath(opts.exclusiveMutationRoot || cloneRoot);
        if (opts.exclusiveDestination === true &&
            (exclusiveRoot !== (firstMissing || cloneRoot) ||
             (cloneRoot !== exclusiveRoot && !cloneRoot.startsWith(exclusiveRoot + '/')))) {
          throw new Error('git clone exclusive mutation root does not cover its destination');
        }
        stats.supervisorRpc.legacySymlinkSubtree++;
        const hasLegacySymlink = await useRpcResult(
          supervisor.hasLegacySymlinkUnder(exclusiveRoot),
          result => result === true,
        );
        if (hasLegacySymlink) {
          throw new Error("fatal: destination path '" + opts.dir +
            "' already exists and is not an empty directory.");
        }
        if (existing) {
          const isDirectory = existing.type === 'directory' || existing.type === 'dir';
          if (!isDirectory) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          stats.supervisorRpc.readdir++;
          const entries = await useRpcResult(supervisor.readdir(cloneRoot), result => result);
          if (!Array.isArray(entries) || entries.length !== 0) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          if (opts.exclusiveDestination === true) {
            authoritativeRootMetadata = metadataFromSupervisorStat(existing);
          }
        }
        if (opts.exclusiveDestination === true) authoritativeRoot = exclusiveRoot;
      } else if (phase === 'clone-checkout') {
        if (opts.op !== 'clone') throw protocolError('checkout requires clone operation');
        prepared = validatePreparedClone(opts.prepared, opts);
        const warmJob = cloneJobs.get(opts.jobId);
        cold = !warmJob;
        if (warmJob &&
            (warmJob.optionsHash !== opts.optionsHash ||
             warmJob.prepared.commit !== prepared.commit ||
             warmJob.prepared.tree !== prepared.tree)) {
          throw protocolError('warm clone job does not match prepared identity');
        }
        if (opts.exclusiveDestination === true && prepared.packOnlyObjectStore) {
          authoritativeRoot = normalizePath(opts.exclusiveMutationRoot || opts.dir);
          initialMetadata = prepared.metadata;
        }
        if (opts.checkoutCursor !== null &&
            (!opts.checkoutCursor || typeof opts.checkoutCursor !== 'object' ||
             Array.isArray(opts.checkoutCursor))) {
          throw protocolError('checkout cursor is invalid');
        }
        if (opts.checkoutCursor !== null) {
          const cloneRoot = normalizePath(opts.dir);
          initialDirectories = validateCheckoutDirectories(opts.checkoutCursor.directories)
            .map(path => cloneRoot + '/' + path);
        }
        if (!opts.checkoutBounds || typeof opts.checkoutBounds !== 'object') {
          throw protocolError('checkout bounds are invalid');
        }
        opts.checkoutBounds = {
          maxEntries: requirePositiveMetadataNumber(
            opts.checkoutBounds.maxEntries,
            'checkout max entries',
          ),
          maxDecodedBytes: requirePositiveMetadataNumber(
            opts.checkoutBounds.maxDecodedBytes,
            'checkout max decoded bytes',
          ),
          maxWallMs: requirePositiveMetadataNumber(
            opts.checkoutBounds.maxWallMs,
            'checkout max wall time',
          ),
        };
      } else if (phase === 'clone-abort') {
        requireProtocolString(opts.jobId, 'job id', 128);
        requireProtocolString(opts.optionsHash, 'options hash', 128);
      } else if (opts.op === 'clone') {
        throw protocolError('clone requires the prepare/checkout protocol');
      }

      const bufferedFs = createBufferedFs(
        supervisor,
        stats,
        authoritativeRoot,
        authoritativeRootMetadata,
        initialMetadata,
        initialDirectories,
        phaseDeadline,
        phase === 'clone-checkout'
          ? [normalizePath(opts.dir) + '/.git/index']
          : [],
        phase === 'clone-checkout'
          ? [normalizePath(opts.dir) + '/.git/nimbus-checkout-index']
          : [],
        // fetch, pull and push work in a repository that already exists.
        phase === 'operation' ? normalizePath(opts.dir) : null,
      );
      const fs = bufferedFs.fs;
      // cf-git reads packed objects by range and stores a fetched pack as it arrives (git/pack/facet-packs.ts).
      fs.packs = __nimbusGitPack.facetPacks(facetPacksSupervisor(supervisor, stats, async (dir) => {
        // A clone's objects/pack may exist only in this fs's pending writes: publish it first.
        await fs.promises.mkdir(dir);
        await bufferedFs.flushWave();
      }));
      flushWave = bufferedFs.flushWave;
      overlayStats = bufferedFs.overlayStats;
      waveStats = bufferedFs.waveStats;
      const metadataSnapshot = bufferedFs.metadataSnapshot;

      if (phase === 'clone-prepare') {
        if (authoritativeRoot !== null && authoritativeRoot !== normalizePath(opts.dir)) {
          mutated = true;
          await fs.promises.mkdir(opts.dir);
          await flushWave();
        }
        mutated = true;
        bufferedFs.pinFile(cloneJobMarkerPath(opts.dir), cloneJobMarker(opts));
        await fs.promises.mkdir(normalizePath(opts.dir) + '/.git');
        await fs.promises.writeFile(cloneJobMarkerPath(opts.dir), cloneJobMarker(opts));
        // No Git metadata wave starts until ownership is durable. If this first
        // W7 stream loses its response, a cold abort can still prove ownership
        // from the marker; a missing or mismatched marker is never authority.
        await flushWave();
        if (opts.filter !== undefined && opts.depth === undefined) {
          throw new Error('fatal: --filter with --no-shallow is not supported yet: clone with --depth <n>');
        }
        if (opts.exclusiveDestination === true) {
          // A full clone starts as a depth-1 one: its worktree first, its history after (clone-history).
          const context = gitPackContext(supervisor, stats, opts, authoritativeRoot, phaseDeadline, log);
          const fast = await __nimbusGitPack.cloneFast(context, {
            ref: opts.ref || undefined,
            depth: opts.depth === undefined ? 1 : opts.depth,
            jobId: opts.jobId,
            filter: opts.filter,
            blobsPerBatch: opts.blobsPerBatch,
          });
          if (!fast.unsupported) {
            const cloneRoot = normalizePath(opts.dir);
            prepared = {
              jobId: opts.jobId,
              optionsHash: opts.optionsHash,
              dir: cloneRoot,
              commit: fast.commit,
              tree: fast.tree,
              headRef: fast.headRef,
              packs: [],
              packOnlyObjectStore: true,
              metadata: [],
              fast,
            };
            return respond(true, { prepared, metadataOverlay: overlayStats() });
          }
          log('\\n[git] ' + fast.unsupported + ': one stream\\n');
        }
        const cache = {};
        await git.clone({
          fs, http, cache,
          dir: opts.dir,
          url: opts.url,
          ref: opts.ref || undefined,
          singleBranch: true,
          depth: opts.depth,
          noCheckout: true,
          nonBlocking: true,
          batchSize: 50,
          onProgress,
          onAuth,
        });
        const headRef = await git.currentBranch({
          fs,
          dir: opts.dir,
          fullname: true,
          test: false,
        }) || null;
        let commit = null;
        let tree = null;
        try {
          commit = await git.resolveRef({ fs, dir: opts.dir, ref: 'HEAD' });
        } catch (error) {
          const existingBranch = await git.currentBranch({
            fs,
            dir: opts.dir,
            fullname: true,
            test: true,
          });
          if (existingBranch !== undefined) throw error;
          commit = null;
          tree = null;
        }
        if (commit !== null) {
          const commitResult = await git.readCommit({ fs, dir: opts.dir, oid: commit, cache });
          tree = commitResult && commitResult.commit && commitResult.commit.tree;
          requireOid(commit, 'prepared commit');
          requireOid(tree, 'prepared tree');
        }
        // A prepare response is an acknowledgement that all .git mutations
        // are durable. Checkout is not allowed to start before this resolves.
        const preparedMarker = cloneJobMarker(opts, { commit, tree, headRef }, null, 0);
        bufferedFs.pinFile(cloneJobMarkerPath(opts.dir), preparedMarker);
        await fs.promises.writeFile(cloneJobMarkerPath(opts.dir), preparedMarker);
        await flushWave();
        const metadata = metadataSnapshot();
        const cloneRoot = normalizePath(opts.dir);
        prepared = {
          jobId: opts.jobId,
          optionsHash: opts.optionsHash,
          dir: cloneRoot,
          commit,
          tree,
          headRef,
          packs: preparedPackManifest(metadata, cloneRoot),
          packOnlyObjectStore: isPackOnlyObjectStore(metadata, cloneRoot),
          metadata,
        };
        cloneJobs.set(opts.jobId, { optionsHash: opts.optionsHash, cache, prepared });
      } else if (phase === 'clone-checkout') {
        const warmJob = cloneJobs.get(opts.jobId);
        const cache = warmJob ? warmJob.cache : {};
        const durableMarker = await readCloneJobMarker(fs, opts);
        if (!durableMarker) {
          throw protocolError('checkout clone job marker does not match');
        }
        const durableState = durableMarker.marker;
        if (durableState.prepared &&
            (durableState.prepared.commit !== prepared.commit ||
             durableState.prepared.tree !== prepared.tree ||
             durableState.prepared.headRef !== prepared.headRef)) {
          throw protocolError('clone job marker prepared identity does not match');
        }
        const currentMarker = cloneJobMarker(
          opts,
          prepared,
          durableState.cursor,
          durableState.cursorSeq,
        );
        bufferedFs.pinFile(
          cloneJobMarkerPath(opts.dir),
          currentMarker,
          currentMarker === durableMarker.raw,
        );
        if (!warmJob) {
          cloneJobs.set(opts.jobId, { optionsHash: opts.optionsHash, cache, prepared });
        }
        mutated = true;
        const durableHeadRef = await git.currentBranch({
          fs,
          dir: opts.dir,
          fullname: true,
          test: false,
        }) || null;
        if (durableHeadRef !== prepared.headRef) {
          throw protocolError('durable HEAD does not match prepared commit/tree');
        }
        if (prepared.commit === null) {
          let durableCommit = null;
          try {
            durableCommit = await git.resolveRef({ fs, dir: opts.dir, ref: 'HEAD' });
          } catch {}
          const existingBranch = await git.currentBranch({
            fs,
            dir: opts.dir,
            fullname: true,
            test: true,
          });
          if (durableCommit !== null || existingBranch !== undefined) {
            throw protocolError('durable unborn HEAD does not match prepared state');
          }
        } else {
          const durableCommit = await git.resolveRef({ fs, dir: opts.dir, ref: 'HEAD' });
          const durableCommitResult = await git.readCommit({
            fs,
            dir: opts.dir,
            oid: durableCommit,
            cache,
          });
          const durableTree = durableCommitResult &&
            durableCommitResult.commit &&
            durableCommitResult.commit.tree;
          if (durableCommit !== prepared.commit || durableTree !== prepared.tree) {
            throw protocolError('durable HEAD does not match prepared commit/tree');
          }
          checkoutResult = await git.checkoutFreshChunk({
            fs,
            cache,
            dir: opts.dir,
            ref: 'HEAD',
            cursor: opts.checkoutCursor,
            maxEntries: opts.checkoutBounds.maxEntries,
            maxDecodedBytes: opts.checkoutBounds.maxDecodedBytes,
            maxWallMs: opts.checkoutBounds.maxWallMs,
            deferIndexFragmentCleanup: true,
            onProgress,
          });
        }
        if (checkoutResult === null) {
          checkoutResult = {
            nextCursor: null,
            files: 0,
            decodedBytes: 0,
            treeEntriesVisited: 0,
            indexEntries: 0,
          };
        }
        await flushWave();
        if (checkoutResult.nextCursor === null) {
          if (opts.checkoutCursor?.indexChunks > 0) {
            await fs.promises.rmdir(
              normalizePath(opts.dir) + '/.git/nimbus-checkout-index',
              { recursive: true },
            );
          }
          bufferedFs.unpinFile(cloneJobMarkerPath(opts.dir));
          await fs.promises.unlink(cloneJobMarkerPath(opts.dir));
          await flushWave();
          cloneJobs.delete(opts.jobId);
        } else {
          const committedMarker = cloneJobMarker(
            opts,
            prepared,
            checkoutResult.nextCursor,
            durableState.cursorSeq + 1,
          );
          bufferedFs.pinFile(cloneJobMarkerPath(opts.dir), committedMarker);
          await fs.promises.writeFile(cloneJobMarkerPath(opts.dir), committedMarker);
          await flushWave();
        }
      } else if (phase === 'clone-abort') {
        const warmJob = cloneJobs.get(opts.jobId);
        if (warmJob && warmJob.optionsHash !== opts.optionsHash) {
          throw protocolError('abort job identity does not match');
        }
        if (!await ownsCloneJob(fs, opts)) {
          cloneJobs.delete(opts.jobId);
          return respond(true, {
            refused: 'not-owner',
            metadataOverlay: overlayStats(),
          });
        }
        mutated = true;
        cloneJobs.delete(opts.jobId);
        // File by file, then the directories: one recursive delete of a full
        // clone's .git (vscode: ~300 packs, idx and staged files) passes a
        // write group's row limit, and the clone would stay marked.
        const gitdir = normalizePath(opts.dir) + '/.git';
        const directories = [];
        const walk = async (dir) => {
          directories.push(dir);
          for (const name of await fs.promises.readdir(dir)) {
            const path = dir + '/' + name;
            const stat = await fs.promises.lstat(path);
            if (stat.isDirectory()) await walk(path);
            else if (name !== CLONE_JOB_MARKER) await fs.promises.unlink(path);
          }
        };
        await walk(gitdir);
        await flushWave();
        for (const dir of directories.reverse()) await fs.promises.rmdir(dir, { recursive: true });
        await flushWave();
      } else if (opts.op === 'fetch-objects') {
        // A partial clone's missing objects (git/promisor.ts): one request,
        // stored as a promisor pack. Writes land below the repository only.
        const root = normalizePath(opts.dir);
        const context = gitPackContext(supervisor, stats, opts, null, null, log, root);
        const fetched = await __nimbusGitPack.fetchObjects(context, { oids: opts.oids, jobId: invocationId });
        return respond(true, { fetched, metadataOverlay: overlayStats() });
      } else if (opts.op === 'fetch') {
        await git.fetch({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          depth: opts.depth,
          relative: opts.relative === true,
          singleBranch: true,
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'pull') {
        await git.pull({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref,
          singleBranch: true,
          author: opts.author || { name: 'user', email: 'user@nimbus.dev' },
          committer: opts.committer,
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'push') {
        await git.push({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref,
          onProgress,
          onAuth,
        });
      } else {
        throw new Error('Unknown op: ' + opts.op);
      }

      if (phase === 'operation') await flushWave();

      return respond(true, {
        prepared: phase === 'clone-prepare' ? prepared : undefined,
        nextCursor: phase === 'clone-checkout' ? checkoutResult.nextCursor : undefined,
        treeEntriesVisited: phase === 'clone-checkout'
          ? checkoutResult.treeEntriesVisited
          : undefined,
        decodedBytes: phase === 'clone-checkout' ? checkoutResult.decodedBytes : undefined,
        indexEntries: phase === 'clone-checkout' ? checkoutResult.indexEntries : undefined,
        metadataOverlay: overlayStats(),
      });
    } catch (e) {
      // Best-effort flush of partial state so user can inspect what landed
      try { await flushWave(); } catch {}
      // Only a failed PREPARE drops the warm job: a failed checkout chunk
      // keeps its entry so a marker-replay retry runs warm (the cache pins
      // the pack; a cold retry re-reads it from the supervisor). Completion
      // and clone-abort delete the entry, and the facet isolate itself is
      // scoped to one execGitNetwork call, so a retained entry can never
      // outlive its clone.
      if (phase === 'clone-prepare') cloneJobs.delete(opts.jobId);
      return respond(false, {
        error: (e && e.message) || String(e),
        errorCode: e && typeof e.code === 'string' ? e.code : undefined,
        metadataOverlay: overlayStats(),
      });
    }
  },
};
`;
}
