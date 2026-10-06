/**
 * git/worktree/excludes.ts — which untracked paths git ignores (dir.c).
 *
 * The rules are git's: a .gitignore's patterns apply below its directory,
 * the deepest list with a matching pattern decides (its last matching
 * pattern, a `!` one re-including), then $GIT_DIR/info/exclude, then
 * core.excludesFile. A directory that is itself excluded excludes all that
 * is below it, and its own .gitignore is never read (prep_exclude). Lists
 * load only for the directories a check reaches, one stack along the path
 * being checked, so a walk holds the lists of one branch of the tree.
 */
interface PathPattern {
    /** The pattern without its `!` and its trailing '/'. */
    pattern: Uint8Array;
    /** Bytes before the first glob character. */
    nowildcard: number;
    flags: number;
    /** The directory of the file the pattern came from, '' or ending in '/'. */
    base: Uint8Array;
}
/** One file's patterns, in the order the file gives them. */
export type PatternList = PathPattern[];
/**
 * add_patterns_from_buffer: a pattern file's lines, `base` the repo-relative
 * directory the file sits in ('' at the top). A UTF-8 BOM, blank lines and
 * `#` comments are skipped; a CR before the LF is dropped.
 */
export declare function parsePatternList(bytes: Uint8Array, base: string): PatternList;
/**
 * The exclude rules of one worktree. `readGitignore(dir)` answers the bytes
 * of `<dir>/.gitignore` (dir repo-relative, '' the top), or null when there
 * is none. `fileLists` are core.excludesFile's patterns then info/exclude's;
 * the later one wins, as git checks info/exclude first. `ignoreCase` is
 * core.ignorecase: letters match either case.
 */
export declare class Excludes {
    private readonly readGitignore;
    private readonly fileLists;
    private readonly ignoreCase;
    private readonly stack;
    constructor(readGitignore: (dir: string) => Promise<Uint8Array | null>, fileLists: readonly PatternList[], ignoreCase?: boolean);
    /** is_excluded: whether git ignores `path` (repo-relative), a directory when `isDir`. */
    isExcluded(path: string, isDir: boolean): Promise<boolean>;
    private lastMatchingInLists;
    /** prep_exclude: the stack along `dir`'s ancestors and `dir` itself, the lists that apply in it. */
    private levelFor;
}
export {};
//# sourceMappingURL=excludes.d.ts.map