/**
 * The parts of css-tree 3 Nimbus uses (runtime/css-syntax.ts), typed: its
 * parser, generator and walker, its tokenizer, and its ident, string and url
 * codecs. css-tree ships no types of its own; each subpath is imported alone,
 * so the lexer and its MDN grammar data stay out of every bundle.
 */

declare module 'css-tree/parser' {
  import type { CssNode, ParseOptions } from 'css-tree/types';
  const parse: (source: string, options?: ParseOptions) => CssNode;
  export default parse;
}

declare module 'css-tree/generator' {
  import type { CssNode } from 'css-tree/types';
  /** What decides whitespace between two tokens: the next state, whose low bit asks for a space. */
  type TokenBefore = (prevCode: number, type: number, value: string) => number;
  export interface GenerateHandlers {
    tokenBefore: TokenBefore;
  }
  interface GenerateOptions {
    decorator?(handlers: GenerateHandlers): GenerateHandlers;
  }
  const generate: (node: CssNode, options?: GenerateOptions) => string;
  export default generate;
}

declare module 'css-tree/walker' {
  import type { CssList, CssListItem, CssNode } from 'css-tree/types';
  interface WalkOptions {
    visit?: string;
    enter(this: unknown, node: CssNode, item: CssListItem | null, list: CssList | null): void | symbol;
  }
  interface Walk {
    (ast: CssNode, options: WalkOptions | ((node: CssNode, item: CssListItem | null, list: CssList | null) => void | symbol)): void;
    readonly skip: symbol;
    readonly break: symbol;
  }
  const walk: Walk;
  export default walk;
}

declare module 'css-tree/tokenizer' {
  /** Calls `onToken` for each token of `source`: its type and its [start, end) offsets. */
  export function tokenize(source: string, onToken: (type: number, start: number, end: number) => void): void;
  export const EOF: number;
  export const Ident: number;
  export const Function: number;
  export const AtKeyword: number;
  export const Hash: number;
  export const String: number;
  export const BadString: number;
  export const Url: number;
  export const BadUrl: number;
  export const Delim: number;
  export const Number: number;
  export const Percentage: number;
  export const Dimension: number;
  export const WhiteSpace: number;
  export const CDO: number;
  export const CDC: number;
  export const Colon: number;
  export const Semicolon: number;
  export const Comma: number;
  export const LeftSquareBracket: number;
  export const RightSquareBracket: number;
  export const LeftParenthesis: number;
  export const RightParenthesis: number;
  export const LeftCurlyBracket: number;
  export const RightCurlyBracket: number;
  export const Comment: number;
}

declare module 'css-tree/utils' {
  export const ident: { decode(text: string): string; encode(text: string): string };
  export const string: { decode(text: string): string; encode(text: string, apostrophe?: boolean): string };
  export const url: { decode(text: string): string; encode(text: string): string };
}

declare module 'css-tree/types' {
  export interface CssPosition {
    offset: number;
    line: number;
    column: number;
  }
  export interface CssLocation {
    source: string;
    start: CssPosition;
    end: CssPosition;
  }
  export interface CssListItem {
    prev: CssListItem | null;
    next: CssListItem | null;
    data: CssNode;
  }
  export interface CssList {
    toArray(): CssNode[];
    forEach(fn: (node: CssNode, item: CssListItem, list: CssList) => void): void;
    remove(item: CssListItem): CssListItem;
    readonly size: number;
  }
  /** Any node: its type says which of the optional fields it has. */
  export interface CssNode {
    type: string;
    loc?: CssLocation | null;
    /** Atrule: its name as written (escapes undecoded). */
    name?: string;
    /** Atrule: what follows its name; null when nothing does. */
    prelude?: CssNode | null;
    /** Atrule, Rule: its block; null for a statement. */
    block?: CssNode | null;
    children?: CssList;
    /** Url: the URL, decoded. Raw, Comment: the text. */
    value?: string;
  }
  export interface ParseOptions {
    positions?: boolean;
    onComment?(value: string, loc: CssLocation | null): void;
    onParseError?(error: Error & { offset?: number }, fallbackNode: CssNode): void;
  }
}
