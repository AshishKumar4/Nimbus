/** An import() call or import.meta, or import and a comment before either. */
export declare const IMPORT_SYNTAX: RegExp;
/** Where the line `at` is on ends: its line break, or the text's end. */
export declare function lineEnd(text: string, at: number): number;
/** Where a cell's lines start and end, for lines that can run to megabytes. */
export declare class Lines {
    private readonly source;
    private readonly breaks;
    constructor(source: string);
    /** The line break ending the line `at` is on, or the cell's end. */
    endOf(at: number): number;
    /** Where the line `at` is on starts. */
    startOf(at: number): number;
}
/** Past whitespace and comments from `at`, and whether a line ended there. */
export declare function skipTrivia(source: string, at: number): {
    at: number;
    newline: boolean;
};
/**
 * Just past the `)` that closes the `(` at `open`, from Acorn's tokens over a
 * window from it that doubles until the parentheses balance; null if they
 * never do.
 */
export declare function parenthesisEnd(source: string, open: number): number | null;
/**
 * The possibly misread `/`s that matter, for the caller to check whether they
 * are in code at all. One matters when the text it would open as a regex, to
 * its closing `/` or its line's end, holds import syntax; or when that text
 * holds a quote and import syntax follows on its line, since a quote read the
 * other way opens a string that runs to that line's end. Most such `/`s are
 * no code, though, and stand in text read right: a template's (`${dir}/`), or
 * a regex's, closing one after a quantifier (`/a{4}/`). Ascending.
 */
export declare function ambiguousSlashes(source: string, lines: Lines): number[];
/**
 * Where an HTML-like comment may open, which a script's grammar reads as a
 * comment and es-module-lexer as code: `<!--` anywhere, and `-->` opening a
 * line (elsewhere `-->` is `--` and `>`). Ascending.
 */
export declare function htmlComments(source: string, lines: Lines): number[];
//# sourceMappingURL=import-lexer-hazards.d.ts.map