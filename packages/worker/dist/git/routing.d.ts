/**
 * Git's command-family policy: which implementation answers a `git`
 * invocation, decided before it runs, never because the other one failed.
 * The built-in (JavaScript) git keeps the commands it implements; real git
 * (git.wasm, installed with `nimbus install git`) supplies what it lacks. A
 * family it implements moves to real git only on measured evidence.
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
 * Measured 2026-10-07 on an isolated Cloudflare Preview, Express depth 1:
 * median wall milliseconds of the same README edit and branch transitions,
 * JS/WASI. Every family past the latency gate stays JavaScript.
 */
export declare const GIT_FAMILY_POLICY: Readonly<Record<GitFamily, GitFamilyPolicy>>;
/** A capability refusal; only the front door's pre-effect phase may hand it off. */
export declare class UnsupportedGitOperation extends Error {
    readonly diagnostic: string;
    readonly code: number;
    constructor(diagnostic: string, code: number);
}
/** Unknown commands and aliases have an explicit family too. */
export declare function classifyGitCommand(sub: string | undefined): GitFamily;
/** The measured family choice; capability belongs to the command's parser. */
export declare function gitBackend(sub: string | undefined): GitFamilyPolicy['backend'];
//# sourceMappingURL=routing.d.ts.map