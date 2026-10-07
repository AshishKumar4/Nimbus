/**
 * Words quoted for a POSIX shell, in the two forms Nimbus writes: always
 * single-quoted (a command line built to be run), and as GNU coreutils
 * quotes a word to be read back (printf %q, and the names in coreutils'
 * messages).
 */
/** `value` single-quoted, every `'` in it written `'\''`: one word to any POSIX shell. */
export declare function singleQuote(value: string): string;
/**
 * `value` as gnulib's quotearg shell-escape style writes it, which is what
 * coreutils' printf %q prints and how its messages name a file: bare when
 * no character is special to a shell (`#` and `~` only at the start, `{`
 * and `}` only alone); else double-quoted when it holds a `'` and nothing
 * special inside double quotes; else single-quoted, with control
 * characters as `$'\n'` pieces between single-quoted runs.
 */
export declare function shellEscape(value: string): string;
//# sourceMappingURL=shell-quote.d.ts.map