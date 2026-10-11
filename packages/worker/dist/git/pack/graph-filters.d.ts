/**
 * git/pack/graph-filters.ts — a full clone's commit-graph (commit-graph.ts),
 * written after the clone has answered, so nothing of it is on the way to
 * the prompt: its base layer first, then its changed-path filters, computed
 * in pieces and added to it, as `git commit-graph write --changed-paths`
 * would have written them.
 *
 *   plan      the base layer from the commit records the clone's history
 *             left (GRAPH_RECORDS_DIR), as the chain's one layer; its name,
 *             its commits and the pass's own name, unless the chain is
 *             anything else (filtered already, split, or not there)
 *   piece     commits [from, to) of the layer in date order, newest first (a
 *             commit's first parent is most often the next one, and they
 *             share most of their trees): each one's first-parent tree diff,
 *             its trees read from the repository's packs, as a filter;
 *             stopped at its budget, it says how far it got. Its file holds
 *             its filters sorted by graph position: a header of (position,
 *             length), then the filters
 *   assemble  the layer with every commit's filter, streamed a window of
 *             positions at a time (the filters are never held whole), as a
 *             new layer; the chain moved to it; the pieces go, and layers
 *             the chain no longer names
 *
 * The chain is replaced as git replaces it (commit-graph.c
 * write_commit_graph_file): commit-graph-chain.lock created exclusively, the
 * chain checked under it, the layer's temporary file (a name of this pass's
 * own) renamed to its content's name under it, the lock renamed over the
 * chain. Another writer's lock, or a chain that moved, leaves everything as
 * it is but the pass's own temporary, and the pass says why, as git does: a
 * content-addressed layer is never removed on a skip (another writer may be
 * publishing the same one). Layers the chain does not name are removed
 * after a pass succeeds, under the lock, as git's expire_commit_graphs
 * removes them after it writes. What a pass cut short left (its temporary,
 * its pieces) stays: another pass cannot tell it from a live one's.
 *
 * Nothing holds a layer whole: a piece reads its CDAT chunk (36 bytes a
 * commit, and 12 for its date order), and holds a cache of trees, the pack
 * store's caches and its own filters (at most 640 bytes a commit); the
 * assembly, 16 bytes a commit and one window.
 */
import type { CloneContext, CloneReceipt, CloneSupervisor, CloneWriter } from './clone.js';
/** The assembly reads and writes the filters this many bytes at a time. */
export declare const ASSEMBLY_WINDOW_BYTES: number;
/** What the pass needs of the session beyond a clone's calls: an exclusive create, and the lock's mode and removal. */
export interface GraphSupervisor extends CloneSupervisor {
    fsOpen(path: string, flags: {
        write: boolean;
        create: boolean;
        exclusive: boolean;
        mode: number;
    }): Promise<{
        id: number;
    }>;
    fsWrite(handle: number, offset: number, bytes: Uint8Array): Promise<unknown>;
    fsClose(handle: number): Promise<unknown>;
    chmod(path: string, mode: number): Promise<unknown>;
    unlink(path: string): Promise<unknown>;
}
/** The wave writer's streamed file (@nimbus-sh/platform/wave-writer.js fileChunks): a layer is never held whole. */
export interface GraphWriter extends CloneWriter {
    fileChunks(path: string, mode: number, size: number, chunks: AsyncIterable<Uint8Array>): Promise<void>;
}
export interface GraphContext extends CloneContext {
    supervisor: GraphSupervisor;
    writer(onReceipts?: (receipts: CloneReceipt[]) => void): GraphWriter;
}
export interface FilterFile {
    name: string;
    bytes: number;
}
/** Why a pass leaves the chain as it is (network-facet.ts GraphFiltersOutcome). */
export type GraphSkip = 'no-graph' | 'not-a-base' | 'locked' | 'moved';
/**
 * The layer to add filters to: a full clone's base layer, written first
 * from its records, or the chain's one layer if it has no filters yet; or
 * why there is none.
 */
export declare function graphFiltersPlan(context: GraphContext): Promise<{
    layer: string;
    commits: number;
    pass: string;
} | {
    skipped: GraphSkip;
}>;
/**
 * Filters for commits [from, to) of the layer's date order, until done or
 * past `budgetMs` of wall time, in one file: u32 count; count × (u32
 * position, u16 length), by position; the filters, in that order. Returns
 * where the next piece starts.
 */
export declare function graphFiltersPiece(context: GraphContext, request: {
    layer: string;
    pass: string;
    from: number;
    to: number;
    budgetMs: number;
}): Promise<{
    next: number;
    file: FilterFile | null;
    trees: number;
    treeBytes: number;
}>;
/** A pass that did not finish: its pieces go, and the layer stays as it is. */
export declare function graphFiltersDiscard(context: GraphContext, request: {
    layer: string;
    pass: string;
}): Promise<null>;
/**
 * The layer with every commit's filter, as a new layer the chain names; or
 * why the chain was left as it is. The pieces go either way.
 */
export declare function graphFiltersAssemble(context: GraphContext, request: {
    layer: string;
    pass: string;
    files: readonly FilterFile[];
    windowBytes?: number;
}): Promise<{
    layer: string | null;
    skipped?: GraphSkip;
}>;
//# sourceMappingURL=graph-filters.d.ts.map