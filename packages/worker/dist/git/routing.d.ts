/**
 * Git's command-family policy. A route is chosen before execution, never
 * because the chosen runtime or a remote helper failed. The streamed clone
 * stays JavaScript; other families stay there until their latency and session
 * memory gates pass against the JavaScript implementation.
 */
export type GitFamily = 'clone' | 'init' | 'status' | 'diff' | 'add' | 'commit' | 'checkout' | 'reset' | 'history' | 'refs' | 'merge' | 'rebase' | 'stash' | 'sparse' | 'transport' | 'other';
export type GitFamilyPolicy = {
    readonly backend: 'javascript';
    readonly reason: 'streamed-clone' | 'performance-unmeasured';
} | {
    readonly backend: 'wasi';
    readonly reason: 'gates-passed';
    readonly evidence: string;
};
/** No family has passed both remote performance gates yet. */
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