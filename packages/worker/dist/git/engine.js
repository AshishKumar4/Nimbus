/**
 * git/engine.ts — the GitPackStream engine, bound to a session: what real
 * git's remote helper (git-remote-http, git-remote-https) asks of the
 * network. Each operation runs in the git network facet (network-facet.ts),
 * as the calling process (its credential and filesystem) and through the
 * workspace's network, on the pack layer's own protocol code
 * (pack/remote.ts):
 *
 *   listRefs   the remote's refs (upload-pack's, or receive-pack's for a push)
 *   fetchPack  the pack the wants need, with its .idx and .rev (a .promisor
 *              for a filtered fetch) and .git/shallow, written into the
 *              repository; a pack past one invocation's decoding budget
 *              goes on in the same facet until it is whole
 *   pushPack   the ref updates and the caller's pack, streamed through to
 *              receive-pack, and its report
 *
 * None of them writes a ref: git does, after (remote-tracking refs, tags,
 * FETCH_HEAD), and decides before what may be pushed.
 */
import { execGitNetwork } from './network-facet.js';
/** A failed operation, as the helper reports it to git. */
export class RemoteEngineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RemoteEngineError';
    }
}
/** The worktree whose .git `gitDir` is: the pack layer writes below a worktree's .git. */
function worktreeOf(gitDir) {
    const trimmed = gitDir.replace(/\/+$/, '');
    if (!trimmed.endsWith('/.git')) {
        throw new RemoteEngineError(`fatal: the engine writes into a repository's .git, not '${gitDir}' (a bare repository is not supported yet)`);
    }
    return trimmed.slice(0, -'/.git'.length) || '/';
}
/** The answer of an operation that succeeded, or its error. */
function answer(result, op) {
    if (!result.success || result.remote === undefined)
        throw new RemoteEngineError(result.error ?? `git ${op} failed`);
    return result.remote;
}
export function createRemoteEngine(binding) {
    const base = {
        pid: binding.pid,
        quiet: true,
        ...(binding.timeoutMs !== undefined ? { timeout: binding.timeoutMs } : {}),
        ...(binding.budgetUnits !== undefined ? { historyBudgetUnits: binding.budgetUnits } : {}),
    };
    return {
        async listRefs(request) {
            const result = await execGitNetwork(binding.ctx, binding.env, {
                ...base, op: 'remote-list', dir: '/', url: request.url, auth: request.auth, forPush: request.forPush,
            }, binding.network);
            return answer(result, 'ls-remote');
        },
        async fetchPack(request) {
            const result = await execGitNetwork(binding.ctx, binding.env, {
                ...base,
                op: 'remote-fetch',
                dir: worktreeOf(request.gitDir),
                url: request.url,
                auth: request.auth,
                remoteFetch: {
                    wants: request.wants,
                    ...(request.depth !== undefined ? { depth: request.depth } : {}),
                    ...(request.deepenSince !== undefined ? { deepenSince: request.deepenSince } : {}),
                    ...(request.deepenNot?.length ? { deepenNot: request.deepenNot } : {}),
                    ...(request.deepenRelative ? { deepenRelative: true } : {}),
                    ...(request.filter !== undefined ? { filter: request.filter } : {}),
                    includeTag: request.includeTag,
                    updateShallow: request.updateShallow,
                },
            }, binding.network);
            const step = answer(result, 'fetch');
            const { pending: _pending, ...done } = step;
            return done;
        },
        async pushPack(request) {
            const result = await execGitNetwork(binding.ctx, binding.env, {
                ...base,
                op: 'remote-push',
                dir: '/',
                url: request.url,
                auth: request.auth,
                remotePush: { commands: request.commands, atomic: request.atomic, pushOptions: request.pushOptions },
                remotePushPack: request.pack,
            }, binding.network);
            return answer(result, 'push');
        },
    };
}
