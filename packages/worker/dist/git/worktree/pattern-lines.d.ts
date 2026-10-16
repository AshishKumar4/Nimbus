/**
 * git/worktree/pattern-lines.ts — a pattern file's lines (.gitignore,
 * info/exclude, info/sparse-checkout) as dir.c add_patterns_from_buffer
 * cuts them, before either grammar reads one.
 */
/**
 * The lines a pattern file gives: a UTF-8 BOM skipped; each line to its
 * LF, the last as if it ended in one (git appends it); an empty line or a
 * `#` comment skipped; then a CR before the LF dropped and trailing spaces
 * trimmed, so a line of a lone CR is an empty pattern, as git's is.
 */
export declare function patternLines(bytes: Uint8Array): Uint8Array[];
//# sourceMappingURL=pattern-lines.d.ts.map