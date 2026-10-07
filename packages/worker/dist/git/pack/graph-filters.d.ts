/**
 * git/pack/graph-filters.ts — a full clone's changed-path filters, computed
 * after the clone has answered, in pieces, and added to its commit-graph
 * layer (commit-graph.ts), as `git commit-graph write --changed-paths`
 * would have written them.
 *
 *   plan      the chain's one layer, by name, and its commits
 *   piece     commits [from, to) of the layer in date order, newest first (a
 *             commit's first parent is most often the next one, and they
 *             share most of their trees): each one's first-parent tree diff,
 *             its trees read from the repository's packs, as a filter;
 *             stopped at its budget, it says how far it got
 *   assemble  the filters in graph order, added to the layer as a new one;
 *             the chain names it if it still names the old one (a fetch may
 *             have layered on since: then the old layer stays as it is); the
 *             old layer and the pieces' files go
 *
 * A piece holds the layer (56 bytes a commit), a cache of trees, the pack
 * store's caches and its own filters (at most 640 bytes a commit).
 */
import type { CloneContext } from './clone.js';
export interface FilterFile {
    name: string;
    bytes: number;
}
/** The layer to add filters to, if the chain is a clone's one layer without them. */
export declare function graphFiltersPlan(context: CloneContext): Promise<{
    layer: string;
    commits: number;
} | null>;
/**
 * Filters for commits [from, to) of the layer's date order, until done or
 * past `budgetMs` of wall time; their records (position u32, length u16,
 * filter) in one file. Returns where the next piece starts.
 */
export declare function graphFiltersPiece(context: CloneContext, request: {
    layer: string;
    from: number;
    to: number;
    budgetMs: number;
}): Promise<{
    next: number;
    file: FilterFile | null;
    trees: number;
    treeBytes: number;
}>;
/**
 * The layer, with every commit's filter, as a new layer the chain names;
 * null when the chain no longer names the old one alone (the pieces' files
 * go either way).
 */
export declare function graphFiltersAssemble(context: CloneContext, request: {
    layer: string;
    files: readonly FilterFile[];
}): Promise<{
    layer: string | null;
}>;
//# sourceMappingURL=graph-filters.d.ts.map