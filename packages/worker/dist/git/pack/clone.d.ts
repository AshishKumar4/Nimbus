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
import { type WorkTally } from './processor.js';
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
    /** The gitlinks' share of the index (STAGE_DIR/index-gitlinks), bytes. */
    gitlinkIndexBytes: number;
    pack: PackSummary;
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
/**
 * The clone's metadata, its commit and trees, and its plan; or why the
 * server cannot serve the fast path.
 */
export declare function cloneFast(context: CloneContext, request: CloneRequest): Promise<ClonePrepared | CloneUnsupported>;
/** One batch: its blobs fetched by id, written at their paths as they resolve. */
export declare function cloneBatch(context: CloneContext, request: {
    jobId: string;
    index: number;
    batchBytes: number;
    capabilities: readonly string[];
}): Promise<CloneBatchResult>;
/** The index, from the batches' shares; then the staging directory goes. */
export declare function cloneFinish(context: CloneContext, request: {
    shares: {
        name: string;
        bytes: number;
    }[];
}): Promise<{
    indexEntries: number;
    indexBytes: number;
}>;
export { oidFromHex };
//# sourceMappingURL=clone.d.ts.map