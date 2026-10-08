import type { RuntimeFsBridge, VfsListTree } from './os-contracts.js';
/**
 * Everything beneath directory `root` that `bridge`'s process may see, as
 * its listing pages it, walked here at once (a page of the session's own
 * filesystem is answered in the turn it is asked): every entry current at
 * one revision, and the subtree whole. Past `maxEntries` it is refused (E2BIG),
 * so the caller lists it some other way rather than mistaking part of it
 * for all of it. The session's fsListTree (session/rpc.ts).
 */
export declare function subtreeListing(bridge: Pick<RuntimeFsBridge, 'list'>, root: string, maxEntries: number): Promise<VfsListTree>;
//# sourceMappingURL=fs-list-tree.d.ts.map