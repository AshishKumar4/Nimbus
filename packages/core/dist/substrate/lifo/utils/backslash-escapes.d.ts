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
 * The dialects differ only in how an octal byte is spelled, in `\"`/`\E`,
 * and in `\c`:
 * - `echo`: bash's `echo -e`, `\0NNN` (a zero, then up to three digits);
 *   `\E` is ESC; `\"` is not an escape.
 * - `printf`: a printf FORMAT, `\NNN` (one to three digits); `\"` is `"`.
 * - `printf-b`: printf's `%b` argument, either spelling (coreutils' and
 *   bash's `%b`); `\"` is `"`.
 * - `ansi-c`: the body of a `$'...'` word, `\NNN`; `\E` is ESC; `\'`, `\"`
 *   and `\?` are themselves; `\x{H...}` is a byte too; `\cX` is X's control
 *   character (`\c?` DEL), and a NUL ends the text there, as bash's C
 *   strings have it.
 * Every dialect reads `\\ \a \b \e \f \n \r \t \v`, `\xHH` (one or two hex
 * digits), `\uHHHH` and `\UHHHHHHHH`, and, but in `ansi-c`, `\c`, which ends
 * the output there. Any other backslash stays as it is.
 *
 * An octal or hex escape names one byte, as bash's and coreutils' putchar
 * write it: `\303\251` is the two bytes of "é", `\377` the byte 0xff. A `\u`
 * or `\U` escape names a character, its UTF-8 bytes (a surrogate its own
 * three, and past U+10FFFF bash's wider forms, to U+7FFFFFFF). The result is the
 * lossless decoding of those bytes (bytes-io.ts), which its writer encodes
 * back to them.
 */
export type EscapeDialect = 'echo' | 'printf' | 'printf-b' | 'ansi-c';
/** `text` with its escapes expanded; `stopped` when a `\c` cut it short there. */
export declare function expandBackslashEscapes(text: string, dialect: EscapeDialect): {
    text: string;
    stopped: boolean;
};
/**
 * What bash's `echo` prints for `args`, as lossless text: leading words of
 * -n/-e/-E letters are its options (`--` ends them), the rest joined by
 * spaces; -e expands escapes, and a `\c` among them ends the output with no
 * newline.
 */
export declare function echoOutput(args: readonly string[]): string;
//# sourceMappingURL=backslash-escapes.d.ts.map