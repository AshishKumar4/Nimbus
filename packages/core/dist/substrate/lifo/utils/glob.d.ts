import type { ProcessView } from '../../../runtime/process-files.js';
/**
 * Match a glob pattern against a text string, as fnmatch(3) without flags:
 * `*`, `?`, `[abc]`, `[!a-z]` (`^` too; `]` first is literal), `\` quotes the
 * next character (a trailing one matches nothing), and a `[` with no closing
 * `]` is a literal `[`.
 */
export declare function globMatch(pattern: string, text: string): boolean;
/**
 * Match as bash's strmatch does (the shell's case, [[ ]], pathname expansion
 * and pattern operators): as globMatch, but a final backslash matches a
 * backslash (bash's sm_loop), where fnmatch(3)'s matches nothing.
 */
export declare function shellMatch(pattern: string, text: string): boolean;
/**
 * Expand a field against the VFS: `pattern` is the field as globMatch reads it
 * (its quoted characters escaped), `text` the field itself. Returns the sorted
 * matching paths, or [text] when the pattern has no unescaped glob character
 * or nothing matches.
 */
export declare function expandGlob(pattern: string, text: string, cwd: string, vfs: ProcessView): Promise<string[]>;
/**
 * How many characters `pattern` matches when that is fixed (no `*` in it), as
 * bash's umatchlen: each `?`, character, backslash-quoted character or bracket
 * expression is one. Null when it varies.
 */
export declare function fixedMatchLength(pattern: string): number | null;
/** Whether `s` holds a glob's special characters (`*`, `?`, `[`). */
export declare function hasGlobChars(s: string): boolean;
/**
 * `text` as a pattern that matches only itself: each character globMatch reads
 * specially quoted with a backslash, a bracket expression's `-`, `!` and `^`
 * too (`[a$'-'z]` holds a, - and z).
 */
export declare function escapeGlob(text: string): string;
//# sourceMappingURL=glob.d.ts.map