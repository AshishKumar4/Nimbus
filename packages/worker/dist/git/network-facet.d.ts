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
export type GitNetworkOp = 'clone' | 'fetch' | 'push' | 'fetch-objects';
/**
 * The clone's job marker, in its git directory from prepare until the clone
 * is whole: the proof an abort needs that the destination is the clone's,
 * and what tells every other git command the repository is not yet one.
 */
export declare const GIT_CLONE_JOB_MARKER = "nimbus-clone-job";
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
    auth?: {
        username: string;
        password: string;
    };
    /** Author and committer (for pull merges), as the supervisor's git resolved them. */
    author?: {
        name: string;
        email: string;
        timestamp?: number;
        timezoneOffset?: number;
    };
    committer?: {
        name: string;
        email: string;
        timestamp?: number;
        timezoneOffset?: number;
    };
    /** Total operation budget (ms). Clone default 30 min; other ops default 5 min. */
    timeout?: number;
    /** Clone-only: caller holds an exclusive mutation lease for dir. */
    exclusiveDestination?: boolean;
    /** Clone-only: normalized root covered by the exclusive mutation lease. */
    exclusiveMutationRoot?: string;
    /** Trusted supervisor-only lease owner; never sent to the dynamic worker. */
    mutationOwner?: string;
    /** fetch: `depth` counts from the current shallow boundary (git fetch --deepen). */
    relative?: boolean;
    /** `git clone --filter=<spec>`, normalized: a partial clone of a promisor remote. */
    filter?: string;
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
export type GitCloneInvocationPhase = 'clone-prepare' | 'clone-batch' | 'clone-history' | 'clone-finish' | 'clone-abort';
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
    lastProgress?: {
        phase: string;
        loaded: number;
        total?: number;
    };
    w7Waves: number;
    supervisorRpc: GitSupervisorRpcCounters;
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
export type GitNetworkErrorCode = 'GitCloneBudgetExceeded';
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
    /** Checkout batches finished, and the files they wrote. */
    batchesCompleted: number;
    filesWritten: number;
    elapsedMs: number;
    limitMs: number;
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
/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export declare function execGitNetwork(ctx: DurableObjectState, env: any, opts: GitNetworkOpts): Promise<GitNetworkResult>;
export declare function createRetryingGitHttp(baseHttp: GitHttp, opts?: GitHttpRetryOptions): GitHttp;
/**
 * Generate the dynamic worker code for the git network facet.
 *
 * Exports `default { async fetch(request, workerEnv) { ... } }`.
 * Reads op args from the POST body, runs isomorphic-git with a buffered
 * fs adapter, and flushes writes through W7 v3.
 */
export declare function assembleGitNetworkFacetSource(): string;
export {};
//# sourceMappingURL=network-facet.d.ts.map