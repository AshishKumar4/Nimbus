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
/** The cone of `dirs`, as git's cone patterns match it. */
export declare function coneMatcher(dirs: readonly string[]): SparseMatcher;
/**
 * The directories of a cone-mode info/sparse-checkout (as
 * coneSparseCheckout writes it, or git does): each "/<dir>/" not followed by
 * its "!/<dir>/*\/" is taken whole; null when the file is not cone-shaped.
 */
export declare function parseConeSparseCheckout(text: string): string[] | null;
/**
 * A boolean in git config text (config.c git_config_bool): the last
 * `<key>` in `[<section>]`, names compared without case; a key alone is
 * true; undefined when it is not set.
 */
export declare function configBoolean(text: string, section: string, key: string): boolean | undefined;
/**
 * The info/sparse-checkout file of a cone (dir.c write_cone_to_file): the
 * top's files, then each parent directory's own files without its
 * subdirectories, then each recursive directory; parents and recursive
 * directories each in byte order, a recursive directory that is also a
 * parent listed as recursive only.
 */
export declare function coneSparseCheckout(dirs: readonly string[]): string;
//# sourceMappingURL=sparse.d.ts.map