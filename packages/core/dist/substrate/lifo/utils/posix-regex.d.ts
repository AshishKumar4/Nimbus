/**
 * POSIX regular expressions (basic and extended, with GNU's extensions) as
 * JavaScript regex source for the `u` flag, over text held losslessly
 * (bytes-io.ts): a byte that is not valid UTF-8 is U+DC80 + byte, and
 * neither `.` nor a negated bracket matches it, as GNU's matchers do not
 * match an encoding error. Used by grep and sed, and by the shell's
 * `[[ =~ ]]`, which reads an ERE as glibc's regcomp does (`regcomp`).
 */
export declare class PosixRegexSyntax extends Error {
}
export interface TranslateOptions {
    /** ERE (-E) rather than BRE. */
    extended: boolean;
    /** sed's escapes: \n newline, \t tab, \xHH a byte. */
    sed?: boolean;
    /**
     * glibc's regcomp(REG_EXTENDED), as bash's `[[ =~ ]]` compiles: an
     * operator with nothing to apply to, an interval that is none, a second
     * dash after a range, and a back reference to a group not yet closed are
     * errors (grep takes the first two literally), and a range orders code
     * points.
     */
    regcomp?: boolean;
}
/** A translated expression: its JavaScript source, how many groups it has, and whether one start can match ends JavaScript's greedy choice does not reach (`ambiguous`: an alternation, a quantified group, a back reference). */
export interface Translation {
    source: string;
    groups: number;
    ambiguous: boolean;
}
export declare const WORD = "[\\p{L}\\p{N}_]";
export declare const NOT_WORD = "[^\\p{L}\\p{N}_]";
/** A character as a literal in a JavaScript `u` pattern; `-` is escaped only in a class. */
export declare function literal(ch: string, inClass?: boolean): string;
/** A BRE or ERE as JavaScript regex source (`u` flag). */
export declare function translate(p: string, options: TranslateOptions): string;
/** A BRE or ERE as JavaScript regex source (`u` flag), with its groups and whether its matches need the longest found (execLongest). */
export declare function translateDetailed(p: string, options: TranslateOptions): Translation;
/** A compiled extended regular expression, as glibc's regcomp compiles one for `[[ =~ ]]`. */
export interface CompiledRegex extends Translation {
    regex: RegExp;
}
/** `ere` as glibc's regcomp(REG_EXTENDED) compiles it, from a cache of the last 64; PosixRegexSyntax when glibc refuses it. */
export declare function compileRegcomp(ere: string): CompiledRegex;
/**
 * The leftmost, then longest, match of `compiled` in `text`, as regexec gives
 * one: its text and each group's ("" for one that took no part); null when
 * there is none. The leftmost start is JavaScript's. From it, JavaScript's
 * greedy choice is the longest unless the expression is ambiguous (an
 * alternation, a quantified group, a back reference); then the match is
 * extended while some way of matching ends later.
 */
export declare function execLongest(compiled: CompiledRegex, text: string): string[] | null;
//# sourceMappingURL=posix-regex.d.ts.map