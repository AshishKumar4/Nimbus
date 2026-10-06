/**
 * git/pack/history.ts — a clone's full history, fetched in self-contained
 * pieces after its depth-1 worktree.
 *
 *   commits  every commit, no trees or blobs (filter tree:0); their root
 *            trees listed in pack order (newest first: neighbours share
 *            most of their trees)
 *   trees    the root trees of a run of commits with everything below them
 *            but blobs (filter blob:none), in runs of COMMITS_PER_CHUNK;
 *            each blob met is listed with its basename
 *   plan     the listed blobs, less those the worktree's batches fetched,
 *            once each, sorted by basename and cut into batches: a file's
 *            versions and its namesakes elsewhere travel together, so the
 *            server deltifies them as it does in one pack
 *   blobs    each batch, by id
 *
 * Every piece is its own request, so every pack is self-contained and is
 * resolved with a bounded cache; one that runs past an invocation's budget
 * is stored whole and resumed from its bytes (clone.ts resumePack). Measured
 * on react (2026-10-05, against GitHub): 137.66 MB in 12 requests, where git
 * clone fetches 137.16 MB in 3.
 */
import { type CloneContext, type PackSummary, type PendingPack } from './clone.js';
/** Root trees per trees request. */
export declare const COMMITS_PER_CHUNK = 5000;
/**
 * Blobs per blobs request. Small enough that a batch's pack mostly fits the
 * window of stored bytes kept readable, so evicted bases are re-inflated from
 * memory rather than read back over RPC: live, react's 25,000-blob batches
 * (packs to 52 MB) spent most of a 348 s clone in base reads and resumes.
 */
export declare const BLOBS_PER_HISTORY_BATCH = 10000;
export interface StagedFile {
    name: string;
    bytes: number;
}
/** `snapshot`: a streamed clone's one pack, whose decoding continues here (clone.ts cloneStream). */
export type HistoryKind = 'commits' | 'trees' | 'blobs' | 'snapshot';
/** One history invocation's outcome: its pack (done or pending), and what it listed. */
export interface HistoryStepResult {
    kind: HistoryKind;
    pack: PackSummary | null;
    pending: PendingPack | null;
    /** Lists written (STAGE_DIR files): root trees for commits, blobs for trees. */
    lists: StagedFile[];
}
/** One piece of history: its request, its pack, its list. */
export declare function historyStep(context: CloneContext, request: {
    jobId: string;
    kind: HistoryKind;
    /** A name unique to this piece, for its pack and lists. */
    piece: string;
    /** commits: the branch head. */
    head?: string;
    /** trees: a slice of a commits list (20-byte root trees); blobs: a batch file (20-byte ids). */
    source?: StagedFile & {
        offset?: number;
        length?: number;
    };
    capabilities: readonly string[];
    /** Work units to decode before stopping (processor.ts WORK_BUDGET_UNITS by default). */
    budgetUnits?: number;
}): Promise<HistoryStepResult>;
/** A piece whose decoding stopped at the budget, continued from its stored pack. */
export declare function historyResume(context: CloneContext, request: {
    kind: HistoryKind;
    piece: string;
    part: number;
    pending: PendingPack;
    budgetUnits?: number;
}): Promise<HistoryStepResult>;
/**
 * The blobs batches: every listed blob not already present, once, sorted by
 * basename. `present` are the worktree batch files (plan.ts encodeBatch).
 */
export declare function historyPlan(context: CloneContext, request: {
    lists: StagedFile[];
    present: StagedFile[];
    blobsPerBatch?: number;
}): Promise<{
    batches: StagedFile[];
    blobs: number;
    names: number;
}>;
/** Root-tree slices of the commits lists, COMMITS_PER_CHUNK at a time. */
export declare function treeSlices(lists: readonly StagedFile[], commitsPerChunk?: number): (StagedFile & {
    offset: number;
    length: number;
})[];
//# sourceMappingURL=history.d.ts.map