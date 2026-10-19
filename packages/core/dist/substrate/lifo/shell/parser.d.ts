import { type Token, type AssignmentNode, type ScriptNode } from './types.js';
export declare class ParseError extends Error {
    pos: number;
    constructor(message: string, pos: number);
}
export declare function parse(tokens: Token[]): ScriptNode;
/**
 * `NAME=value`, `NAME+=value`, `NAME[expr]=value` and `NAME=(word …)`.
 *
 * As bash's assignment(): the name, the brackets, `+` and `=` are the word's
 * own unquoted characters, so `'x=y'` and `x"="y` are commands named so. A
 * subscript's characters may be quoted. The lexer keeps a parenthesised list
 * attached to its assignment, unquoted, so an array assignment arrives as one
 * word of one unquoted part, `(` to `)`: `x='(a b)'` is a scalar. Returns null
 * for anything that is an ordinary word rather than an assignment.
 */
export declare function parseAssignment(token: Token): AssignmentNode | null;
//# sourceMappingURL=parser.d.ts.map