/**
 * Backslash escapes as `echo -e` and `printf` expand them: one engine, in one
 * left-to-right pass, for the three places that read them.
 *
 * A pass per escape needs somewhere to park a literal `\` so the later passes
 * cannot read it as the start of an escape, and whatever character that is,
 * the text may hold one already, or an earlier escape may have just produced
 * one. NUL was the parking spot, so `printf 'a\0b'` came back as `a\b`. One
 * pass consumes `\\` as a unit and needs no parking spot.
 *
 * The dialects differ only in how an octal byte is spelled and in `\"`/`\E`:
 * - `echo`: bash's `echo -e`, `\0NNN` (a zero, then up to three digits);
 *   `\E` is ESC; `\"` is not an escape.
 * - `printf`: a printf FORMAT, `\NNN` (one to three digits); `\"` is `"`.
 * - `printf-b`: printf's `%b` argument, either spelling (coreutils' and
 *   bash's `%b`); `\"` is `"`.
 * Every dialect reads `\\ \a \b \e \f \n \r \t \v`, `\xHH` (one or two hex
 * digits), `\uHHHH` and `\UHHHHHHHH`, and `\c`, which ends the output there.
 * Any other backslash stays as it is.
 */
export type EscapeDialect = 'echo' | 'printf' | 'printf-b';
/** `text` with its escapes expanded; `stopped` when a `\c` cut it short there. */
export declare function expandBackslashEscapes(text: string, dialect: EscapeDialect): {
    text: string;
    stopped: boolean;
};
/**
 * What bash's `echo` prints for `args`: leading words of -n/-e/-E letters are
 * its options (`--` ends them), the rest joined by spaces; -e expands escapes,
 * and a `\c` among them ends the output with no newline.
 */
export declare function echoOutput(args: readonly string[]): string;
//# sourceMappingURL=backslash-escapes.d.ts.map