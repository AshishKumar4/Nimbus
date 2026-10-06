/**
 * How GNU diffutils 3.12 compares two texts, ported so diff's edit script is
 * GNU's own: find_identical_ends (io.c) trims the common prefix and suffix
 * down to a horizon of context lines; find_and_hash_each_line gives each
 * remaining line an equivalence class; discard_confusing_lines, compareseq
 * and its diag (gnulib's diffseq.h: Myers' O(ND) search, bidirectional, in
 * linear space), shift_boundaries and build_script (analyze.c) turn the
 * classes into changes. Memory is linear in the input: per line a start, a
 * class and a flag, and two diagonal vectors of the lines' count; no table
 * of the two files' product.
 */
/** A text as diff reads it: its bytes with a final newline supplied, and where each line starts. */
export interface DiffText {
    readonly buffer: Uint8Array;
    /** Whether the file's last line had no newline (the buffer's is supplied). */
    readonly missingNewline: boolean;
    /** lineStart[i] is where line i begins; lineStart[lineCount] is the buffer's end. */
    readonly lineStart: Int32Array;
    readonly lineCount: number;
}
/** A change, by absolute line index (from 0): `deleted` lines of file 0 at line0 became `inserted` lines of file 1 at line1. */
export interface DiffChange {
    readonly line0: number;
    readonly line1: number;
    readonly deleted: number;
    readonly inserted: number;
}
export interface DiffOptions {
    /** -i */
    readonly ignoreCase: boolean;
    /** -b collapses runs of white space (and drops it at the end of a line), -w drops it all. */
    readonly whiteSpace: 'none' | 'change' | 'all';
    /** -d: no discarded lines, no giving up on an expensive search. */
    readonly minimal: boolean;
    /** Lines of the common prefix and suffix kept in the comparison: the context (horizon_lines). */
    readonly horizon: number;
}
export declare function diffText(bytes: Uint8Array): DiffText;
/** Whether line `line` is blank to -B, as analyze_hunk judges it: empty, or under -b or -w white space only. */
export declare function blankLine(text: DiffText, line: number, whiteSpace: DiffOptions['whiteSpace']): boolean;
/** GNU diff's edit script of `a` into `b`, its changes in order, by absolute line index. */
export declare function compareTexts(a: DiffText, b: DiffText, options: DiffOptions): DiffChange[];
//# sourceMappingURL=diff-analysis.d.ts.map