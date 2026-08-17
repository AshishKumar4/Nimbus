import { type Token } from './types.js';
export declare function lex(input: string): Token[];
export type ContinuationState = 'single' | 'double' | 'backslash';
/**
 * How `input` leaves the lexer at end of input: inside an unclosed single or
 * double quote, or ending in a `\` line continuation (which bash also honors
 * inside double quotes, where `\<newline>` is removed). The interactive shell
 * uses this to keep reading (PS2) instead of executing a truncated command.
 * Comments are skipped exactly where lex() treats `#` as one.
 */
export declare function continuationState(input: string): ContinuationState | null;
/**
 * The full `${...}` span starting at `pos`. Quotes, nested braces and command
 * substitutions inside it belong to the expansion, not to the surrounding
 * word — `"${v:-"a b"}"` and `"${v:-$(cmd)}"` are one parameter expansion each.
 */
export declare function readBracedExpansion(input: string, pos: number): {
    text: string;
    inner: string;
    end: number;
};
//# sourceMappingURL=lexer.d.ts.map