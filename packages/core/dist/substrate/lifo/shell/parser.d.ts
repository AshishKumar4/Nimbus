import { type Token, type AssignmentNode, type ScriptNode, type ListNode } from './types.js';
export declare class ParseError extends Error {
    pos: number;
    constructor(message: string, pos: number);
}
/** How a text is read: the alias a word names, if any, when it is read (`aliases`). */
export interface ReadOptions {
    aliases?: (name: string) => string | undefined;
}
export declare function parse(input: string, options?: ReadOptions): ScriptNode;
/**
 * A text's commands, read a line at a time, as bash's reader reads them: a
 * line is read whole (a syntax error in it runs none of it) only once the
 * lines before it have run, so an alias they define is expanded in it, and a
 * syntax error in a later line leaves the earlier ones run.
 */
export declare class ScriptLines {
    private readonly parser;
    constructor(input: string, options?: ReadOptions);
    /** The next line's lists, or null at the text's end; a ParseError when it is no command. */
    nextLine(): ListNode[] | null;
}
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