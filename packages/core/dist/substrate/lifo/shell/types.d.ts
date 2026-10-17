export declare enum TokenKind {
    Word = 0,
    Pipe = 1,// |
    And = 2,// &&
    Or = 3,// ||
    Semi = 4,// ;
    Amp = 5,// &
    RedirectOut = 6,// >
    RedirectAppend = 7,// >>
    RedirectIn = 8,// <
    RedirectReadWrite = 9,// <>
    Heredoc = 10,// <<
    HeredocStripTabs = 11,// <<-
    HeredocBody = 12,
    RedirectErr = 13,// 2>
    RedirectErrAppend = 14,// 2>>
    RedirectAll = 15,// &>
    DoubleSemi = 16,// ;;
    LParen = 17,// (
    RParen = 18,// )
    Newline = 19,// \n
    EOF = 20
}
export interface WordPart {
    text: string;
    quoted: 'none' | 'single' | 'double';
    commandSubstitution?: string;
}
export interface Token {
    kind: TokenKind;
    value: string;
    pos: number;
    fd?: number;
    heredocQuoted?: boolean;
    heredocTerminated?: boolean;
    parts?: WordPart[];
}
export interface ScriptNode {
    type: 'script';
    lists: ListNode[];
}
export interface ListNode {
    type: 'list';
    entries: Array<{
        pipeline: PipelineNode;
        connector: '&&' | '||' | null;
    }>;
    background: boolean;
    /**
     * A script's list a newline (or the end) follows: the last of the lines
     * bash reads and runs as one (a discard skips to it). Set at the top level.
     */
    endsLine?: boolean;
}
export interface PipelineNode {
    type: 'pipeline';
    commands: CompoundCommandNode[];
    negated: boolean;
}
export interface AssignmentNode {
    name: string;
    /** The scalar right-hand side. Empty when `elements` carries the value. */
    value: WordPart[];
    /** `name=(word …)` — each element is one word, expanded like an argument. */
    elements?: WordPart[][];
    /** `name[expr]=` — raw subscript text, expanded and evaluated at run time. */
    subscript?: string;
    /** `name+=` — append to the scalar, or to the end of the array. */
    append?: boolean;
}
export interface SimpleCommandNode {
    type: 'simple_command';
    assignments: AssignmentNode[];
    words: WordPart[][];
    redirections: RedirectionNode[];
    /**
     * The aliases whose replacement text this command was read from: none of
     * them is expanded again as its command word (bash's rule, a read-time
     * one: a function defined there keeps it; a later parse, a command
     * substitution's or a sourced file's, starts afresh).
     */
    aliasesExpanding?: ReadonlySet<string>;
}
export interface RedirectionNode {
    operator: 'write' | 'append' | 'read' | 'readWrite' | 'writeAll' | 'dupOutput' | 'dupInput' | 'heredoc';
    fd: number | null;
    target: WordPart[];
    heredoc?: {
        body: string;
        quoted: boolean;
        stripTabs: boolean;
    };
}
export interface IfNode {
    type: 'if';
    clauses: Array<{
        condition: ListNode[];
        body: ListNode[];
    }>;
    elseBody: ListNode[] | null;
    redirections: RedirectionNode[];
}
export interface ForNode {
    type: 'for';
    variable: string;
    words: WordPart[][] | null;
    body: ListNode[];
    redirections: RedirectionNode[];
}
/** `while` runs its body while the condition succeeds, `until` while it fails. */
export interface LoopNode {
    type: 'while' | 'until';
    condition: ListNode[];
    body: ListNode[];
    redirections: RedirectionNode[];
}
export type WhileNode = LoopNode & {
    type: 'while';
};
export type UntilNode = LoopNode & {
    type: 'until';
};
export interface CaseNode {
    type: 'case';
    word: WordPart[];
    items: Array<{
        patterns: WordPart[][];
        body: ListNode[];
    }>;
    redirections: RedirectionNode[];
}
export interface FunctionDefNode {
    type: 'function_def';
    name: string;
    body: CompoundCommandNode;
}
export interface GroupNode {
    type: 'group';
    body: ListNode[];
    redirections: RedirectionNode[];
}
export interface SubshellNode {
    type: 'subshell';
    body: ListNode[];
    redirections: RedirectionNode[];
}
export interface DoubleBracketNode {
    type: 'double_bracket';
    words: WordPart[][];
    redirections: RedirectionNode[];
}
export type CompoundCommandNode = SimpleCommandNode | DoubleBracketNode | IfNode | ForNode | LoopNode | CaseNode | GroupNode | SubshellNode | FunctionDefNode;
export type ASTNode = ScriptNode | ListNode | PipelineNode | CompoundCommandNode;
//# sourceMappingURL=types.d.ts.map