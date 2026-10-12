/**
 * Git's command-family policy: which implementation answers a `git`
 * invocation, decided before it runs, never because the other one failed.
 * The built-in (JavaScript) git keeps the commands it implements; real git
 * (git.wasm, installed with `nimbus install git`) supplies what it lacks. A
 * family it implements moves to real git only on measured evidence.
 */
const javascript = { backend: 'javascript', reason: 'javascript-coverage' };
const wasi = { backend: 'wasi', reason: 'javascript-capability-gap' };
/**
 * Measured 2026-10-07 on an isolated Cloudflare Preview, Express depth 1:
 * median wall milliseconds of the same README edit and branch transitions,
 * JS/WASI. Every family past the latency gate stays JavaScript.
 */
export const GIT_FAMILY_POLICY = {
    clone: { backend: 'javascript', reason: 'streamed-clone' },
    init: javascript,
    status: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 35, wasiMs: 4798 },
    diff: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 27, wasiMs: 2217 },
    add: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 31, wasiMs: 2207 },
    commit: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 33, wasiMs: 4213 },
    checkout: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 56, wasiMs: 4330 },
    reset: javascript,
    history: javascript,
    refs: javascript,
    merge: javascript,
    rebase: wasi,
    stash: wasi,
    sparse: wasi,
    transport: javascript,
    other: wasi,
};
/** A capability refusal; only the front door's pre-effect phase may hand it off. */
export class UnsupportedGitOperation extends Error {
    diagnostic;
    code;
    constructor(diagnostic, code) {
        super(diagnostic.trimEnd());
        this.diagnostic = diagnostic;
        this.code = code;
        this.name = 'UnsupportedGitOperation';
    }
}
const COMMAND_FAMILIES = {
    clone: 'clone',
    init: 'init',
    status: 'status',
    diff: 'diff',
    'diff-files': 'diff',
    'diff-index': 'diff',
    'diff-tree': 'diff',
    add: 'add',
    commit: 'commit',
    checkout: 'checkout',
    switch: 'checkout',
    restore: 'checkout',
    reset: 'reset',
    log: 'history',
    show: 'history',
    blame: 'history',
    'rev-list': 'history',
    branch: 'refs',
    tag: 'refs',
    remote: 'refs',
    config: 'refs',
    'rev-parse': 'refs',
    'show-ref': 'refs',
    'update-ref': 'refs',
    'symbolic-ref': 'refs',
    'for-each-ref': 'refs',
    'ls-files': 'refs',
    reflog: 'refs',
    merge: 'merge',
    'cherry-pick': 'merge',
    revert: 'merge',
    rebase: 'rebase',
    stash: 'stash',
    'sparse-checkout': 'sparse',
    'ls-remote': 'transport',
    fetch: 'transport',
    pull: 'transport',
    push: 'transport',
};
/** Unknown commands and aliases have an explicit family too. */
export function classifyGitCommand(sub) {
    return sub !== undefined && Object.hasOwn(COMMAND_FAMILIES, sub) ? COMMAND_FAMILIES[sub] : 'other';
}
/** The measured family choice; capability belongs to the command's parser. */
export function gitBackend(sub) {
    // `git`, `git --version` and `git --help` are the built-in's own.
    return sub === undefined || sub.startsWith('-') ? 'javascript' : GIT_FAMILY_POLICY[classifyGitCommand(sub)].backend;
}
