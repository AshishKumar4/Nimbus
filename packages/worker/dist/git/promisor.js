/**
 * git/promisor.ts — a partial clone's missing objects, fetched on demand.
 *
 * A repository cloned with --filter names its promisor remote in its config
 * (remote.<name>.promisor = true). An object it lacks is fetched from that
 * remote by id: in one request for everything a command will need, where git
 * batches (checkout, diff, merge), and otherwise one at a time as a read
 * misses. The fetch runs in the git network facet (op fetch-objects), which
 * stores what arrives as a promisor pack; it resolves once the pack and its
 * idx are durable, so a read that follows finds the objects.
 */
import { execGitNetwork } from './network-facet.js';
export class PromisorFetchError extends Error {
    remote;
    result;
    constructor(remote, result) {
        super(`fatal: could not fetch missing objects from promisor remote '${remote}': ${result.error ?? 'unknown error'}`);
        this.remote = remote;
        this.result = result;
        this.name = 'PromisorFetchError';
    }
}
/** One request to the promisor remote for `oids`; resolves when their pack is durable. */
export async function fetchMissingObjects(ctx, env, request, 
/** The workspace's network: the promisor is reached through its egress (execGitNetwork). */
workspaceNetwork) {
    const network = await execGitNetwork(ctx, env, {
        op: 'fetch-objects',
        pid: request.pid,
        dir: request.dir,
        url: request.url,
        remote: request.remote,
        oids: [...request.oids],
        quiet: true,
        auth: request.auth,
        ...(request.onMount === true ? { onMount: true } : {}),
    }, workspaceNetwork);
    if (!network.success)
        throw new PromisorFetchError(request.remote, network);
    return { fetched: network.fetchedObjects ?? 0, network };
}
