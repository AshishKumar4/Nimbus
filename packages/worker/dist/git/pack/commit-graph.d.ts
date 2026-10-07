/**
 * git/pack/commit-graph.ts — a repository's commit-graph
 * (Documentation/gitformat-commit-graph.txt), byte for byte what git 2.53
 * writes for `git commit-graph write --reachable` (generation data v2): a
 * full clone's, written as it finishes, as a chain of one layer
 * (objects/info/commit-graphs/), so the layers a later fetch writes stack on
 * it as git's do.
 *
 *   header   "CGPH", version 1, hash version 1 (SHA-1), chunks, 0 base graphs
 *   table    each chunk's id and offset, then a zero id and the end offset
 *   OIDF     256 u32: commits whose first id byte is <= i
 *   OIDL     the commits' ids, ascending
 *   CDAT     per commit: root tree; first and second parent (their graph
 *            positions; GRAPH_PARENT_NONE; or, for an octopus, the EDGE index
 *            with GRAPH_EXTRA_EDGES_NEEDED); topological level << 2 with the
 *            committer date's bits 32-33, then its low 32 bits
 *   GDA2     per commit: corrected commit date minus committer date, or past
 *            2^31 - 1 the index of its 64-bit value in GDO2, with the top bit
 *   GDO2     those 64-bit offsets (only when there are any)
 *   EDGE     an octopus's third and later parents, the last one marked
 *            (only when there are any)
 *   trailer  SHA-1 of everything above: the layer's name
 *
 * A clone's commits piece records each commit as it resolves
 * (commitRecord): its id, root tree, committer date and parents, parsed as
 * git's parse_commit_buffer and parse_commit_date read them.
 */
/** Where a clone writes its graph: the chain file names its layers, oldest first. */
export declare const COMMIT_GRAPHS_DIR = ".git/objects/info/commit-graphs";
export declare const COMMIT_GRAPH_CHAIN: string;
/**
 * A commit's record, from its id and its object's bytes: id, root tree,
 * committer date (u64), parent count (u16), parents. A commit git would
 * call bogus throws.
 */
export declare function commitRecord(oid: Uint8Array, data: Uint8Array): Uint8Array;
/** The records of a staged list (commitRecord's, back to back), as views of its bytes. */
export declare function commitRecords(bytes: Uint8Array): Generator<Uint8Array>;
/**
 * The graph a clone writes from its staged record lists, or null when it
 * writes none: a parent not recorded, or anything else that fails to
 * build. A graph is the clone's to offer, never its to fail on.
 */
export declare function cloneGraph(lists: readonly Uint8Array[]): {
    file: Uint8Array;
    commits: number;
} | null;
/** The commits of a graph, held as columns, in graph (id) order. */
export interface GraphCommits {
    count: number;
    /** Ids, ascending: OID_BYTES each. */
    oids: Uint8Array;
    trees: Uint8Array;
    dates: BigUint64Array;
    /** Commit i's parents are parents[parentStart[i] .. parentStart[i + 1]), as graph positions. */
    parentStart: Uint32Array;
    parents: Uint32Array;
}
/**
 * The graph's commits from their records (any order, each once): sorted by
 * id, each parent resolved to its position. A parent missing from the
 * records throws: `--reachable` takes every one.
 */
export declare function graphCommits(records: Iterable<Uint8Array>): GraphCommits;
/**
 * The graph file for `graph`'s commits (one layer, no base); with
 * `filters` (bloomFilter's, one per commit in graph order), its changed-path
 * chunks too, as `--changed-paths` with commitGraph.changedPathsVersion=2.
 */
export declare function writeCommitGraph(graph: GraphCommits, filters?: readonly Uint8Array[]): Uint8Array;
/** More changed paths than this (directories included) and a commit's filter says "too large". */
export declare const BLOOM_MAX_CHANGED_PATHS = 512;
/** murmur3_seeded_v2: Murmur3 32-bit over the bytes as unsigned. */
export declare function murmur3(seed: number, data: Uint8Array): number;
/**
 * A commit's changed-path filter from the paths its first-parent diff
 * changed (null: more than BLOOM_MAX_CHANGED_PATHS changes): each path and
 * its leading directories, 10 bits each, 7 hashes; one zero byte for no
 * paths, one 0xff byte when there are too many.
 */
export declare function bloomFilter(changed: readonly Uint8Array[] | null): Uint8Array;
/** A tree's entries, by its id. */
export type TreeReader = (oid: Uint8Array) => Promise<Uint8Array>;
/**
 * The paths a recursive tree diff (git's diff_tree_oid, no renames) of
 * `from` (null: the empty tree) to `to` changes: every file, symlink or
 * submodule added, removed or modified (its id or mode), a directory's by
 * each entry below it. Null once there are more than `limit`.
 */
export declare function changedPaths(read: TreeReader, from: Uint8Array | null, to: Uint8Array, limit?: number): Promise<Uint8Array[] | null>;
/** A layer's name: its trailing hash, in hex. */
export declare function graphName(file: Uint8Array): string;
//# sourceMappingURL=commit-graph.d.ts.map