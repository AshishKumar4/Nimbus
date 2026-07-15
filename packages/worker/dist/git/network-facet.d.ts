/**
 * git-network-facet.ts — Facet-based git clone/fetch/pull.
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
export type GitNetworkOp = 'clone' | 'fetch' | 'pull' | 'push';
export interface GitNetworkOpts {
    op: GitNetworkOp;
    /** Absolute working tree directory (e.g. "/home/user/project") */
    dir: string;
    /** For clone: repository URL */
    url?: string;
    /** For fetch/pull: remote name (default "origin") */
    remote?: string;
    /** For pull: branch name (default current) */
    ref?: string;
    /** Shallow depth; default 1 for clone */
    depth?: number;
    /** Username + password/token */
    auth?: {
        username: string;
        password: string;
    };
    /** Author (for pull merges) */
    author?: {
        name: string;
        email: string;
    };
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
}
export interface GitSupervisorRpcCounters {
    stat: number;
    lstat: number;
    readdir: number;
    readFile: number;
    fsReadRange: number;
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
export type GitCloneInvocationPhase = 'clone-prepare' | 'clone-checkout' | 'clone-abort';
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
}
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
    errorCode?: 'GitCloneBudgetExceeded';
    budget?: GitCloneBudgetDiagnostic;
    cleanupError?: string;
}
export interface GitCloneBudgetDiagnostic {
    phase: GitCloneInvocationPhase;
    chunksCompleted: number;
    processedEntries: number;
    decodedBytes: number;
    elapsedMs: number;
    limitMs: number;
}
/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export declare function execGitNetwork(ctx: DurableObjectState, env: any, opts: GitNetworkOpts): Promise<GitNetworkResult>;
/**
 * Generate the dynamic worker code for the git network facet.
 *
 * Exports `default { async fetch(request, workerEnv) { ... } }`.
 * Reads op args from the POST body, runs isomorphic-git with a buffered
 * fs adapter, and flushes writes through W7 v3.
 */
export declare function assembleGitNetworkFacetSource(): string;
//# sourceMappingURL=network-facet.d.ts.map