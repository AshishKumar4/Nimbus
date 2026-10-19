import type { RuntimeFsBridge, VfsListTree } from './os-contracts.js';
/**
 * Everything beneath directory `root` that `bridge`'s process may see, as
 * its listing pages it, walked here at once: every entry current at one
 * revision (a walk whose pages are not all at one is walked again), and the
 * subtree whole. Past `maxEntries` it is refused (E2BIG), so the caller
 * lists it some other way rather than mistaking part of it for all of it.
 * A root that is not a directory is refused as readdir refuses it (ENOENT,
 * ENOTDIR): a walk that met nothing beneath it is no listing of it.
 * The session's fsListTree (session/rpc.ts).
 */
export declare function subtreeListing(bridge: Pick<RuntimeFsBridge, 'list' | 'stat'>, root: string, maxEntries: number): Promise<VfsListTree>;
//# sourceMappingURL=fs-list-tree.d.ts.map