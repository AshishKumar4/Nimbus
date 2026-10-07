/**
 * git/pack/sparse.ts — cone-mode sparse checkout (git sparse-checkout, cone
 * mode; dir.c's cone patterns): which paths a sparse worktree holds, and the
 * info/sparse-checkout file that says so.
 *
 * A cone is a set of directories taken whole ("recursive"). The worktree
 * holds every file at the top, every file below a recursive directory, and
 * the files directly in each recursive directory's parents; everything else
 * is in the index with skip-worktree set and not in the worktree. `git
 * clone --sparse` starts with no directories: the top's files only.
 */
/** Which paths a sparse worktree holds. */
export interface SparseMatcher {
    /** Whether the file (or symlink, or gitlink) at the repo-relative `path` is in the worktree. */
    includes(path: string): boolean;
    /** Whether the worktree holds the directory `dir` (something in the cone can be in it). */
    directory(dir: string): boolean;
}
/**
 * A cone as git holds one (dir.c's pattern list in cone mode): every path
 * (`full`), or the top's files, the files directly in each of `parents`, and
 * everything below each of `recursive`. Directories are repo-relative,
 * without leading or trailing slashes.
 */
export interface Cone {
    full: boolean;
    recursive: readonly string[];
    parents: readonly string[];
}
/**
 * The cone `git sparse-checkout set --cone <dirs>` makes (sparse-checkout.c
 * insert_recursive_pattern): each directory recursive and its ancestors
 * parents, but what a recursive directory already holds; each in byte order.
 */
export declare function coneOf(dirs: readonly string[]): Cone;
/**
 * Which paths `cone` holds, as path_matches_pattern_list matches cone
 * patterns: a file at the top, one whose path is a recursive directory's,
 * one directly in a parent, one below a recursive directory. Under
 * core.ignoreCase (`ignoreCase`) paths compare as fspathcmp compares them.
 */
export declare function coneMatcher(cone: Cone, ignoreCase?: boolean): SparseMatcher;
/**
 * The cone of a cone-mode info/sparse-checkout, read line by line as dir.c
 * add_pattern_to_hashsets reads it: "/*" alone makes the full cone and
 * "!/*\/" takes it back; "/<dir>/" adds a recursive directory, and
 * "!/<dir>/*\/" after it makes that a parent. null when a line is not a cone
 * pattern (where git warns and gives up cone mode).
 */
export declare function parseConeSparseCheckout(text: string): Cone | null;
/**
 * The info/sparse-checkout file of a cone (dir.c write_cone_to_file): the
 * top's files, then each parent directory's own files without its
 * subdirectories, then each recursive directory, in coneOf's order.
 */
export declare function coneSparseCheckout(dirs: readonly string[]): string;
//# sourceMappingURL=sparse.d.ts.map