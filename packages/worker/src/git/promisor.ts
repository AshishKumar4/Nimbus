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

import { execGitNetwork, type GitNetworkResult } from './network-facet.js';

export interface FetchMissingObjectsRequest {
  pid: number;
  /** The repository's worktree top (or git directory) as an engine path: where the facet writes. */
  dir: string;
  /** The promisor remote's name and url (remote.<name>.url). */
  remote: string;
  url: string;
  /** Ids to fetch; the caller has already dropped those it holds. */
  oids: readonly string[];
  auth?: { username: string; password: string };
}

export interface FetchMissingObjectsResult {
  /** Objects the new pack holds (the wanted ids, and a wanted tree's subtrees). */
  fetched: number;
  network: GitNetworkResult;
}

export class PromisorFetchError extends Error {
  constructor(readonly remote: string, readonly result: GitNetworkResult) {
    super(`fatal: could not fetch missing objects from promisor remote '${remote}': ${result.error ?? 'unknown error'}`);
    this.name = 'PromisorFetchError';
  }
}

/** One request to the promisor remote for `oids`; resolves when their pack is durable. */
export async function fetchMissingObjects(
  ctx: DurableObjectState,
  env: unknown,
  request: FetchMissingObjectsRequest,
): Promise<FetchMissingObjectsResult> {
  const network = await execGitNetwork(ctx, env, {
    op: 'fetch-objects',
    pid: request.pid,
    dir: request.dir,
    url: request.url,
    remote: request.remote,
    oids: [...request.oids],
    quiet: true,
    auth: request.auth,
  });
  if (!network.success) throw new PromisorFetchError(request.remote, network);
  return { fetched: network.fetchedObjects ?? 0, network };
}
