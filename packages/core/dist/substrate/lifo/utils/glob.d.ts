import type { ProcessView } from '../../../runtime/process-files.js';
/**
 * Match a glob pattern against a text string, as fnmatch(3) without flags:
 * `*`, `?`, `[abc]`, `[!a-z]` (`^` too; `]` first is literal), `\` quotes the
 * next character (a trailing one matches nothing), and a `[` with no closing
 * `]` is a literal `[`.
 */
export declare function globMatch(pattern: string, text: string): boolean;
/**
 * Expand a glob pattern against the VFS.
 * Returns sorted matching paths, or [pattern] if no matches.
 */
export declare function expandGlob(pattern: string, cwd: string, vfs: ProcessView): Promise<string[]>;
//# sourceMappingURL=glob.d.ts.map