import type { FeedPosition } from '../runtime/feed-position.js';
/**
 * The session's root, asked beside the store's boot (spliced just before it,
 * after `__supervisor`, in every node body): the process's filesystem is the
 * store's view of the session's filesystem, whose device the root's stat
 * names (node-shims __nimbusStartProcessFilesystem). Asked after the
 * launch's cursor, so it is as of the store's cursor or after it; a delta
 * that names the root later moves it (vfs/resident view.ts namespaceView).
 */
export declare const NODE_ROOT_STAT_SOURCE = "\n    const __nimbusRootAsked = __supervisor ? Promise.resolve(__supervisor.stat(\"/\")).catch(() => null) : Promise.resolve(null);\n    let __nimbusRootStat = null;\n    // Null, or the launch's failure: the root could not be read.\n    const __nimbusRootFailure = async () => {\n      __nimbusRootStat = await __nimbusRootAsked;\n      return __supervisor && !__nimbusRootStat ? \"node: the process was not started: the session's root could not be read\" : null;\n    };\n";
/** The cursor a facet snapshot travels with (the namespace's position it was read at), or `null` when it has none. */
export type FacetVfsCursor = FeedPosition;
/**
 * The `__MODULE_VFS_CURSOR` literal for a generated facet body (the cursor its
 * store boots at). `null` is a real answer: a facet built without a VFS has no
 * state to be coherent with.
 */
export declare function serializeFacetVfsCursor(cursor: FacetVfsCursor | undefined): string;
//# sourceMappingURL=facet-vfs-cursor.d.ts.map