import type { FeedPosition } from '../runtime/feed-position.js';

/**
 * The session's root, asked beside the store's boot (spliced just before it,
 * after `__supervisor`, in every node body): the process's filesystem is the
 * store's view of the session's filesystem, whose device the root's stat
 * names (node-shims __nimbusStartProcessFilesystem). Asked after the
 * launch's cursor, so it is as of the store's cursor or after it; a delta
 * that names the root later moves it (vfs/resident view.ts namespaceView).
 */
export const NODE_ROOT_STAT_SOURCE = `
    const __nimbusRootAsked = __supervisor ? Promise.resolve(__supervisor.stat("/")).catch(() => null) : Promise.resolve(null);
    let __nimbusRootStat = null;
    // Null, or the launch's failure: the root could not be read.
    const __nimbusRootFailure = async () => {
      __nimbusRootStat = await __nimbusRootAsked;
      return __supervisor && !__nimbusRootStat ? "node: the process was not started: the session's root could not be read" : null;
    };
`;

/** The cursor a facet snapshot travels with (the namespace's position it was read at), or `null` when it has none. */
export type FacetVfsCursor = FeedPosition;

/**
 * The `__MODULE_VFS_CURSOR` literal for a generated facet body (the cursor its
 * store boots at). `null` is a real answer: a facet built without a VFS has no
 * state to be coherent with.
 */
export function serializeFacetVfsCursor(cursor: FacetVfsCursor | undefined): string {
  return JSON.stringify(cursor ?? null);
}
