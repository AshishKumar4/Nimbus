/**
 * git/worktree/wildmatch.ts — git's wildmatch.c, ported byte for byte.
 *
 * The matcher behind every .gitignore pattern (dir.c match_basename and
 * match_pathname call it through fnmatch_icase_mem). It works on bytes, as
 * git does, so a pattern and a path compare in their UTF-8 encodings; the end
 * of either array stands for C's terminating NUL.
 */
/** '/' is matched only by a literal '/' or by '**' (git's WM_PATHNAME). */
export declare const WM_PATHNAME = 2;
/** wildmatch(): whether `pattern` matches all of `text`. */
export declare function wildmatch(pattern: Uint8Array, text: Uint8Array, flags?: number): boolean;
//# sourceMappingURL=wildmatch.d.ts.map