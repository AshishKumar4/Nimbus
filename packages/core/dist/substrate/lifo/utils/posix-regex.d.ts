/**
 * POSIX regular expressions (basic and extended, with GNU's extensions) as
 * JavaScript regex source for the `u` flag, over text held losslessly
 * (bytes-io.ts): a byte that is not valid UTF-8 is U+DC80 + byte, and
 * neither `.` nor a negated bracket matches it, as GNU's matchers do not
 * match an encoding error. Used by grep and sed.
 */
export declare class PosixRegexSyntax extends Error {
}
export interface TranslateOptions {
    /** ERE (-E) rather than BRE. */
    extended: boolean;
    /** sed's escapes: \n newline, \t tab, \xHH a byte. */
    sed?: boolean;
}
export declare const WORD = "[\\p{L}\\p{N}_]";
export declare const NOT_WORD = "[^\\p{L}\\p{N}_]";
/** A character as a literal in a JavaScript `u` pattern; `-` is escaped only in a class. */
/** A character as a literal in a `u` pattern. */
export declare function literalChar(ch: string): string;
/** A BRE or ERE as JavaScript regex source (`u` flag). */
export declare function translate(p: string, options: TranslateOptions): string;
//# sourceMappingURL=posix-regex.d.ts.map