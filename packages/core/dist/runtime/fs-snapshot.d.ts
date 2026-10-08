import type { RuntimeFsBridge, VfsSnapshot } from './os-contracts.js';
/**
 * Everything beneath directory `root` that `bridge`'s process may see, as
 * its listing pages it, walked here at once (a page of the session's own
 * filesystem is answered in the turn it is asked): every entry current at
 * one revision, and the subtree whole. Past `maxEntries` it is refused (E2BIG),
 * so the caller lists it some other way rather than mistaking part of it
 * for all of it. The session's fsSnapshot (session/rpc.ts).
 */
export declare function subtreeSnapshot(bridge: Pick<RuntimeFsBridge, 'list'>, root: string, maxEntries: number): Promise<VfsSnapshot>;
//# sourceMappingURL=fs-snapshot.d.ts.map