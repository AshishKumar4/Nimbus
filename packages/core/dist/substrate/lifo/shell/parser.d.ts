import { type Token, type ScriptNode, type WordPart } from './types.js';
export declare class ParseError extends Error {
    pos: number;
    constructor(message: string, pos: number);
}
export declare function parse(tokens: Token[]): ScriptNode;
/**
 * Whether `parts` is a compound array assignment as written: one unquoted part,
 * `name=(` to `)`, the form the lexer attaches. A declaration builtin's
 * argument is an array literal only so: `declare x='(a b)'` is a scalar.
 */
export declare function isArrayLiteralWord(parts: readonly WordPart[]): boolean;
//# sourceMappingURL=parser.d.ts.map