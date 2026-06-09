import { type Token, type ScriptNode } from './types.js';
export declare class ParseError extends Error {
    pos: number;
    constructor(message: string, pos: number);
}
export declare function parse(tokens: Token[]): ScriptNode;
//# sourceMappingURL=parser.d.ts.map