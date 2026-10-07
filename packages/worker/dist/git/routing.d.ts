/**
 * Git's command-family policy. A route is chosen before execution, never
 * because the chosen runtime or a remote helper failed. JavaScript keeps the
 * commands it implements; real Git supplies its capability gaps. A supported
 * family moves only after latency and session-memory gates pass.
 */
export type GitFamily = 'clone' | 'init' | 'status' | 'diff' | 'add' | 'commit' | 'checkout' | 'reset' | 'history' | 'refs' | 'merge' | 'rebase' | 'stash' | 'sparse' | 'transport' | 'other';
export type GitFamilyPolicy = {
    readonly backend: 'javascript';
    readonly reason: 'streamed-clone' | 'javascript-coverage';
} | {
    readonly backend: 'javascript';
    readonly reason: 'latency-regression';
    readonly javascriptMs: number;
    readonly wasiMs: number;
} | {
    readonly backend: 'wasi';
    readonly reason: 'javascript-capability-gap';
};
/**
 * Measured 2026-10-07 on an isolated Cloudflare Preview, Express depth 1 at
 * 9efc29e280018dafc1f0617f3a3d28f4e463b7be; this lane's Git2.53 wasm SHA256
 * 8da15abaf11b5d1f47c85d091a483655442dc6cd807733c8b6a24c02dde2dbaf.
 * Median wall milliseconds, three samples after one warm-up, same README
 * edit/branch-transition workloads: JS/WASI status35/4798, diff27/2217,
 * add31/2207, commit33/4213, checkout56/4330. Every latency gate failed on
 * the smallest required repository; no larger-repo run or memory-pass claim.
 * A separate clean-status trace was3498/3106ms with FS wait3476/3101ms:
 * 295 lookup RPCs and open73/fstat74/close73. P4b's delegated read snapshots,
 * not a Git-only batching path, must remove this cost before re-measuring.
 */
export declare const GIT_FAMILY_POLICY: Readonly<Record<GitFamily, GitFamilyPolicy>>;
/** Unknown commands and aliases have an explicit policy too. */
export declare function classifyGitCommand(sub: string | undefined): GitFamily;
export interface ParsedGitGlobals {
    sub: string | undefined;
    subArgs: string[];
    /** The directory the subcommand runs in, after every `-C`. */
    dir: string;
}
/**
 * The JavaScript front door's leading options. Keep one parser for it and
 * routing: unsupported options must be refused, not swallowed before clone
 * or reinterpreted as a subcommand. A WASI route will receive the original
 * argv rather than a reconstructed command line.
 */
export declare function parseGitGlobals(args: string[], cwd: string): ParsedGitGlobals;
export interface GitInvocationRoute extends ParsedGitGlobals {
    family: GitFamily;
    policy: GitFamilyPolicy;
}
export declare function routeGitInvocation(args: string[], cwd: string): GitInvocationRoute;
//# sourceMappingURL=routing.d.ts.map