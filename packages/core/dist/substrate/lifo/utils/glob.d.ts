import type { ProcessView } from '../../../runtime/process-files.js';
/**
 * Match a glob pattern against a text string, as fnmatch(3) without flags:
 * `*`, `?`, `[abc]`, `[!a-z]` (`^` too; `]` first is literal), `\` quotes the
 * next character (a trailing one matches nothing), and a `[` with no closing
 * `]` is a literal `[`. Characters are code points, as in a UTF-8 locale: `?`
 * matches 😀 whole, and a range orders by code point.
 */
export declare function globMatch(pattern: string, text: string): boolean;
/**
 * Match as bash's strmatch does (the shell's case, [[ ]], pathname expansion
 * and pattern operators): as globMatch, but a final backslash matches a
 * backslash (bash's sm_loop), where fnmatch(3)'s matches nothing.
 */
export declare function shellMatch(pattern: string, text: string): boolean;
/**
 * The units a trim or a substitution of `value` by `pattern` works in, as
 * bash's: characters, or, when either holds a byte that is no character,
 * bytes. `pattern` and `value` are given in those units (a byte one string
 * character), `matches` is shellMatch of the pattern there, `encode` puts
 * other text (a replacement) in them, and `decode` gives a result back as
 * text, so a byte-wise cut never leaves half of a character's UTF-16.
 */
export interface ShellUnits {
    readonly pattern: string;
    readonly value: string;
    readonly matches: (text: string) => boolean;
    readonly encode: (text: string) => string;
    readonly decode: (units: string) => string;
}
export declare function shellUnits(pattern: string, value: string): ShellUnits;
/** How many UTF-16 units the character at index `i` of `s` takes: 2 for a surrogate pair, else 1. */
export declare function characterWidth(s: string, i: number): number;
/** The character (code point) at UTF-16 index `i` of `s`: a surrogate pair whole, anything else one unit. */
export declare function characterAt(s: string, i: number): string;
/** The UTF-16 indices where `s`'s characters begin, and its length: every place a character boundary falls. */
export declare function characterBounds(s: string): number[];
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