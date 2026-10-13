/**
 * git/worktree/verify-path.ts — the paths git lets into its index and
 * worktree (read-cache.c verify_path, path.c is_ntfs_dotgit, utf8.c
 * is_hfs_dotgit).
 *
 * No component may be empty, `.` or `..`, or `.git` in any case, and a link
 * may not be `.gitmodules`. With core.protectNTFS (on unless configured off)
 * neither may a name NTFS reads as one of those: trailing spaces and periods,
 * the short names (`git~1`), an alternate stream (`.git::$INDEX_ALLOCATION`),
 * a backslash as a separator. With core.protectHFS (off unless configured on,
 * as git builds it off macOS) neither may a name HFS+ reads as one, with the
 * code points it ignores.
 */
export interface PathProtection {
    hfs: boolean;
    ntfs: boolean;
}
/** git's defaults off macOS and Windows. */
export declare const DEFAULT_PATH_PROTECTION: PathProtection;
/** git's error for a path verify_path refuses (add_index_entry_with_check, make_cache_entry). */
export declare const invalidPathError: (path: string) => string;
/**
 * verify_path: whether git lets a repo-relative `path`, its entry's `mode`,
 * into its index: each component's start checked, then its characters
 * passed over to the next '/', a '\\' after its first character (protecting
 * NTFS) checked as a separator.
 */
export declare function verifyPath(path: string, mode: number, protect: PathProtection): boolean;
//# sourceMappingURL=verify-path.d.ts.map