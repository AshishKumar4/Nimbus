import { TokenKind, type Token } from './types.js';
/** Every token of `input`, read at once. */
export declare function lex(input: string): Token[];
/**
 * An array literal's words (the text between its parentheses), as bash's
 * reader reads a compound assignment: as anywhere, except that a word
 * beginning `[subscript]=` or `[subscript]+=` reads its subscript whole
 * (TokenReader.readSubscriptedWord).
 */
export declare function lexArrayElements(input: string): Token[];
/** Text a reader reads: the input, or an alias's text read in place of its name (`alias`; `blank`: it ends in a blank). */
interface Frame {
    readonly input: string;
    at: number;
    readonly alias: string | null;
    readonly blank: boolean;
}
/**
 * Where a reader is between tokens: the text it reads at each depth, and the
 * here-documents whose bodies follow its next newline (the first
 * `pendingCount` of `pending`, which a line's words only add to).
 */
export interface ReaderMark {
    readonly frames: readonly Frame[];
    readonly pending: readonly HeredocDelimiter[];
    readonly pendingCount: number;
    readonly operator: TokenKind.Heredoc | TokenKind.HeredocStripTabs | null;
    readonly checkNext: boolean;
}
/**
 * The shell's reader: `input`'s tokens a batch at a time (a token, or a
 * newline and the here-document bodies it opens), as its parser asks for
 * them, so that the parser can go back to where a token began and read a
 * word there in a mode of its own (the regular expression after `=~`), or
 * read an alias's text in place of a word (pushAlias), as bash's reader
 * does: a comment in that text takes the rest of the line it is read in.
 */
export declare class TokenReader {
    private frames;
    private pending;
    private operator;
    private checkNext;
    constructor(input: string);
    mark(): ReaderMark;
    reset(mark: ReaderMark): void;
    /** Read `alias`'s text `value` next, in place of its name: none of its words, or the next one's after it, is `alias` again until it is read. */
    pushAlias(alias: string, value: string): void;
    /** The text being read: an alias's ends where its text does, and the text it was read in goes on. */
    private get frame();
    /** The aliases whose text is being read: their names expand nothing read now. */
    private aliasesInUse;
    /** The next batch: a token, or a newline and the here-document bodies it opens; at the input's end, EOF. */
    next(): Token[];
    private read;
    /**
     * An array literal's `[subscript]=value` (or `+=`) word, read here when one
     * begins at the next word: its subscript to the matching `]`, whose blanks,
     * parentheses and operators are its own and whose quotes are kept as a
     * word's (`[i + 1]`, `[(1+2)]`, `["a]b"]`), then the value as a word. Null,
     * with nothing read but blanks, where the next word is not one.
     */
    readSubscriptedWord(): Token | null;
    /**
     * The word after `=~`, as bash's reader reads a regular expression: up to a
     * blank or an operator, except that its parentheses nest and, inside them,
     * blanks, newlines, `#` and operators are its own, and `|` is its own
     * anywhere. A `)` outside them ends it, for the conditional to read. Inside
     * them, it goes on past the end of an alias's text into the text the alias
     * was read in, with a blank between unless the alias's text ended in one or
     * in an operator's character (bash's reader gives that blank). Null when no
     * word begins here (a comment, a newline, an operator); `unclosed` when the
     * input ends inside its parentheses.
     */
    readRegexWord(): {
        token: Token;
        unclosed: boolean;
    } | null;
}
export type ContinuationState = 'single' | 'double' | 'backslash';
/**
 * How `input` leaves the lexer at end of input: inside an unclosed single or
 * double quote, or ending in a `\` line continuation (which bash also honors
 * inside double quotes, where `\<newline>` is removed). The interactive shell
 * uses this to keep reading (PS2) instead of executing a truncated command.
 * Comments are skipped exactly where lex() treats `#` as one.
 */
export declare function continuationState(input: string): ContinuationState | null;
type HeredocDelimiter = {
    delimiter: string;
    quoted: boolean;
    stripTabs: boolean;
};
/** Whether `line` ends a here-document opened with `delimiter` (`stripTabs`: by `<<-`, whose lines lose their leading tabs). */
export declare function endsHeredoc(line: string, heredoc: {
    readonly delimiter: string;
    readonly stripTabs: boolean;
}): boolean;
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
/**
 * The body of a balanced `open`...`close` span whose body starts at `pos`
 * (just past `open`), and where it ends (just past `close`, or the input's
 * end when it never closes). Quotes and nested `$(...)` inside it are
 * skipped whole, so a `close` inside them does not end it. In a command's
 * span, a here-document's body is too: read at the newline after its `<<`,
 * as the shell's reader reads it, so its `'` or `)` is text. An arithmetic
 * span, `$((…))` (its body at the second `(`), has no here-document: `<<` shifts.
 */
export declare function readBalancedCommand(input: string, pos: number, open: '(' | '{', close: ')' | '}'): {
    body: string;
    end: number;
    closed: boolean;
};
/** The `$'...'` at `pos`: its text, escapes decoded (backslash-escapes.ts, `ansi-c`), and where it ends. */
export declare function readAnsiCQuote(input: string, pos: number): {
    text: string;
    end: number;
};
export {};
//# sourceMappingURL=lexer.d.ts.map