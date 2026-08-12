import { type Token } from './types.js';
export declare function lex(input: string): Token[];
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