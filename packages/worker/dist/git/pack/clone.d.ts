/**
 * git/pack/clone.ts — a shallow clone in one pass per object, in parallel
 * batches, written straight into the session.
 *
 * prepare (one invocation): discover the remote; fetch the commit and its
 *   trees with `filter blob:none` (Linux: 3.1 MB); store that pack and its
 *   idx; plan the checkout from the trees; write the repository's metadata
 *   (config, HEAD, refs, shallow) and one batch file per run of blobs.
 * batch (K invocations, concurrently): fetch a batch's blobs by id; as each
 *   blob is resolved write it at each of its paths through the wave writer;
 *   store the batch's pack and idx; keep its share of the index, built from
 *   the stat the session reports for each file it published.
 * finish (one invocation): assemble the index from the batches' shares.
 *
 * Every pack arrives once, is decoded once, and is stored as it arrives;
 * nothing reads it back but a delta whose base has left the cache.
 */
import { type IndexStat } from './index-file.js';
import { oidFromHex } from './format.js';
import { PackStreamProcessor, type PackProcessResult, type WorkTally } from './processor.js';
import { type GitTransportAuth } from './upload-pack.js';
/** The supervisor calls a clone makes beyond its wave writer's. */
export interface CloneSupervisor {
    fsWriteRange(path: string, offset: number, bytes: Uint8Array): Promise<unknown>;
    fsTruncate(path: string, size: number): Promise<unknown>;
    fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    rename(from: string, to: string): Promise<unknown>;
}
/** The wave writer's surface (git/wave-writer.ts), as a clone uses it. */
export interface CloneWriter {
    file(path: string, mode: number, bytes: Uint8Array): Promise<void>;
    symlink(path: string, target: string): Promise<void>;
    directory(path: string): Promise<void>;
    remove(path: string, directory?: boolean): Promise<void>;
    setPin(path: string, text: string, durable?: boolean): void;
    flush(): Promise<void>;
}
export interface CloneReceipt extends IndexStat {
    path: string;
}
export interface CloneContext {
    supervisor: CloneSupervisor;
    /** A wave writer rooted at the clone; `onReceipts` sees each published wave's files. */
    writer(onReceipts?: (receipts: CloneReceipt[]) => void): CloneWriter;
    /** The worktree's VFS path; record paths are relative to it. */
    dir: string;
    url: string;
    auth?: GitTransportAuth;
    /** The ownership marker every wave re-asserts (repo-relative path). */
    marker: {
        path: string;
        text: string;
    };
    onProgress?(text: string): void;
    fetch?: typeof fetch;
}
export interface CloneRequest {
    ref?: string;
    depth: number;
    jobId: string;
    /** `git clone --filter=<spec>`, normalized (blob:limit in bytes). */
    filter?: string;
    /** Blobs per batch; the default suits a 30 s invocation (BLOBS_PER_BATCH). */
    blobsPerBatch?: number;
}
export interface CloneBatchPlan {
    index: number;
    blobs: number;
    paths: number;
    /** Its batch file's length (STAGE_DIR/batch-<index>). */
    bytes: number;
}
export interface ClonePrepared {
    commit: string;
    tree: string;
    /** Branch HEAD names, or null for a detached HEAD (a tag). */
    headRef: string | null;
    capabilities: string[];
    batches: CloneBatchPlan[];
    /** Plan entries, gitlinks included, and the plan's bytes in memory. */
    planEntries: number;
    planBytes: number;
    /** The index entries prepare wrote (gitlinks, a blob:limit pack's blobs): STAGE_DIR files. */
    shares: {
        name: string;
        bytes: number;
    }[];
    /** A partial clone (--filter): every pack it stores is a promisor pack. */
    partial: boolean;
    packs: PackSummary[];
}
export interface PackSummary {
    packSha: string;
    packBytes: number;
    objects: number;
    work: WorkTally;
}
export interface CloneBatchResult {
    index: number;
    blobs: number;
    files: number;
    indexBytes: number;
    pack: PackSummary;
}
/** Why the fast path cannot serve this clone: the caller takes the single-stream path. */
export interface CloneUnsupported {
    unsupported: string;
}
export declare const STAGE_DIR = ".git/nimbus-clone";
export declare const PACK_DIR = ".git/objects/pack";
export declare function readRange(supervisor: CloneSupervisor, path: string, offset: number, length: number): Promise<Uint8Array>;
export declare function join(dir: string, path: string): string;
export interface StorePackOptions {
    cacheBytes?: number;
    recentBytes?: number;
    budgetUnits?: number;
    maxStoreReads?: number;
    onObject?: ConstructorParameters<typeof PackStreamProcessor>[0]['onObject'];
    promisor?: string;
}
/**
 * A pack whose decoding ran past the invocation's budget: stored whole as
 * `tmpName`, its idx records so far in STAGE_DIR/ckpt-<tmpName>. Plain
 * data: it travels in the facet's result to the next invocation.
 */
export interface PendingPack {
    tmpName: string;
    packBytes: number;
    offset: number;
    decoded: number;
    recordsBytes: number;
    externalBases: string[];
    promisor?: string;
}
export type StoredPack = {
    result: PackProcessResult;
    summary: PackSummary;
} | {
    pending: PendingPack;
};
/** storePack, or where its decoding stopped when the budget ran out first (see resumePack). */
export declare function storePackResumable(context: CloneContext, writer: CloneWriter, stream: AsyncIterable<Uint8Array>, tmpName: string, options: StorePackOptions): Promise<StoredPack>;
/** Continue decoding a pending pack from its stored bytes; it may stop at the budget again. */
export declare function resumePack(context: CloneContext, writer: CloneWriter, pending: PendingPack, options: Omit<StorePackOptions, 'promisor'>): Promise<StoredPack>;
/** The tree id a commit object names. */
export declare function commitTree(commit: Uint8Array, oid: string): string;
/**
 * The clone's metadata, its commit and trees, and its plan; or why the
 * server cannot serve the fast path.
 *
 * Without --filter prepare asks for blob:none and every blob comes in the
 * batches. With one, prepare asks for the user's filter: a blob:limit pack
 * also carries the small blobs, written at their paths as they arrive (a
 * pack's trees precede its blobs), and a tree:<depth> pack lacks deep trees,
 * which one more blob:none request for the root tree brings, as git's lazy
 * fetch would. Every pack of a partial clone is a promisor pack.
 */
export declare function cloneFast(context: CloneContext, request: CloneRequest): Promise<ClonePrepared | CloneUnsupported>;
export declare function concat(parts: Uint8Array[]): Uint8Array;
/** One batch: its blobs fetched by id, written at their paths as they resolve. */
export declare function cloneBatch(context: CloneContext, request: {
    jobId: string;
    index: number;
    batchBytes: number;
    capabilities: readonly string[];
    partial?: boolean;
}): Promise<CloneBatchResult>;
/** The index, from the batches' shares; then the staging directory goes. */
export declare function cloneFinish(context: CloneContext, request: {
    shares: {
        name: string;
        bytes: number;
    }[];
    full?: boolean;
}): Promise<{
    indexEntries: number;
    indexBytes: number;
}>;
export { oidFromHex };
export interface FetchObjectsResult {
    /** Ids the new pack holds. */
    fetched: number;
    pack: PackSummary | null;
}
/**
 * A promisor remote's missing objects, fetched by id in one request, as
 * git's lazy fetch does (promisor-remote.c fetch_objects: --filter=blob:none,
 * so a tree brings its subtrees but no blobs, while a wanted blob is always
 * sent). The pack is stored with its idx and a .promisor naming the ids.
 */
export declare function fetchObjects(context: CloneContext, request: {
    oids: readonly string[];
    jobId: string;
}): Promise<FetchObjectsResult>;
//# sourceMappingURL=clone.d.ts.map