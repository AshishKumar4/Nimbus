/**
 * git-network-facet.ts — Facet-based git clone/fetch/pull.
 *
 * Runs isomorphic-git's network operations (clone/fetch/pull) inside a
 * dynamic worker (LOADER.load) to escape the supervisor DO's CPU budget
 * and to avoid the known DO fetch() hang in wrangler local dev.
 *
 * Architecture:
 *   - Facet holds a buffered fs adapter: writes accumulate in memory
 *   - When buffer reaches WAVE_SIZE files or WAVE_BYTES bytes, flush
 *     via ONE supervisor.writeBatchStream() RPC (atomic transactionSync).
 *   - At clone end, a final flush commits remaining buffered state.
 *   - Reads fall through: buffer → supervisor.readFile / supervisor.stat.
 *
 * Why this fixes the hang:
 *   - CPU-heavy packfile delta resolution runs in facet (own CPU budget)
 *   - No per-file RPC round-trips — ~1 writeBatch per 500 files
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
    /** Timeout (ms). Default 300_000 (5 min). */
    timeout?: number;
}
export interface GitNetworkResult {
    success: boolean;
    error?: string;
    elapsed: number;
    filesWritten: number;
    bytesWritten: number;
}
/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export declare function execGitNetwork(ctx: DurableObjectState, env: any, opts: GitNetworkOpts): Promise<GitNetworkResult>;
//# sourceMappingURL=network-facet.d.ts.map