/**
 * git/pack/remote.ts — a remote's refs, a fetch's pack and a push, as the
 * git network facet runs them for a remote helper (git/engine.ts): the
 * three raw operations git-remote-http(s) needs of the network. None of
 * them writes a ref: git does, after.
 *
 *   listRefs   the refs upload-pack (or, for a push, receive-pack)
 *              advertises, the symbolic HEAD, and the object format
 *   fetchPack  one request (wants, the repository's ref tips as haves, its
 *              shallow commits, the deepen and filter options): the pack is
 *              stored with its .idx and .rev (a .promisor for a filtered
 *              one) and .git/shallow updated as git's fetch-pack updates it;
 *              a pack past one invocation's decoding budget is stored whole
 *              and finished by fetchPackResume
 *   pushPack   the ref updates and the caller's pack in one request, and
 *              receive-pack's report
 *
 * The pack a fetch asks for is never thin: every delta's base is in it, so
 * none is read from the repository's packs or loose objects.
 */
import { type CloneContext, type PendingPack } from './clone.js';
import { type ReceiveCommand } from './receive-pack.js';
import { type GitTransportAuth } from './upload-pack.js';
/** The remote, as an operation reaches it. */
export interface RemoteTransport {
    url: string;
    auth?: GitTransportAuth;
    fetch?: typeof fetch;
    onProgress?(line: string): void;
}
export interface RemoteRef {
    name: string;
    oid: string | null;
    symref?: string;
}
/** The refs the remote advertises (its peeled tags as "<name>^{}"), a symbolic ref's target with it. */
export declare function listRefs(remote: RemoteTransport, request: {
    forPush: boolean;
}): Promise<{
    refs: RemoteRef[];
    objectFormat: 'sha1' | 'sha256';
}>;
export interface FetchPackRequest {
    jobId: string;
    wants: string[];
    depth?: number;
    deepenSince?: number;
    deepenNot?: string[];
    deepenRelative?: boolean;
    filter?: string;
    includeTag: boolean;
    updateShallow: boolean;
    budgetUnits?: number;
}
/** A fetch's outcome; `pending` while its pack's decoding goes on (fetchPackResume). */
export interface FetchPackStep {
    pending: (PendingPack & {
        shallow: ShallowUpdate;
    }) | null;
    packName: string | null;
    objects: number;
    bytes: number;
    shallow: boolean;
    promisor: boolean;
    selfContained: boolean;
}
/** What the server said of the receiver's shallow boundary, and whether .git/shallow takes it. */
interface ShallowUpdate {
    write: boolean;
    shallows: string[];
    unshallows: string[];
    /** The repository was complete before (no shallow commits, no promisor pack). */
    complete: boolean;
    filtered: boolean;
}
/** One request for `wants`, the pack stored; or where its decoding stopped. */
export declare function fetchPack(context: CloneContext, request: FetchPackRequest): Promise<FetchPackStep>;
/** A fetch whose pack's decoding stopped at the budget, continued from its stored bytes. */
export declare function fetchPackResume(context: CloneContext, request: {
    pending: PendingPack & {
        shallow: ShallowUpdate;
    };
    budgetUnits?: number;
}): Promise<FetchPackStep>;
export interface PushPackRequest {
    commands: ReceiveCommand[];
    atomic: boolean;
    pushOptions: string[];
}
/** The ref updates and the pack of what the remote lacks, and the remote's report. */
export declare function pushPack(remote: RemoteTransport, request: PushPackRequest, pack: AsyncIterable<Uint8Array> | null): Promise<{
    refs: Array<{
        ref: string;
        ok: boolean;
        reason?: string;
    }>;
}>;
export {};
//# sourceMappingURL=remote.d.ts.map